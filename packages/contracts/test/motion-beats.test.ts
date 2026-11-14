import { describe, expect, it } from 'vitest';
import {
  betBeatDescription, betBeats, checkBeatDescription, checkBeats, chipsBeatDescription, chipsBeats, committedTimings, foldBeatDescription, foldBeats,
  moveBeatDescription, moveBeats, seatChangeBeatDescription, seatChangeBeats, sitBeatDescription, sitBeats, standBeatDescription, standBeats,
  statusBeatDescription, statusBeats, type BeatDescription, type Timings,
} from '../src/index.js';

const M = committedTimings.motion;
const slower: Timings = { ...committedTimings, motion: { ...M, muckStagger: 200, betFlight: 900, chipsFlight: 1000, sitArrivesAt: 500 } };
const beatOf = (list: readonly BeatDescription[], name: string) => list.find(b => b.beat === name)!;
const descriptions = [betBeatDescription, foldBeatDescription, checkBeatDescription, sitBeatDescription, standBeatDescription, moveBeatDescription, chipsBeatDescription, seatChangeBeatDescription, statusBeatDescription];

describe('a bet’s beats', () => {
  it('sends a chip to the betting line, its amount appearing before it lands, and the caption with it', () => {
    const b = betBeats(false);
    expect(b.chip).toEqual({ startsAt: 0, endsAt: M.betFlight });
    expect(b.amountAppears).toBe(M.betAmountAppears);
    expect(b.caption).toEqual({ startsAt: 0, endsAt: M.caption });
  });
  it('sends a bet that closed the street straight to the pot, with no amount to appear', () => {
    const b = betBeats(true);
    expect(b.chip).toEqual({ startsAt: 0, endsAt: M.betToPot });
    expect(b.amountAppears).toBeUndefined();
  });
  it('takes its timings from the object given', () => {
    expect(betBeats(false, slower).chip.endsAt).toBe(900);
  });
  it('describes its anchors, formulas and the timings that set each beat', () => {
    expect(betBeatDescription.map(b => b.beat)).toEqual(['lineChip', 'lineAmount', 'potChip', 'caption']);
    expect(beatOf(betBeatDescription, 'lineChip')).toMatchObject({ each: 'toLine', follows: 'the bet', gap: '0', length: 'motion.betFlight', setBy: ['motion.betFlight'] });
    expect(beatOf(betBeatDescription, 'lineAmount')).toMatchObject({ gap: 'motion.betAmountAppears', length: '0', setBy: ['motion.betAmountAppears'] });
    expect(beatOf(betBeatDescription, 'potChip').setBy).toEqual(['motion.betToPot']);
  });
});

describe('a fold’s beats', () => {
  it('mucks cards one after another, in order', () => {
    const { mucks, caption } = foldBeats(3);
    expect(mucks).toEqual([0, 1, 2].map(k => ({ startsAt: k * M.muckStagger, endsAt: k * M.muckStagger + M.muckFlight })));
    expect(caption).toEqual({ startsAt: 0, endsAt: M.caption });
  });
  it('mucks nothing for a hand that is not mucked', () => {
    expect(foldBeats(0).mucks).toEqual([]);
  });
  it('spaces the mucks by its stagger timing', () => {
    expect(foldBeats(2, slower).mucks[1]!.startsAt).toBe(200);
  });
  it('describes the muck as a stagger over its cards', () => {
    expect(beatOf(foldBeatDescription, 'muck')).toMatchObject({ each: 'mucked', follows: 'the fold', gap: 'motion.muckStagger × index', length: 'motion.muckFlight', setBy: ['motion.muckStagger', 'motion.muckFlight'] });
    expect(beatOf(foldBeatDescription, 'caption').setBy).toEqual(['motion.caption']);
  });
});

describe('a check’s beats', () => {
  it('presses the seat and shows the caption together', () => {
    expect(checkBeats()).toEqual({ press: { startsAt: 0, endsAt: M.check }, caption: { startsAt: 0, endsAt: M.caption } });
    expect(beatOf(checkBeatDescription, 'press')).toMatchObject({ follows: 'the check', length: 'motion.check', setBy: ['motion.check'] });
  });
});

