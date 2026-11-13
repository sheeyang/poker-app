import type { DealInputs, HandId, PayoutInputs } from '@poker/contracts';
import type { CashGame, CashGameEvent } from '@poker/engine';
import type { PhaseInputs } from './schedule.js';

/**
 * What each Presentation Phase of an accepted transition presents (ADR-0039), read from the table after it and the
 * transition's events. Only what the view already makes public goes in: never a hole card.
 */
export function phaseInputs(after: CashGame, events: readonly CashGameEvent[]): PhaseInputs {
  return { deal: handId => dealInputs(after, events, handId), payout: handId => payoutInputs(after, handId) };
}

/**
 * The deal of `handId`: who is dealt in, in the order the engine deals (clockwise from left of the button, or heads-up
 * the button first), how many cards each, the blinds in the order they went in, and who was refilled with it. A refill
 * is a rebuy: chips topped up between Hands for a Participant whose stack the previous Hand emptied.
 */
function dealInputs(game: CashGame, events: readonly CashGameEvent[], handId: HandId): DealInputs {
  const hand = game.getHand(handId);
  if (!hand) throw new Error('A dealt Hand has no facts.');
  const cards = new Map(events.flatMap(event => event.type === 'hole-cards-dealt' && event.handId === handId ? [[event.participantId, event.cardCount] as const] : []));
  const clockwise = [...hand.participants].sort((a, b) => (a.seat > hand.buttonSeat ? a.seat : a.seat + 1000) - (b.seat > hand.buttonSeat ? b.seat : b.seat + 1000));
  const order = hand.participants.length === 2 ? [...clockwise].reverse() : clockwise;
  const blinds = events.flatMap(event => event.type === 'forced-contribution' && event.handId === handId && event.kind !== 'ante' ? [event.participantId] : []);
  return { dealt: order.map(p => ({ participantId: p.participantId, cardCount: cards.get(p.participantId) ?? p.holeCards.length })), blinds, refills: refills(game, hand.sequence, order.map(p => p.participantId)) };
}

/** The dealt Participants the previous Hand left with no chips, and what they rebought to since it began. */
function refills(game: CashGame, sequence: number, dealt: readonly string[]): DealInputs['refills'] {
  const previous = game.getCompletedHands().find(h => h.sequence === sequence - 1), facts = previous && game.getHand(previous.handId);
  if (!facts) return [];
  const won = (id: string) => [...facts.payouts, ...facts.returns].some(t => t.participantId === id && t.amount > 0);
  const busted = new Set(facts.participants.filter(p => p.allIn && !won(p.participantId)).map(p => p.participantId));
  // Management is refused during a Hand, so every top-up since the previous Hand's start came after it ended.
  const commands = game.toRecord().commands, since = commands.findLastIndex((command, i) => command.type === 'start-hand' && i < commands.length - 1);
  const rebought = new Map<string, number>();
  for (const command of commands.slice(since + 1)) if (command.type === 'top-up-to') rebought.set(command.participantId, command.targetStack);
  return dealt.flatMap(participantId => busted.has(participantId) && rebought.has(participantId) ? [{ participantId, amount: rebought.get(participantId)! }] : []);
}

/**
 * The payout of `handId`: each Participant it pushes chips to, in seat order, with what they won from every pot and
 * what came back to them uncalled. Both are public in the view once the Hand is complete.
 */
function payoutInputs(game: CashGame, handId: HandId): PayoutInputs {
  const hand = game.getHand(handId);
  if (!hand) throw new Error('A paid-out Hand has no facts.');
  const sum = (transfers: readonly { readonly participantId: string; readonly amount: number }[], id: string) => transfers.reduce((total, t) => total + (t.participantId === id ? t.amount : 0), 0);
  return { awards: [...hand.participants].sort((a, b) => a.seat - b.seat).flatMap(({ participantId }) => {
    const won = sum(hand.payouts, participantId), returned = sum(hand.returns, participantId);
    return won + returned > 0 ? [{ participantId, won, returned }] : [];
  }) };
}
