import { expect, test } from 'vitest';
import { CashGame, deriveSeed } from '@poker/engine';
import { baselinePlayingStrategy, defaultConfiguration, defaultPlayingStrategy, defaultTrainerConfiguration, type ObservableGameView } from '@poker/contracts';
import { createStrategy, isSupportedStrategy, SimpleHeuristicPolicy, validatePolicyResult } from '../src/index.js';

function preflop(holeCards: readonly string[]): ObservableGameView {
  const created = CashGame.create({ ...defaultConfiguration, seatCount: 2, maximumBuyIn: 2000, defaultBuyIn: 2000, seed: 'simple-heuristic' });
  if (!created.ok) throw new Error('Invalid fixture');
  created.game.seatParticipant('you', 1);
  created.game.seatParticipant('opponent', 2);
  created.game.startHand();
  const view = created.game.forParticipant('you').getView();
  return { ...view, state: { ...view.state, participants: view.state.participants.map(p => p.participantId === 'you' ? { ...p, holeCards } : p) } };
}

function evaluate(view: ObservableGameView) {
  return validatePolicyResult(new SimpleHeuristicPolicy().evaluate(view, { evaluationSeed: 'fixed' }), view).choices;
}

function postflop(holeCards: readonly string[], board: readonly string[] = ['Ks', '8h', '2c'], cost = 0): ObservableGameView {
  const view = preflop(holeCards);
  return { ...view, state: { ...view.state, board, street: board.length === 5 ? 'river' : board.length === 4 ? 'turn' : 'flop', amountToCall: cost,
    participants: view.state.participants.map(p => ({ ...p, wager: p.participantId === 'you' ? 0 : cost, stack: 1900 - (p.participantId === 'you' ? 0 : cost), contribution: 100 + (p.participantId === 'you' ? 0 : cost) })),
    legalActions: cost ? [{ type: 'fold' }, { type: 'call' }, { type: 'raise', minimum: cost * 2, maximum: 1900 }] : [{ type: 'fold' }, { type: 'check' }, { type: 'bet', minimum: 20, maximum: 1900 }],
  } };
}

test('postflop bets use half to two-thirds pot and stronger hands bet more often while misses usually check', () => {
  const strong = evaluate(postflop(['Kh', 'Ad']));
  const missed = evaluate(postflop(['Qh', '9d']));
  expect(strong.filter(c => c.action.type === 'bet').map(c => c.action)).toEqual([{ type: 'bet', betTo: 100 }, { type: 'bet', betTo: 133 }]);
  expect(strong.filter(c => c.action.type === 'bet').reduce((sum, c) => sum + c.probability, 0)).toBeGreaterThan(.5);
  expect(missed.find(c => c.action.type === 'check')!.probability).toBeGreaterThan(.8);
  expect(missed.some(c => c.action.type === 'bet')).toBe(true);
  expect([...strong, ...missed].some(c => c.action.type === 'fold')).toBe(false);
});

test('Simple Heuristic opens premium hands for three big blinds and usually folds rubbish rather than shoving', () => {
  const premium = evaluate(preflop(['As', 'Ah']));
  const weak = evaluate(preflop(['7s', '2h']));
  expect(premium).toContainEqual({ action: { type: 'raise', raiseTo: 60 }, probability: expect.any(Number) });
  expect(premium.find(c => c.action.type === 'raise')!.probability).toBeGreaterThan(.5);
  expect(weak.find(c => c.action.type === 'fold')!.probability).toBeGreaterThan(.5);
  for (const choice of [...premium, ...weak]) if (choice.action.type === 'raise') expect(choice.action.raiseTo).toBeLessThan(2000);
});

test('short stacks can shove strong hands, while deep stacks do not routinely shove the same holding', () => {
  const deep = preflop(['Ts', 'Th']);
  const short = { ...deep, state: { ...deep.state,
    participants: deep.state.participants.map(p => p.participantId === 'you' ? { ...p, stack: 170 } : p),
    legalActions: [{ type: 'fold' as const }, { type: 'call' as const }, { type: 'raise' as const, minimum: 40, maximum: 180 }],
  } };
  expect(evaluate(short).some(c => c.action.type === 'raise' && c.action.raiseTo === 180)).toBe(true);
  expect(evaluate(deep).some(c => c.action.type === 'raise' && c.action.raiseTo === 2000)).toBe(false);
});

test('obvious draws continue against modest bets but disappear on the river', () => {
  const board = ['Jh', '2h', '7s'];
  const drawing = evaluate(postflop(['Th', '9h'], board, 60));
  const missed = evaluate(postflop(['Ac', 'Qd'], board, 60));
  const river = evaluate(postflop(['Th', '9h'], [...board, '4c', 'Ks'], 60));
  expect(drawing.find(c => c.action.type === 'call')!.probability).toBeGreaterThan(.5);
  expect(missed.find(c => c.action.type === 'fold')!.probability).toBeGreaterThan(.8);
  expect(river.find(c => c.action.type === 'fold')!.probability).toBeGreaterThan(.8);
});

