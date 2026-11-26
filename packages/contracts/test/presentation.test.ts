import { describe, expect, it } from 'vitest';
import { dealBeats, payoutBeats, presentationPhaseLength, presentingPhase, readPhaseInputs, returnBeat, showdownBeats, streetBeats, type DealInputs, type PayoutInputs, type ShowdownBeats, type StreetBeats, type SweepBeats } from '../src/index.js';

/** `participants` dealt in clockwise, two cards each, the first two posting the blinds. */
const deal = (participants: number, refills: DealInputs['refills'] = []): DealInputs => {
  const ids = Array.from({ length: participants }, (_, i) => `p${i + 1}`);
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

  it('returns however many of the last Hand’s cards a Trainer shows within the total, closer together the more there are', () => {
    for (const beats of [dealBeats(deal(2)), dealBeats(deal(9)), dealBeats(deal(2), dealBeats(deal(2)).totalMs / 3)]) {
      for (const count of [1, 4, 23, 80]) {
        const first = returnBeat(beats.cardsReturn, 0, count), last = returnBeat(beats.cardsReturn, count - 1, count);
        expect(first.startsAt).toBe(beats.cardsReturn.startsAt);
        expect(last.startsAt).toBeGreaterThanOrEqual(first.startsAt);
        expect(last.endsAt).toBeLessThanOrEqual(beats.totalMs);
      }
    }
    const gap = (count: number) => { const { cardsReturn } = dealBeats(deal(2)); return returnBeat(cardsReturn, 1, count).startsAt - returnBeat(cardsReturn, 0, count).startsAt; };
    expect(gap(4)).toBeGreaterThan(0);
    expect(gap(40)).toBeLessThan(gap(4));
  });

  it('takes longer with more cards dealt, and with a refill', () => {
    expect(dealBeats(deal(6)).totalMs).toBeGreaterThan(dealBeats(deal(2)).totalMs);
    expect(dealBeats(deal(9)).totalMs).toBeGreaterThan(dealBeats(deal(6)).totalMs);
    expect(dealBeats(deal(2, [{ participantId: 'p2', amount: 500 }])).totalMs).toBeGreaterThan(dealBeats(deal(2)).totalMs);
  });

  it('brings cards closer together as more are dealt', () => {
    const gap = (participants: number) => { const { cards } = dealBeats(deal(participants)); return cards[1]!.startsAt - cards[0]!.startsAt; };
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
});

const swept = (count: number) => Array.from({ length: count }, (_, i) => `p${i + 1}`);
const shown = (count: number) => Array.from({ length: count }, (_, i) => ({ participantId: `p${i + 1}`, cardCount: 2 }));
/** Where every beat of a street reveal ends. */
const streetEnds = (beats: StreetBeats) => [beats.burn.endsAt, ...sweepEnds(beats.sweep), ...beats.cards.flatMap(c => [c.endsAt, c.turn.endsAt, ...(c.spread ? [c.spread.endsAt] : [])])];
/** Where every beat of a showdown ends. */
const showdownEnds = (beats: ShowdownBeats) => [...sweepEnds(beats.sweep), ...beats.hands.flatMap(h => h.cards.map(c => c.turn.endsAt))];
/** Where every beat of a sweep ends. */
const sweepEnds = (sweep: SweepBeats) => [...sweep.wagers.flatMap(w => [w.endsAt, w.amountFades.endsAt]), ...(sweep.pot ? [sweep.pot.endsAt] : [])];

describe('a street reveal’s beats', () => {
  it('starts the burn only once the last swept chip has reached the pot', () => {
    for (const count of [0, 1, 2, 6]) {
      const beats = streetBeats({ swept: swept(count), cardCount: 3 });
      expect(beats.sweep.wagers).toHaveLength(count);
      for (const wager of beats.sweep.wagers) expect(beats.burn.startsAt).toBeGreaterThanOrEqual(wager.endsAt);
      expect(beats.burn.endsAt).toBeGreaterThan(beats.burn.startsAt);
    }
  });

  it('sweeps the wagers one after another', () => {
    const { wagers } = streetBeats({ swept: swept(3), cardCount: 1 }).sweep;
    expect(wagers.map(w => w.participantId)).toEqual(['p1', 'p2', 'p3']);
    wagers.slice(1).forEach((wager, i) => { expect(wager.startsAt).toBeGreaterThan(wagers[i]!.startsAt); });
  });

  it('deals the flop after the burn as one stack that lands, then spreads and turns its cards one by one', () => {
    const beats = streetBeats({ swept: [], cardCount: 3 });
    expect(beats.cards.map(c => c.card)).toEqual([0, 1, 2]);
    for (const card of beats.cards) {
      expect(card.startsAt).toBeGreaterThanOrEqual(beats.burn.startsAt);
      expect(card.startsAt).toBe(beats.cards[0]!.startsAt);
      expect(card.endsAt).toBeGreaterThan(card.startsAt);
      expect(card.spread!.startsAt).toBeGreaterThanOrEqual(card.endsAt);
      expect(card.turn.startsAt).toBeGreaterThanOrEqual(card.endsAt);
    }
    beats.cards.slice(1).forEach((card, i) => { expect(card.turn.startsAt).toBeGreaterThan(beats.cards[i]!.turn.startsAt); });
  });

  it('deals the turn or the river as one card that lands, then turns', () => {
    const { cards, burn } = streetBeats({ swept: swept(2), cardCount: 1 });
    expect(cards).toHaveLength(1);
    const [card] = cards;
    expect(card!.spread).toBeUndefined();
    expect(card!.startsAt).toBeGreaterThanOrEqual(burn.startsAt);
    expect(card!.endsAt).toBeGreaterThan(card!.startsAt);
    expect(card!.turn.startsAt).toBeGreaterThanOrEqual(card!.endsAt);
  });

  it('ends no beat after the total', () => {
    for (const inputs of [{ swept: [], cardCount: 3 }, { swept: swept(2), cardCount: 3 }, { swept: swept(9), cardCount: 1 }]) {
      const beats = streetBeats(inputs);
      expect(Math.max(...streetEnds(beats))).toBe(beats.totalMs);
    }
  });

  it('takes longer with more wagers swept, and for the flop than for one card', () => {
    expect(streetBeats({ swept: swept(1), cardCount: 3 }).totalMs).toBeGreaterThan(streetBeats({ swept: [], cardCount: 3 }).totalMs);
    expect(streetBeats({ swept: swept(4), cardCount: 3 }).totalMs).toBeGreaterThan(streetBeats({ swept: swept(2), cardCount: 3 }).totalMs);
    expect(streetBeats({ swept: [], cardCount: 3 }).totalMs).toBeGreaterThan(streetBeats({ swept: [], cardCount: 1 }).totalMs);
  });

  it('plays at 1.5× the M5 street reveal: a flop with nothing swept took 920 ms', () => {
    expect(streetBeats({ swept: [], cardCount: 3 }).totalMs).toBe(1380);
  });

  it('fits every beat to a phase of another length', () => {
    const inputs = { swept: swept(2), cardCount: 3 }, natural = streetBeats(inputs), fitted = streetBeats(inputs, natural.totalMs * 2);
    expect(fitted.totalMs).toBe(natural.totalMs * 2);
    expect(fitted.burn.startsAt).toBeCloseTo(natural.burn.startsAt * 2);
    expect(Math.max(...streetEnds(fitted))).toBeCloseTo(natural.totalMs * 2);
  });
});

describe('a showdown’s beats', () => {
  it('turns the hands up only once the last swept chip has reached the pot', () => {
    const beats = showdownBeats({ swept: swept(3), shown: shown(2) });
    const lastLands = Math.max(...beats.sweep.wagers.map(w => w.endsAt));
    for (const hand of beats.hands) for (const card of hand.cards) expect(card.turn.startsAt).toBeGreaterThanOrEqual(lastLands);
  });

  it('turns each hand in the order shown, card by card', () => {
    const { hands } = showdownBeats({ swept: [], shown: shown(3) });
    expect(hands.map(h => h.participantId)).toEqual(['p1', 'p2', 'p3']);
    for (const hand of hands) {
      expect(hand.cards.map(c => c.card)).toEqual([0, 1]);
      expect(hand.cards[1]!.turn.startsAt).toBeGreaterThan(hand.cards[0]!.turn.startsAt);
    }
    hands.slice(1).forEach((hand, i) => { expect(hand.cards[0]!.turn.startsAt).toBeGreaterThan(hands[i]!.cards[0]!.turn.startsAt); });
  });

  it('ends no beat after the total', () => {
    for (const [sweeps, hands] of [[0, 2], [2, 2], [6, 6]] as const) {
      const beats = showdownBeats({ swept: swept(sweeps), shown: shown(hands) });
      expect(Math.max(...showdownEnds(beats))).toBe(beats.totalMs);
    }
  });

  it('takes longer with more wagers swept and more hands turned up', () => {
    expect(showdownBeats({ swept: swept(2), shown: shown(2) }).totalMs).toBeGreaterThan(showdownBeats({ swept: [], shown: shown(2) }).totalMs);
    expect(showdownBeats({ swept: [], shown: shown(3) }).totalMs).toBeGreaterThan(showdownBeats({ swept: [], shown: shown(2) }).totalMs);
  });

  it('fits every beat to a phase of another length', () => {
    const inputs = { swept: swept(2), shown: shown(2) }, natural = showdownBeats(inputs), fitted = showdownBeats(inputs, natural.totalMs / 2);
    expect(fitted.totalMs).toBe(natural.totalMs / 2);
    expect(Math.max(...showdownEnds(fitted))).toBeCloseTo(natural.totalMs / 2);
  });
});

describe('a phase’s length', () => {
  it.each([
    ['deal', presentingPhase('deal', deal(6, [{ participantId: 'p3', amount: 1000 }])), dealBeats(deal(6, [{ participantId: 'p3', amount: 1000 }])).totalMs],
    ['street reveal', presentingPhase('street', { swept: swept(2), cardCount: 3 }), streetBeats({ swept: swept(2), cardCount: 3 }).totalMs],
    ['showdown', presentingPhase('showdown', { swept: [], shown: shown(2) }), showdownBeats({ swept: [], shown: shown(2) }).totalMs],
    ['payout', presentingPhase('payout', payout('p1', 'p2')), payoutBeats(payout('p1', 'p2')).totalMs],
  ])('of a %s is the total of its beats for what it presents', (_, phase, total) => {
    expect(presentationPhaseLength(phase)).toBe(total);
  });
});

describe('reading Phase Inputs', () => {
  it('reads each kind field by field, leaving out anything else a phase carries', () => {
    const extra = { secret: 'As' };
    expect(readPhaseInputs('deal', { ...deal(2, [{ participantId: 'p1', amount: 500 }]), ...extra, dealt: [{ participantId: 'p1', cardCount: 2, ...extra }, { participantId: 'p2', cardCount: 2 }] })).toEqual(deal(2, [{ participantId: 'p1', amount: 500 }]));
    expect(readPhaseInputs('street', { swept: ['p1'], cardCount: 1, ...extra })).toEqual({ swept: ['p1'], cardCount: 1 });
    expect(readPhaseInputs('showdown', { swept: [], shown: shown(2), ...extra })).toEqual({ swept: [], shown: shown(2) });
    expect(readPhaseInputs('payout', { awards: [{ participantId: 'p1', won: 300, returned: 20, ...extra }] })).toEqual({ awards: [{ participantId: 'p1', won: 300, returned: 20 }] });
  });

  it('reads nothing from inputs of another shape, such as a server of another version sends', () => {
    for (const value of [undefined, null, [], 'deal', {}, { dealt: [], blinds: [] }, { ...deal(2), blinds: [1, 2] }, { ...deal(2), dealt: [{ participantId: 'p1' }] }]) expect(readPhaseInputs('deal', value)).toBeUndefined();
    for (const value of [undefined, { swept: [] }, { swept: 'p1', cardCount: 3 }, { swept: [], cardCount: -1 }, { swept: [], cardCount: 1.5 }]) expect(readPhaseInputs('street', value)).toBeUndefined();
    expect(readPhaseInputs('showdown', { swept: [], shown: [{ participantId: 'p1', cardCount: '2' }] })).toBeUndefined();
    expect(readPhaseInputs('payout', { awards: [{ participantId: 'p1', won: 300 }] })).toBeUndefined();
  });
});
