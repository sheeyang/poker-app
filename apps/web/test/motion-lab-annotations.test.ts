import { describe, expect, it } from 'vitest';
import { committedTimings } from '@poker/contracts';
import { motionLab, type ScenarioId } from '../src/motion-lab-model.js';
import { effectiveTimings } from '../src/motion-lab-edits.js';
import { beatSelection, beatsSetBy, changedPaths, descriptionOf, pulsedBeats } from '../src/motion-lab-annotations.js';

const labOf = (scenario: ScenarioId, mode: 'practice' | 'online' = 'practice') => motionLab({ scenario, mode });
const groups = (beats: readonly { ref: { source: string; group: string } }[]) => [...new Set(beats.map(b => `${b.ref.source}.${b.ref.group}`))].sort();

describe('the beats an edit pulses', () => {
  it('are exactly the beats it directly sets, not the beats that only shifted', () => {
    const lab = labOf('heads-up');
    const pulsed = pulsedBeats(lab.beats, ['deal.cardFlight']);
    expect(groups(pulsed)).toEqual(['deal.card']);
    expect(pulsed.length).toBe(4);
    // The deal grew, so the flop and everything after moved later; none of those pulse.
    const edited = motionLab({ scenario: 'heads-up', mode: 'practice', timings: effectiveTimings({ 'deal.cardFlight': 2000 }) });
    const flopBefore = lab.beats.find(b => b.ref.source === 'street')!, flopAfter = edited.beats.find(b => b.ref.source === 'street')!;
    expect(flopAfter.startsAt).toBeGreaterThan(flopBefore.startsAt);
    expect(pulsedBeats(edited.beats, ['deal.cardFlight']).some(b => b.ref.source === 'street')).toBe(false);
  });
  it('holds for motion with no Presentation Phase', () => {
    const lab = labOf('heads-up');
    expect(groups(pulsedBeats(lab.beats, ['motion.betFlight']))).toEqual(['bet.lineChip']);
    const captions = groups(pulsedBeats(lab.beats, ['motion.caption']));
    expect(captions).toEqual(expect.arrayContaining(['bet.caption', 'check.caption']));
    expect(captions).not.toContain('payout.awardCaption');
    expect(groups(pulsedBeats(labOf('folds').beats, ['motion.muckFlight']))).toEqual(['fold.muck']);
  });
  it('include a sweep with no phase and a street reveal alike', () => {
    expect(groups(pulsedBeats(labOf('folds').beats, ['motion.sweepFlight']))).toEqual(['street.sweepWager', 'sweep.sweepWager']);
  });
  it('include the deal timing returnStagger on the cards-return beat, which it directly sets', () => {
    expect(groups(pulsedBeats(labOf('heads-up').beats, ['deal.returnStagger']))).toEqual(['deal.cardsReturn']);
  });
  it('are none for an edit to a timing no beat of the scenario uses', () => {
    expect(pulsedBeats(labOf('heads-up').beats, ['deal.refillLands'])).toEqual([]);
    expect(pulsedBeats(labOf('rebuy').beats, ['deal.refillLands']).length).toBe(1);
  });
  it('come from the timings that changed between two sets of edits', () => {
    expect(changedPaths({}, { 'deal.cardFlight': 900 })).toEqual(['deal.cardFlight']);
    expect(changedPaths({ 'deal.cardFlight': 900, 'deal.turn': 5 }, { 'deal.cardFlight': 900 })).toEqual(['deal.turn']);
    expect(changedPaths({ 'deal.cardFlight': 900 }, { 'deal.cardFlight': 950 })).toEqual(['deal.cardFlight']);
  });
});

describe('hovering a timing', () => {
  it('gives the beats it directly sets, in every phase they appear in', () => {
    const lab = labOf('6-handed');
    expect(beatsSetBy(lab.beats, 'street.flopFlight').map(b => b.ref.group)).toEqual(['flopCard', 'flopCard', 'flopCard']);
    expect(beatsSetBy(lab.beats, 'street.cardFlight').every(b => b.ref.group === 'boardCard')).toBe(true);
  });
  it('and selecting a beat agree: every timing a selection lists lights that beat', () => {
    for (const scenario of ['heads-up', 'folds', 'runout', 'rebuy'] as const) {
      const lab = labOf(scenario);
      for (const beat of lab.beats) {
        for (const path of beatSelection(lab.beats, beat.id, committedTimings)!.setBy) expect(beatsSetBy(lab.beats, path).map(b => b.id)).toContain(beat.id);
      }
    }
  });
});

