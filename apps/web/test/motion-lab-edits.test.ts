import { describe, expect, it } from 'vitest';
import { committedTimings, dealBeatDescription, payoutBeatDescription, showdownBeatDescription, streetBeatDescription, timingNotes, type TimingPath } from '@poker/contracts';
import { motionLab } from '../src/motion-lab-model.js';
import { blockTimings, effectiveTimings, listedTimings, nudged, phaseTotals, setEdit, sliderMax, timingGroups } from '../src/motion-lab-edits.js';

const paths = (descriptions: readonly { setBy: readonly TimingPath[] }[]) => [...new Set(descriptions.flatMap(d => d.setBy))].sort();

describe('edits', () => {
  it('produce the effective timings the replay uses, leaving the committed ones alone', () => {
    const timings = effectiveTimings({ 'deal.cardFlight': 900, 'settle.payout.online': 1 });
    expect(timings.deal.cardFlight).toBe(900);
    expect(timings.settle.payout.online).toBe(1);
    expect(timings.deal.turn).toBe(committedTimings.deal.turn);
    expect(committedTimings.deal.cardFlight).not.toBe(900);
    const base = motionLab({ scenario: 'heads-up', mode: 'practice' }), changed = motionLab({ scenario: 'heads-up', mode: 'practice', timings });
    expect(changed.blocks[0]!.endsAt - changed.blocks[0]!.startsAt).not.toBe(base.blocks[0]!.endsAt - base.blocks[0]!.startsAt);
  });
  it('drop an edit equal to the committed value, and keep whole non-negative milliseconds', () => {
    const committed = committedTimings.deal.cardFlight;
    expect(setEdit({}, 'deal.cardFlight', committed)).toEqual({});
    expect(setEdit({ 'deal.cardFlight': 5 }, 'deal.cardFlight', committed)).toEqual({});
    expect(setEdit({}, 'deal.cardFlight', -20)).toEqual({ 'deal.cardFlight': 0 });
    expect(setEdit({}, 'deal.cardFlight', committed + 0.4)).toEqual({});
  });
  it('nudge by 10 ms, or 50 ms with Shift, never below 0', () => {
    expect(nudged(100, 1, false)).toBe(110);
    expect(nudged(100, -1, true)).toBe(50);
    expect(nudged(20, -1, true)).toBe(0);
  });
  it('slide from 0 to three times the committed value', () => {
    expect(sliderMax('deal.cardFlight')).toBe(committedTimings.deal.cardFlight * 3);
  });
});

describe('the list', () => {
  it('holds every timing once, grouped like the timing file, each with its note', () => {
    const all = timingGroups.flatMap(g => g.timings);
    expect(all.map(t => t.path).sort()).toEqual(Object.keys(timingNotes).sort());
    expect(timingGroups.map(g => g.id)).toEqual(Object.keys(committedTimings));
    expect(all.every(t => t.note.length > 0)).toBe(true);
  });
  const lab = motionLab({ scenario: 'heads-up', mode: 'online' });
  const listed = (label: string, nth = 0) => {
    const index = lab.blocks.findIndex((b, i) => b.label === label && lab.blocks.slice(0, i).filter(x => x.label === label).length === nth);
    return listedTimings(blockTimings(lab.blocks, index, 'online')).flatMap(g => g.timings.map(t => t.path)).sort();
  };
  it('lists exactly the timings a selected phase uses', () => {
    expect(listed('Deal')).toEqual(paths(dealBeatDescription));
    expect(listed('Deal')).toContain('deal.returnStagger');
    expect(listed('Flop')).toEqual(paths(streetBeatDescription));
    expect(listed('Showdown')).toEqual(paths(showdownBeatDescription));
    expect(listed('Payout')).toEqual(paths(payoutBeatDescription));
  });
  it('lists the Settle after a phase, by mode, and the Next-Hand Countdown', () => {
    expect(listed('Settle', 0)).toEqual(['settle.deal']);
    expect(listed('Settle', 4)).toEqual(['settle.showdown']);
    expect(listed('Settle', 5)).toEqual(['settle.payout.online']);
    const practice = motionLab({ scenario: 'heads-up', mode: 'practice' });
    expect(blockTimings(practice.blocks, practice.blocks.length - 1, 'practice')).toEqual(['settle.payout.practice']);
    expect(blockTimings(lab.blocks, lab.blocks.length - 1, 'online')).toEqual(['nextHandCountdownMs']);
  });
  it('lists everything with no phase selected', () => {
    expect(listedTimings(undefined).flatMap(g => g.timings)).toHaveLength(Object.keys(timingNotes).length);
  });
});

describe('phase totals', () => {
  it('follow edits, as the server would length the phases', () => {
    const base = phaseTotals(motionLab({ scenario: 'heads-up', mode: 'practice' }).blocks);
    const edited = phaseTotals(motionLab({ scenario: 'heads-up', mode: 'practice', timings: effectiveTimings({ 'deal.cardFlight': 1500, 'settle.deal': 100 }) }).blocks);
    expect(edited[0]!.label).toBe('Deal');
    expect(edited[0]!.ms).toBeGreaterThan(base[0]!.ms);
    expect(edited[1]!.ms).toBe(100);
    expect(edited[2]!.ms).toBe(base[2]!.ms);
  });
});
