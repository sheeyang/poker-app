import type { ConcreteAction, ObservableGameView } from '@poker/contracts';
import { compareHandRanks, rankHand } from '@poker/engine';
import type { CompatibilityResult, EvaluationOptions, Policy, PolicyResult } from './index.js';

type Strength = 'weak' | 'medium' | 'strong' | 'premium';
const rank = (card: string) => '23456789TJQKA'.indexOf(card[0]!) + 2;

function preflopStrength(cards: readonly string[]): Strength {
  const high = Math.max(...cards.map(rank)), low = Math.min(...cards.map(rank));
  const suited = cards[0]![1] === cards[1]![1];
  if (high === low) return high >= 11 ? 'premium' : high >= 7 ? 'strong' : 'medium';
  if (high === 14 && low === 13) return 'premium';
  if (high >= 13 && low >= 11) return 'strong';
  if (high === 14 || low >= 10 || suited && (high >= 10 || high - low <= 3) || high - low === 1 && low >= 5) return 'medium';
  return 'weak';
}

function postflopStrength(hole: readonly string[], board: readonly string[]): Strength {
  const made = rankHand([...hole, ...board]);
  if (board.length === 5 && compareHandRanks(made, rankHand(board)) === 0) return 'weak';
  const boardRanks = board.map(rank), allRanks = [...hole, ...board].map(rank);
  const boardCount = (value: number) => boardRanks.filter(r => r === value).length;
  const privatePairs = [...new Set(hole.map(rank))].filter(value => boardCount(value) < 2 && allRanks.filter(r => r === value).length >= 2);
  switch (made.category) {
    case 'straight-flush': case 'full-house': case 'straight': case 'flush': return 'premium';
    case 'four-of-a-kind': return boardCount(made.kickers[0]!) < 4 ? 'premium' : 'weak';
    case 'three-of-a-kind': return boardCount(made.kickers[0]!) < 3 ? 'premium' : 'weak';
    case 'two-pair': return privatePairs.length >= 2 ? 'strong' : privatePairs.length ? 'medium' : 'weak';
    case 'one-pair': return privatePairs.length ? privatePairs[0]! >= Math.max(...boardRanks) ? 'strong' : 'medium' : 'weak';
    default: return 'weak';
  }
}

function hasDraw(hole: readonly string[], board: readonly string[]): boolean {
  if (board.length >= 5) return false;
  const cards = [...hole, ...board];
  if (hole.some(card => cards.filter(c => c[1] === card[1]).length === 4 && board.filter(c => c[1] === card[1]).length < 4)) return true;
  const ranks = new Set(cards.map(rank)), boardRanks = new Set(board.map(rank));
  if (ranks.has(14)) ranks.add(1);
  if (boardRanks.has(14)) boardRanks.add(1);
  for (let low = 1; low <= 10; low++) {
    const run = Array.from({ length: 5 }, (_, i) => low + i);
    if (run.filter(r => ranks.has(r)).length === 4 && run.some(r => ranks.has(r) && !boardRanks.has(r))) return true;
  }
  return false;
}

/** Fixed v1 casual rules; randomness belongs to the configured Action Selector. */
export class SimpleHeuristicPolicy implements Policy {
  checkCompatibility(view: ObservableGameView): CompatibilityResult {
    const actor = view.state.participants.find(p => p.participantId === view.state.actorId);
    return view.state.legalActions.length && actor?.holeCards?.length === 2 && [0, 3, 4, 5].includes(view.state.board.length)
      ? { compatible: true }
      : { compatible: false, reasons: [{ code: 'no-decision', message: 'A current Hold’em decision with visible hole cards is required.' }] };
  }

  evaluate(view: ObservableGameView, _options: EvaluationOptions): PolicyResult {
    if (!this.checkCompatibility(view).compatible) throw new Error('A compatible Hold’em decision is required.');
    const { state, configuration } = view;
    const actor = state.participants.find(p => p.participantId === state.actorId)!;
    const preflop = state.board.length === 0;
    const strength = preflop ? preflopStrength(actor.holeCards!) : postflopStrength(actor.holeCards!, state.board);
    const draw = !preflop && hasDraw(actor.holeCards!, state.board);
    const wager = actor.wager ?? 0, cost = state.amountToCall ?? 0;
    // Contributions include current wagers, antes, dead money and unmatched bets.
    const pot = Math.max(configuration.bigBlind, state.participants.reduce((sum, p) => sum + (p.contribution ?? 0), 0));
    const short = actor.stack + wager <= configuration.bigBlind * 10;
    const mayCommit = strength === 'premium' || short && strength === 'strong';
    const expensive = cost > pot * .75 || cost > actor.stack * .35;
    const safeCall = cost < actor.stack * .5 || mayCommit;
    let aggression = strength === 'premium' ? .75 : strength === 'strong' ? expensive ? .1 : .4 : strength === 'medium' ? expensive ? 0 : .12 : expensive ? 0 : .03;
    let call = strength === 'premium' ? .25 : strength === 'strong' ? .5 : strength === 'medium' ? expensive ? .15 : .7 : expensive ? 0 : .12;
    if (!preflop && strength === 'weak') { aggression = expensive ? 0 : draw ? .1 : .02; call = expensive ? 0 : draw ? .65 : cost <= pot * .25 ? .04 : 0; }
    if (cost === 0) aggression = strength === 'premium' ? .85 : strength === 'strong' ? .65 : strength === 'medium' ? .3 : draw ? .22 : .06;
    const sized = state.legalActions.find(a => a.type === 'bet' || a.type === 'raise');
    const aggressive: ConcreteAction[] = [];
    let shove: ConcreteAction | undefined;
    if (sized && (sized.type === 'bet' || sized.type === 'raise')) {
      const price = Math.max(...state.participants.map(p => p.wager ?? 0));
      const targets = preflop ? [price <= configuration.bigBlind ? configuration.bigBlind * 3 : price * 3]
        : [.5, 2 / 3].map(fraction => sized.type === 'bet' ? wager + pot * fraction : price + (pot + cost) * fraction);
      const amounts = [...new Set(targets.map(target => Math.max(sized.minimum, Math.min(sized.maximum, Math.round(target)))))];
      for (const amount of amounts) if (amount - wager < actor.stack * .5 || mayCommit) aggressive.push(sized.type === 'bet' ? { type: 'bet', betTo: amount } : { type: 'raise', raiseTo: amount });
      if (mayCommit && (short || actor.stack <= (pot + cost) * 2) && !amounts.includes(sized.maximum))
        shove = sized.type === 'bet' ? { type: 'bet', betTo: sized.maximum } : { type: 'raise', raiseTo: sized.maximum };
    }
    if (!aggressive.length) { if (strength === 'premium' || strength === 'strong') call += aggression; aggression = 0; }
    if (!safeCall || !state.legalActions.some(a => a.type === 'call')) call = 0;
    const choices: { action: ConcreteAction; probability: number }[] = [];
    if (state.legalActions.some(a => a.type === 'check')) choices.push({ action: { type: 'check' }, probability: 1 - aggression });
    else {
      choices.push({ action: { type: 'fold' }, probability: 1 - call - aggression });
      if (call > 0) choices.push({ action: { type: 'call' }, probability: call });
    }
    for (const action of aggressive) choices.push({ action, probability: aggression * (shove ? .85 : 1) / aggressive.length });
    if (shove) choices.push({ action: shove, probability: aggression * .15 });
    return { choices: choices.filter(c => c.probability > 0) };
  }
}