describe('selecting a beat', () => {
  it('lists the timings that set it and labels its gap and length with their formulas', () => {
    const lab = labOf('heads-up');
    const card = lab.beats.find(b => b.ref.source === 'deal' && b.ref.group === 'card' && b.ref.index === 1)!;
    const selection = beatSelection(lab.beats, card.id, committedTimings)!;
    expect(selection.setBy).toEqual(['deal.cardsAfterBlinds', 'deal.cardGap', 'deal.cardsRoom', 'deal.cardFlight']);
    expect(selection.gap).toBe('deal.cardsAfterBlinds + min(deal.cardGap, floor(deal.cardsRoom / cards)) × index');
    expect(selection.length).toBe('deal.cardFlight');
  });
  it('draws back to the beat it follows, and where its anchor sits', () => {
    const lab = labOf('heads-up');
    const card = lab.beats.find(b => b.ref.source === 'deal' && b.ref.group === 'card' && b.ref.index === 0)!;
    const blind = lab.beats.find(b => b.ref.source === 'deal' && b.ref.group === 'blind' && b.ref.index === 0)!;
    const s = beatSelection(lab.beats, card.id, committedTimings)!;
    expect(s.follows.text).toBe('the start of the first blind');
    expect(s.follows.target?.id).toBe(blind.id);
    expect(s.follows.at).toBe(blind.startsAt);
    expect(card.startsAt).toBe(s.follows.at + committedTimings.deal.cardsAfterBlinds);
  });
  it("follows the end of one beat in its own phase, not another phase's", () => {
    const lab = labOf('heads-up');
    const turns = lab.beats.filter(b => b.ref.source === 'street' && b.ref.group === 'flopCardTurn');
    const follows = beatSelection(lab.beats, turns[1]!.id, committedTimings)!.follows;
    expect(follows.target).toMatchObject({ ref: { source: 'street', group: 'flopCard', index: 1, scope: turns[1]!.ref.scope } });
    expect(follows.at).toBe(follows.target!.endsAt);
  });
  it('follows the last of several beats, or the phase start when there are none', () => {
    const rebuy = labOf('rebuy'), blind = rebuy.beats.find(b => b.ref.group === 'blind')!;
    expect(beatSelection(rebuy.beats, blind.id, committedTimings)!.follows.target?.ref.group).toBe('refill');
    const plain = labOf('heads-up'), plainBlind = plain.beats.find(b => b.ref.group === 'blind')!;
    const s = beatSelection(plain.beats, plainBlind.id, committedTimings)!;
    expect(s.follows.target).toBeNull();
    expect(s.follows.at).toBe(plainBlind.ref.scopeStart);
  });
  it('follows a table event for motion with no phase, at the view that carried it', () => {
    const lab = labOf('heads-up');
    const check = lab.beats.find(b => b.ref.source === 'check' && b.ref.group === 'press')!;
    const s = beatSelection(lab.beats, check.id, committedTimings)!;
    expect(s.follows.text).toBe('the check');
    expect(s.follows.target).toBeNull();
    expect(s.follows.at).toBe(check.startsAt);
    expect(s.setBy).toEqual(['motion.check']);
  });
  it('notes the floor of an anchor, taking whichever is later', () => {
    const lab = labOf('heads-up');
    const burn = lab.beats.find(b => b.ref.source === 'street' && b.ref.group === 'burn')!;
    const s = beatSelection(lab.beats, burn.id, committedTimings)!;
    expect(s.follows.floor).toBe('street.burnEarliest');
    expect(s.setBy[0]).toBe('street.burnEarliest');
    expect(descriptionOf(burn).beat).toBe('burn');
  });
  it('is none for a beat that is not there', () => {
    expect(beatSelection(labOf('heads-up').beats, 9999, committedTimings)).toBeUndefined();
  });
});
