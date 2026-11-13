import { describe, expect, it } from 'vitest';
import { dealBeats, payoutBeats, presentationPhaseLength, type DealInputs, type PayoutInputs } from '../src/index.js';

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

/** A payout of 500 to each of `winners`, in seat order. */
const payout = (...winners: string[]): PayoutInputs => ({ awards: winners.map(participantId => ({ participantId, won: 500, returned: 0 })) });

describe('the payout’s beats', () => {
  it('lands each award on its stack after its push from the pot starts', () => {
    for (const award of payoutBeats(payout('p1', 'p2', 'p3')).awards) expect(award.endsAt).toBeGreaterThan(award.startsAt);
  });

  it('lands the awards in turn, in seat order, far enough apart to see each', () => {
    const { awards } = payoutBeats(payout('p1', 'p2', 'p3'));
    expect(awards.map(a => a.participantId)).toEqual(['p1', 'p2', 'p3']);
    awards.slice(1).forEach((award, i) => { expect(award.endsAt - awards[i]!.endsAt).toBeGreaterThanOrEqual(250); });
  });

  it('pushes what each Participant won and what came back to them uncalled', () => {
    const { awards } = payoutBeats({ awards: [{ participantId: 'p1', won: 300, returned: 0 }, { participantId: 'p2', won: 0, returned: 40 }, { participantId: 'p3', won: 300, returned: 120 }] });
    expect(awards.map(a => [a.participantId, a.amount])).toEqual([['p1', 300], ['p2', 40], ['p3', 420]]);
  });

  it('ends no beat after the total', () => {
    for (const inputs of [payout('p1'), payout('p1', 'p2'), payout('p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8', 'p9')]) {
      const beats = payoutBeats(inputs);
      const ends = [beats.pot.endsAt, ...beats.awards.flatMap(a => [a.endsAt, a.fade.endsAt, a.caption.endsAt])];
      expect(Math.max(...ends)).toBe(beats.totalMs);
    }
  });

  it('takes longer with more awards', () => {
    expect(payoutBeats(payout('p1', 'p2')).totalMs).toBeGreaterThan(payoutBeats(payout('p1')).totalMs);
    expect(payoutBeats(payout('p1', 'p2', 'p3')).totalMs).toBeGreaterThan(payoutBeats(payout('p1', 'p2')).totalMs);
  });

  it('fits every beat to a phase of another length, keeping their order', () => {
    const natural = payoutBeats(payout('p1', 'p2')), fitted = payoutBeats(payout('p1', 'p2'), natural.totalMs * 2);
    expect(fitted.totalMs).toBe(natural.totalMs * 2);
    fitted.awards.forEach((award, i) => { expect(award.endsAt).toBeCloseTo(natural.awards[i]!.endsAt * 2, 0); });
  });

  it('is the payout phase’s length', () => {
    expect(presentationPhaseLength({ kind: 'payout', inputs: payout('p1', 'p2') })).toBe(payoutBeats(payout('p1', 'p2')).totalMs);
  });
});