test.each([
  { hole: ['Kh', 'Ad'], board: ['Ks', '8h', '2c'], description: 'top pair' },
  { hole: ['2c', '3d'], board: ['Ts', 'Jh', 'Qd', 'Kc', 'As'], description: 'a straight on the board' },
  { hole: ['Ah', 'Qs'], board: ['Kh', 'Kd', '8c', '8d', '2s'], description: 'two pairs on the board' },
])('large commitments are declined with $description', ({ hole, board }) => {
  expect(evaluate(postflop(hole, board, 1900))).toEqual([{ action: { type: 'fold' }, probability: 1 }]);
});

test('new defaults select Simple Heuristic for play and reference without changing Uniform Choice', async () => {
  expect(defaultPlayingStrategy.policy).toEqual({ id: 'simple-heuristic', version: 'v1', configuration: {} });
  expect(defaultTrainerConfiguration).toEqual({ referenceStrategy: defaultPlayingStrategy, liveAnalysis: false });
  expect(isSupportedStrategy(defaultPlayingStrategy)).toBe(true);
  expect(createStrategy(defaultPlayingStrategy).policy).toBeInstanceOf(SimpleHeuristicPolicy);
  const view = preflop(['As', 'Ah']);
  expect(validatePolicyResult(await createStrategy(baselinePlayingStrategy).policy.evaluate(view, { evaluationSeed: 'fixed' }), view).choices).toContainEqual({ action: { type: 'raise', raiseTo: 2000 }, probability: .25 });
});

test('clamped short all-in sizes remain unique and weak hands check instead of accidentally shoving', () => {
  function short(hole: readonly string[]) {
    const view = postflop(hole);
    return { ...view, state: { ...view.state, participants: view.state.participants.map(p => p.participantId === 'you' ? { ...p, stack: 27 } : p), legalActions: [{ type: 'fold' as const }, { type: 'check' as const }, { type: 'bet' as const, minimum: 20, maximum: 27 }] } };
  }
  const premium = evaluate(short(['8s', '8d']));
  expect(premium.filter(c => c.action.type === 'bet')).toEqual([{ action: { type: 'bet', betTo: 27 }, probability: .85 }]);
  expect(evaluate(short(['Qh', '9d']))).toEqual([{ action: { type: 'check' }, probability: 1 }]);
});

test.each([2, 6, 9])('Simple Heuristic plays complete legal hands with both selectors at a %i-seat table', async seats => {
  for (const selector of ['seeded-sampling', 'highest-probability']) {
    const participants = Array.from({ length: seats }, (_, i) => `player-${i}`);
    const strategy = createStrategy({ ...defaultPlayingStrategy, selector: { id: selector, version: 'v1', configuration: {} } });
    let boards = 0;
    for (let hand = 0; hand < 3; hand++) {
      const created = CashGame.create({ ...defaultConfiguration, seatCount: seats, seed: `heuristic-${seats}-${selector}-${hand}` });
      if (!created.ok) throw new Error('Invalid fixture');
      const game = created.game;
      for (const [i, id] of participants.entries()) expect(game.seatParticipant(id, i + 1).ok).toBe(true);
      expect(game.startHand().ok).toBe(true);
      let actions = 0;
      let state = game.forParticipant(participants[0]!).getView().state;
      while (state.status === 'active-hand') {
        const actor = state.actorId!;
        const view = game.forParticipant(actor).getView();
        const before = structuredClone(view);
        expect(await strategy.policy.checkCompatibility(view)).toEqual({ compatible: true });
        const result = validatePolicyResult(await strategy.policy.evaluate(view, { evaluationSeed: 'fixed' }), view);
        expect(await strategy.policy.evaluate(view, { evaluationSeed: 'different' })).toEqual(await strategy.policy.evaluate(view, { evaluationSeed: 'fixed' }));
        if (view.state.legalActions.some(a => a.type === 'check')) expect(result.choices.some(c => c.action.type === 'fold')).toBe(false);
        const action = strategy.actionSelector.select(result.choices, { selectionSeed: deriveSeed('simple-heuristic', 'selector', selector, seats, hand, actions) });
        expect(game.act(actor, action).ok).toBe(true);
        expect(view).toEqual(before);
        expect(++actions).toBeLessThan(200);
        state = game.forParticipant(participants[0]!).getView().state;
      }
      if (state.board.length) boards++;
    }
    expect(boards).toBeGreaterThan(0);
  }
});
