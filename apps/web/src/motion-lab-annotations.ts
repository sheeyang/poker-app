import { betBeatDescription, checkBeatDescription, dealBeatDescription, foldBeatDescription, payoutBeatDescription, showdownBeatDescription, streetBeatDescription, sweepBeatDescription, type BeatDescription, type Timings, type TimingPath } from '@poker/contracts';
import type { BeatSource, LabBeat } from './motion-lab-model.js';
import type { Edits } from './motion-lab-edits.js';

/**
 * What the motion lab says about its beats (ADR-0040): pure. Pulse (after an edit), hover (over a timing) and select
 * (a beat) all read the one description each beat comes from, through `descriptionOf`, so they cannot disagree. A timing
 * directly sets a beat when it is in that beat's own anchor floor, gap or length; a beat that only moved because
 * something before it grew is not set by it, so it neither pulses nor lights.
 */

const DESCRIPTIONS: Record<BeatSource, readonly BeatDescription[]> = {
  deal: dealBeatDescription, street: streetBeatDescription, showdown: showdownBeatDescription, payout: payoutBeatDescription,
  sweep: sweepBeatDescription, bet: betBeatDescription, fold: foldBeatDescription, check: checkBeatDescription,
};

/** The description of the group `beat` belongs to. */
export function descriptionOf(beat: LabBeat): BeatDescription {
  const description = DESCRIPTIONS[beat.ref.source].find(d => d.beat === beat.ref.group);
  if (!description) throw new Error(`No ${beat.ref.source} beat description for ${beat.ref.group}`);
  return description;
}

/** Every timing that directly sets `beat`: the floor of its anchor, then its gap and length. */
export const setBy = (beat: LabBeat): readonly TimingPath[] => descriptionOf(beat).setBy;

/** The beats `path` directly sets: what hovering the timing lights. */
export const beatsSetBy = (beats: readonly LabBeat[], path: TimingPath): readonly LabBeat[] => beats.filter(beat => setBy(beat).includes(path));

/** The beats an edit to `changed` pulses: those it directly sets; never those that only shifted. */
export const pulsedBeats = (beats: readonly LabBeat[], changed: readonly TimingPath[]): readonly LabBeat[] => beats.filter(beat => changed.some(path => setBy(beat).includes(path)));

/** The timings whose edited value differs between two sets of edits (an edit that was added, dropped or changed). */
export function changedPaths(before: Edits, after: Edits): TimingPath[] {
  const paths = new Set([...Object.keys(before), ...Object.keys(after)] as TimingPath[]);
  return [...paths].filter(path => before[path] !== after[path]);
}

/** What a beat follows: its words, the beat it follows (none for the phase start or a table event), and when the anchor sits. */
export interface Follows {
  readonly text: string;
  /** The beat followed, in the same phase or table event; null when it follows the phase start, an event, or a group with no beats. */
  readonly target: LabBeat | null;
  readonly edge: 'start' | 'end' | null;
  /** The timing the anchor is never earlier than, when it has one. */
  readonly floor: TimingPath | null;
  /** Milliseconds from the start of the script: where the anchor sits. */
  readonly at: number;
}

export interface BeatSelection {
  readonly beat: LabBeat;
  readonly description: BeatDescription;
  readonly setBy: readonly TimingPath[];
  readonly follows: Follows;
  /** The gap and length as formulas over timings and counts. */
  readonly gap: string;
  readonly length: string;
}

const timingAt = (timings: Timings, path: TimingPath): number => path.split('.').reduce<unknown>((node, key) => (node as Record<string, unknown>)[key], timings) as number;

/** `the end of its card`, `the start of the first blind`, `the end of the last refill, or street.burnEarliest if later`. */
const FOLLOWS = /^the (start|end) of (?:its|the (first|last)) (\w+?)(?:, or (\S+) if later)?$/;

/** The beat `id` selected: its description, the timings that set it, and what it follows. */
export function beatSelection(beats: readonly LabBeat[], id: number, timings: Timings): BeatSelection | undefined {
  const beat = beats.find(b => b.id === id);
  if (!beat) return undefined;
  const description = descriptionOf(beat), match = FOLLOWS.exec(description.follows);
  let target: LabBeat | null = null, edge: Follows['edge'] = null, at = beat.ref.scopeStart;
  const floor = (match?.[4] as TimingPath | undefined) ?? null;
  if (match) {
    edge = match[1] as 'start' | 'end';
    const group = beats.filter(b => b.ref.scope === beat.ref.scope && b.ref.group === match[3]).sort((a, b) => a.ref.index - b.ref.index);
    if (group.length) {
      target = !match[2] ? group[Math.min(beat.ref.index, group.length - 1)]! : match[2] === 'first' ? group[0]! : group.reduce((last, b) => (b.endsAt > last.endsAt ? b : last));
      at = edge === 'end' ? target.endsAt : target.startsAt;
    }
  }
  if (floor) at = Math.max(at, beat.ref.scopeStart + timingAt(timings, floor));
  return { beat, description, setBy: setBy(beat), follows: { text: description.follows, target, edge: target ? edge : null, floor, at }, gap: description.gap, length: description.length };
}

/** A beat's place across edits: its ids shift as an edit reorders beats in time, this does not. */
export const beatKey = (beat: LabBeat): string => `${beat.ref.scope}/${beat.ref.source}.${beat.ref.group}/${beat.ref.index}`;