describe('a Participant arriving, leaving or moving', () => {
  it('fades the empty seat, then arrives the new one', () => {
    expect(sitBeats()).toEqual({ fade: { startsAt: 0, endsAt: M.sitFade }, arrives: { startsAt: M.sitArrivesAt, endsAt: M.sitArrivesAt + M.seatArrives } });
    expect(sitBeats(slower).arrives.startsAt).toBe(500);
  });
  it('fades the seat left, then arrives it empty', () => {
    expect(standBeats()).toEqual({ fade: { startsAt: 0, endsAt: M.leaveFade }, arrives: { startsAt: M.leaveArrivesAt, endsAt: M.leaveArrivesAt + M.seatArrives } });
  });
  it('fades both seats, then arrives the new one and the vacated one', () => {
    expect(moveBeats()).toEqual({
      leftFade: { startsAt: 0, endsAt: M.leaveFade }, newFade: { startsAt: 0, endsAt: M.sitFade },
      newArrives: { startsAt: M.leaveArrivesAt, endsAt: M.leaveArrivesAt + M.seatArrives },
      vacatedArrives: { startsAt: M.moveVacatedArrivesAt, endsAt: M.moveVacatedArrivesAt + M.seatArrives },
    });
  });
  it('describes each, with the timings that set each beat', () => {
    expect(sitBeatDescription.map(b => b.beat)).toEqual(['fade', 'arrives']);
    expect(beatOf(sitBeatDescription, 'arrives')).toMatchObject({ follows: 'the arrival', gap: 'motion.sitArrivesAt', length: 'motion.seatArrives', setBy: ['motion.sitArrivesAt', 'motion.seatArrives'] });
    expect(beatOf(standBeatDescription, 'fade').setBy).toEqual(['motion.leaveFade']);
    expect(beatOf(moveBeatDescription, 'vacatedArrives').setBy).toEqual(['motion.moveVacatedArrivesAt', 'motion.seatArrives']);
  });
});

describe('chips added to a stack', () => {
  it('flies in, floats the amount and rolls the figure together', () => {
    expect(chipsBeats()).toEqual({ flight: { startsAt: 0, endsAt: M.chipsFlight }, label: { startsAt: 0, endsAt: M.chipsLabel }, roll: { startsAt: 0, endsAt: M.stackRoll } });
    expect(chipsBeats(slower).flight.endsAt).toBe(1000);
    expect(chipsBeatDescription.map(b => b.beat)).toEqual(['flight', 'label', 'roll']);
    expect(beatOf(chipsBeatDescription, 'roll')).toMatchObject({ follows: 'the chips added', setBy: ['motion.stackRoll'] });
  });
});

describe('the viewer’s own seat change', () => {
  it('fades the old seats, then arrives the new ones and the label', () => {
    expect(seatChangeBeats()).toEqual({
      fade: { startsAt: 0, endsAt: M.seatChangeFade },
      arrives: { startsAt: M.seatChangeArrivesAt, endsAt: M.seatChangeArrivesAt + M.seatChangeArrives },
      label: { startsAt: M.seatChangeArrivesAt, endsAt: M.seatChangeArrivesAt + M.seatChangeLabel },
    });
    expect(beatOf(seatChangeBeatDescription, 'label').setBy).toEqual(['motion.seatChangeArrivesAt', 'motion.seatChangeLabel']);
  });
});

describe('a seat’s status changing', () => {
  it('changes its caption and connection label together', () => {
    expect(statusBeats()).toEqual({ caption: { startsAt: 0, endsAt: M.status }, connection: { startsAt: 0, endsAt: M.status } });
    expect(statusBeatDescription.map(b => b.beat)).toEqual(['caption', 'connection']);
  });
});

describe('every motion beat', () => {
  it('ends after it starts', () => {
    const placed = [...Object.values(betBeats(false)), ...Object.values(betBeats(true)), ...Object.values(checkBeats()), ...Object.values(sitBeats()), ...Object.values(standBeats()), ...Object.values(moveBeats()), ...Object.values(chipsBeats()), ...Object.values(seatChangeBeats()), ...Object.values(statusBeats()), ...foldBeats(3).mucks];
    for (const b of placed) if (typeof b === 'object') expect(b.endsAt).toBeGreaterThan(b.startsAt);
  });
  it('is set by motion timings only, and every motion timing outside the sweep sets one', () => {
    const listed = new Set(descriptions.flat().flatMap(b => b.setBy));
    for (const path of listed) expect(path.startsWith('motion.')).toBe(true);
    expect(Object.keys(M).map(k => `motion.${k}`).filter(p => !listed.has(p as never))).toEqual(['motion.sweepAt', 'motion.sweepFlight', 'motion.sweepStagger', 'motion.sweepAmountFade', 'motion.potAfterSweep', 'motion.potBrightens']);
  });
});
