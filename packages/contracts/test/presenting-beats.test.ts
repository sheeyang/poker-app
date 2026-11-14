import { describe, expect, it } from 'vitest';
import { committedTimings, payoutBeatDescription, payoutBeats, showdownBeatDescription, showdownBeats, streetBeatDescription, streetBeats, sweepBeatDescription, type TimingPath } from '../src/index.js';

const ids = (n: number) => Array.from({ length: n }, (_, i) => `p${i + 1}`);
const named = (description: typeof streetBeatDescription) => (name: string) => description.find(b => b.beat === name)!;

describe('the sweep’s beat description', () => {
  const beat = named(sweepBeatDescription);

  it('names every sweep beat once, each with its formulas', () => {
    expect(sweepBeatDescription.map(b => b.beat)).toEqual(['sweepWager', 'sweepAmountFade', 'sweepPot']);
    expect(beat('sweepWager')).toMatchObject({ follows: 'the start of the phase', gap: 'motion.sweepAt + motion.sweepStagger × index', length: 'motion.sweepFlight' });
    expect(beat('sweepAmountFade')).toMatchObject({ follows: 'the start of its sweepWager', gap: '0', length: 'motion.sweepAmountFade' });
    expect(beat('sweepPot')).toMatchObject({ gap: 'motion.sweepAt + motion.potAfterSweep + motion.sweepStagger × swept', length: 'motion.potBrightens' });
  });

  it('lists exactly the timings in a beat’s own gap or length', () => {
    expect(beat('sweepWager').setBy).toEqual(['motion.sweepAt', 'motion.sweepStagger', 'motion.sweepFlight']);
    expect(beat('sweepAmountFade').setBy).toEqual(['motion.sweepAmountFade']);
    expect(beat('sweepPot').setBy).toEqual(['motion.sweepAt', 'motion.potAfterSweep', 'motion.sweepStagger', 'motion.potBrightens']);
  });
});

describe('the street reveal’s beat description', () => {
  const beat = named(streetBeatDescription);

  it('includes the sweep and gives the burn and board beats their anchors and formulas', () => {
    expect(streetBeatDescription.map(b => b.beat)).toEqual(expect.arrayContaining(['sweepWager', 'burn', 'burnAppears', 'flopCard', 'flopSpread', 'flopCardTurn', 'boardCard', 'boardCardTurn']));
    expect(beat('burn')).toMatchObject({ follows: 'the end of the last sweepWager, or street.burnEarliest if later', gap: '0', length: 'street.burnFlight' });
    expect(beat('flopCard')).toMatchObject({ follows: 'the start of the first burn', gap: 'street.boardAfterBurn', length: 'street.flopFlight' });
    expect(beat('flopCardTurn')).toMatchObject({ follows: 'the end of its flopCard', gap: 'street.flopTurnsAfterLanding + street.flopTurnStagger × index', length: 'street.flopTurn' });
    expect(beat('boardCardTurn')).toMatchObject({ gap: 'street.cardTurnsAfterLanding', length: 'street.cardTurn' });
  });

  it('lists exactly the timings that directly set a beat, the burn’s earliest included', () => {
    expect(beat('burn').setBy).toEqual(['street.burnEarliest', 'street.burnFlight']);
    expect(beat('burnAppears').setBy).toEqual(['street.appearsBefore']);
    expect(beat('flopCard').setBy).toEqual(['street.boardAfterBurn', 'street.flopFlight']);
    expect(beat('flopSpread').setBy).toEqual(['street.flopSpread']);
    expect(beat('boardCard').setBy).toEqual(['street.boardAfterBurn', 'street.cardFlight']);
  });
});

describe('the showdown’s beat description', () => {
  const beat = named(showdownBeatDescription);

  it('includes the sweep, then each card’s turn after the last swept chip lands', () => {
    expect(showdownBeatDescription.map(b => b.beat)).toEqual(['sweepWager', 'sweepAmountFade', 'sweepPot', 'cardTurn']);
    expect(beat('cardTurn')).toMatchObject({ follows: 'the end of the last sweepWager', gap: 'showdown.turnsAfterSweep + showdown.handStagger × hand + showdown.cardStagger × cardInHand', length: 'showdown.turn' });
    expect(beat('cardTurn').setBy).toEqual(['showdown.turnsAfterSweep', 'showdown.handStagger', 'showdown.cardStagger', 'showdown.turn']);
  });
});

