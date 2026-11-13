import { dealingOrder, type DealInputs, type HandId, type ParticipantId, type PayoutInputs, type ShowdownInputs, type StreetInputs } from '@poker/contracts';
import type { CashGame, CashGameEvent } from '@poker/engine';
import type { PhaseInputsReader } from './schedule.js';

/**
 * What each Presentation Phase of an accepted transition presents (ADR-0039), read from the table before and after it
 * and the transition's events. Only what the view already makes public goes in: never a hole card.
 */
export function phaseInputsReader(before: CashGame, after: CashGame, events: readonly CashGameEvent[]): PhaseInputsReader {
  return {
    deal: handId => dealInputs(after, events, handId),
    street: (handId, street) => {
      const dealt = events.find(event => event.type === 'board-dealt' && event.handId === handId && event.street === street);
      return { swept: sweeps(events, dealt) ? swept(before, handId) : [], cardCount: dealt?.type === 'board-dealt' ? dealt.cards.length : 0 } satisfies StreetInputs;
    },
    showdown: handId => ({
      swept: sweeps(events, events.find(event => event.type === 'hole-cards-revealed' && event.handId === handId)) ? swept(before, handId) : [],
      shown: events.flatMap(event => event.type === 'hole-cards-revealed' && event.handId === handId ? [{ participantId: event.participantId, cardCount: event.cards.length }] : []),
    }) satisfies ShowdownInputs,
    payout: handId => payoutInputs(after, handId),
  };
}

/**
 * Whether the phase that `event` begins sweeps the line: the first street reveal or showdown of the transition does. In
 * an all-in runout the showdown comes first, so the streets after it sweep nothing.
 */
function sweeps(events: readonly CashGameEvent[], event: CashGameEvent | undefined): boolean {
  return !!event && events.find(e => e.type === 'board-dealt' || e.type === 'hole-cards-revealed') === event;
}

/** Whose wagers were on the line before the transition, in seat order: the transition that ends the betting round sweeps them. */
function swept(before: CashGame, handId: HandId): ParticipantId[] {
  return (before.getHand(handId)?.participants ?? []).filter(p => p.wager > 0).map(p => p.participantId);
}

/**
 * The deal of `handId`: who is dealt in, in the order the engine deals (`dealingOrder`), how many cards each, the blinds in the order they went in, and who was refilled with it.
 */
function dealInputs(game: CashGame, events: readonly CashGameEvent[], handId: HandId): DealInputs {
  const hand = game.getHand(handId);
  if (!hand) throw new Error('A dealt Hand has no facts.');
  const cards = new Map(events.flatMap(event => event.type === 'hole-cards-dealt' && event.handId === handId ? [[event.participantId, event.cardCount] as const] : []));
  const order = dealingOrder(hand.participants, hand.buttonSeat);
  const blinds = events.flatMap(event => event.type === 'forced-contribution' && event.handId === handId && event.kind !== 'ante' ? [event.participantId] : []);
  return { dealt: order.map(p => ({ participantId: p.participantId, cardCount: cards.get(p.participantId) ?? p.holeCards.length })), blinds, refills: refills(events, order.map(p => p.participantId)) };
}

/**
 * The dealt Participants refilled with the deal, in dealing order: those Rebuy & deal rebought from no chips in the
 * transition that deals. A rebuy made on its own between Hands has landed before the deal, so it is no refill.
 */
function refills(events: readonly CashGameEvent[], dealt: readonly ParticipantId[]): DealInputs['refills'] {
  const rebought = new Map(events.flatMap(event => event.type === 'participant-topped-up' ? [[event.participantId, event.amount] as const] : []));
  return dealt.flatMap(participantId => rebought.has(participantId) ? [{ participantId, amount: rebought.get(participantId)! }] : []);
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
