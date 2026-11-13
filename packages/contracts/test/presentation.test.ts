import { describe, expect, it } from 'vitest';
import { dealBeats, type DealInputs } from '../src/index.js';

/** `players` dealt in clockwise, two cards each, the first two posting the blinds. */
const deal = (players: number, refills: DealInputs['refills'] = []): DealInputs => {
  const ids = Array.from({ length: players }, (_, i) => `p${i + 1}`);
  return { dealt: ids.map(participantId => ({ participantId, cardCount: 2 })), blinds: ids.slice(0, 2), refills };
};

describe('the deal’s beats', () => {
  it('lands each card after it leaves the deck, and turns it face up only after it lands', () => {
    const { cards } = dealBeats(deal(6));
    expect(cards).toHaveLength(12);
    for (const card of cards) {
      expect(card.endsAt).toBeGreaterThan(card.startsAt);
      expect(card.turn.startsAt).toBeGreaterThanOrEqual(card.endsAt);
      expect(card.turn.endsAt).toBeGreaterThan(card.turn.startsAt);
    }
  });

  it('deals one card to each Participant in turn, in dealing order, then the second', () => {
    const { cards } = dealBeats(deal(3));
    expect(cards.map(c => `${c.participantId}/${c.card}`)).toEqual(['p1/0', 'p2/0', 'p3/0', 'p1/1', 'p2/1', 'p3/1']);
    cards.slice(1).forEach((card, i) => { expect(card.startsAt).toBeGreaterThan(cards[i]!.startsAt); });
  });

  it('lands a refill before the blinds go in, and the blinds before the first card leaves the deck', () => {
    const beats = dealBeats(deal(2, [{ participantId: 'p1', amount: 1000 }]));
    expect(beats.refills).toEqual([expect.objectContaining({ participantId: 'p1' })]);
    const firstBlind = Math.min(...beats.blinds.map(b => b.startsAt));
    expect(beats.refills[0]!.endsAt).toBeLessThanOrEqual(firstBlind);
    expect(firstBlind).toBeLessThanOrEqual(beats.cards[0]!.startsAt);
  });

  it('ends no beat after the total', () => {
    for (const inputs of [deal(2), deal(6), deal(9), deal(6, [{ participantId: 'p3', amount: 1000 }])]) {
      const beats = dealBeats(inputs);
      const ends = [beats.cardsReturn.endsAt, beats.buttonMoves.endsAt, ...beats.refills.map(b => b.endsAt), ...beats.blinds.map(b => b.endsAt), ...beats.cards.flatMap(c => [c.endsAt, c.turn.endsAt])];
      expect(Math.max(...ends)).toBe(beats.totalMs);
    }
  });

  it('takes longer with more cards dealt, and with a refill', () => {
    expect(dealBeats(deal(6)).totalMs).toBeGreaterThan(dealBeats(deal(2)).totalMs);
    expect(dealBeats(deal(9)).totalMs).toBeGreaterThan(dealBeats(deal(6)).totalMs);
    expect(dealBeats(deal(2, [{ participantId: 'p2', amount: 500 }])).totalMs).toBeGreaterThan(dealBeats(deal(2)).totalMs);
  });

  it('brings cards closer together as more are dealt', () => {
    const gap = (players: number) => { const { cards } = dealBeats(deal(players)); return cards[1]!.startsAt - cards[0]!.startsAt; };
    expect(gap(9)).toBeLessThan(gap(2));
  });

  it('fits every beat to a phase of another length, keeping their order', () => {
    const natural = dealBeats(deal(6)), fitted = dealBeats(deal(6), natural.totalMs / 2);
    expect(fitted.totalMs).toBe(natural.totalMs / 2);
    fitted.cards.forEach((card, i) => {
      expect(card.startsAt).toBeCloseTo(natural.cards[i]!.startsAt / 2, 0);
      expect(card.turn.endsAt).toBeCloseTo(natural.cards[i]!.turn.endsAt / 2, 0);
    });
    expect(dealBeats(deal(6), natural.totalMs)).toEqual(natural);
  });
});