describe('the payout’s beat description', () => {
  const beat = named(payoutBeatDescription);

  it('gives the pot, each award, its fade and its caption their anchors and formulas', () => {
    expect(payoutBeatDescription.map(b => b.beat)).toEqual(['pot', 'award', 'awardFade', 'awardCaption']);
    expect(beat('pot')).toMatchObject({ follows: 'the start of the phase', gap: 'payout.potAt', length: 'payout.potPulse' });
    expect(beat('award')).toMatchObject({ gap: 'payout.firstLands + payout.stagger × index + payout.push × -1', length: 'payout.push' });
    expect(beat('awardFade')).toMatchObject({ follows: 'the end of its award', gap: '0', length: 'payout.landFade' });
    expect(beat('awardCaption')).toMatchObject({ gap: 'payout.captionBeforeLanding × -1', length: 'payout.caption' });
    expect(beat('award').setBy).toEqual(['payout.firstLands', 'payout.stagger', 'payout.push']);
  });
});

describe('every street, showdown and payout timing', () => {
  it('directly sets some beat', () => {
    const listed = new Set<string>([...streetBeatDescription, ...showdownBeatDescription, ...payoutBeatDescription].flatMap(b => b.setBy));
    const paths = (['street', 'showdown', 'payout'] as const).flatMap(group => Object.keys(committedTimings[group]).map(k => `${group}.${k}`));
    expect(paths.filter(p => !listed.has(p))).toEqual([]);
    for (const p of ['motion.sweepAt', 'motion.sweepFlight', 'motion.sweepStagger', 'motion.sweepAmountFade', 'motion.potAfterSweep', 'motion.potBrightens'] as TimingPath[]) expect(listed.has(p)).toBe(true);
  });
});

describe('the rebuilt beats, with timings passed in', () => {
  const slower = { ...committedTimings, street: { ...committedTimings.street, flopFlight: committedTimings.street.flopFlight + 100 }, motion: { ...committedTimings.motion, sweepFlight: committedTimings.motion.sweepFlight + 100 } };

  it('change with the timings and stay ordered, none ending after the total', () => {
    const before = streetBeats({ swept: ids(3), cardCount: 3 }), after = streetBeats({ swept: ids(3), cardCount: 3 }, undefined, slower);
    expect(after.sweep.wagers[0]!.endsAt - before.sweep.wagers[0]!.endsAt).toBe(100);
    expect(after.cards[0]!.endsAt - after.cards[0]!.startsAt).toBe(committedTimings.street.flopFlight + 100);
    for (const b of [before, after]) {
      expect(b.burn.startsAt).toBeGreaterThanOrEqual(b.sweep.wagers.at(-1)!.endsAt);
      for (const c of b.cards) { expect(c.turn.startsAt).toBeGreaterThan(c.endsAt); expect(c.turn.endsAt).toBeLessThanOrEqual(b.totalMs); }
    }
  });

  it('keep the burn at its earliest time when nothing is swept, and follow the sweep once it lands later', () => {
    expect(streetBeats({ swept: [], cardCount: 1 }).burn.startsAt).toBe(committedTimings.street.burnEarliest);
    expect(streetBeats({ swept: ids(9), cardCount: 1 }).burn.startsAt).toBe(streetBeats({ swept: ids(9), cardCount: 1 }).sweep.wagers[8]!.endsAt);
  });

  it('place each showdown card by its hand and its place in the hand', () => {
    const b = showdownBeats({ swept: [], shown: [{ participantId: 'a', cardCount: 2 }, { participantId: 'b', cardCount: 2 }] });
    const { turnsAfterSweep, handStagger, cardStagger } = committedTimings.showdown;
    expect(b.hands[1]!.cards[1]!.turn.startsAt).toBe(turnsAfterSweep + handStagger + cardStagger);
  });

  it('place each award in turn', () => {
    const b = payoutBeats({ awards: [{ participantId: 'a', won: 10, returned: 0 }, { participantId: 'b', won: 10, returned: 5 }] });
    expect(b.awards[1]!.endsAt - b.awards[0]!.endsAt).toBe(committedTimings.payout.stagger);
    expect(b.awards[1]!.amount).toBe(15);
  });
});
