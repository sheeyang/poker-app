import type { Timings, TimingPath } from './timings.js';

/**
 * Beats as data (ADR-0040). A beat is an anchor, a gap and a length: it follows an anchor, starts a gap later, and lasts
 * a length. One definition yields both the beats (`evaluateBeats`) and a description of each beat for the motion panel
 * (`describeBeats`): what it follows, its gap and length formulas, and the timings that directly set it.
 */

/** A beat as it is placed: milliseconds from the phase's start, before any fitting to a phase length. */
export interface PlacedBeat { readonly startsAt: number; readonly endsAt: number }

/** A count a term may be multiplied by: a number, its own place among a group's beats (`index`), or a named count of what is presented. */
export type Count = number | 'index' | string;

/** What a beat follows: the phase's start (or its table event), or the start or end of another beat. */
export type Anchor =
  | { readonly to: 'phase' }
  /** The table event that causes the beat, for motion with no phase: it plays from that moment. */
  | { readonly to: 'event'; readonly event: string }
  /** The start or end of beat group `of`: the instance with the same index, the first, or (for ends) the last to end. */
  | {
    readonly to: 'start' | 'end';
    readonly of: string;
    readonly instance: 'same' | 'first' | 'last';
    /** A timing the anchor is never earlier than: the beat follows whichever is later, that or the beat it follows. */
    readonly atLeast?: TimingPath;
  };

/** A named timing, optionally times a count. */
export interface Term { readonly timing: TimingPath; readonly times?: Count }
/** Spacing that tightens: `min(spacing, room / over)` times a count; `whole` rounds the share of the room down. */
export interface Spacing { readonly spacing: TimingPath; readonly room: TimingPath; readonly over: Count; readonly times: Count; readonly whole?: true }
/** A gap or a length: a sum of terms. */
export type Formula = readonly (Term | Spacing)[];

/** A group of beats of one kind: `each` instances (a named count, or `once`), each with its own index. */
export interface BeatDef {
  readonly beat: string;
  readonly each: string;
  readonly follows: Anchor;
  readonly gap: Formula;
  readonly length: Formula;
}

/**
 * The counts the instances and terms of a set of definitions read, by name. `once` is always 1. A count that is a list
 * gives a different value to each instance, by its index: where each card sits in its hand, say.
 */
export type Counts = Readonly<Record<string, number | readonly number[]>>;

const isSpacing = (term: Term | Spacing): term is Spacing => 'spacing' in term;

/** The timing at `path` in `timings`. */
function timingAt(timings: Timings, path: TimingPath): number {
  let value: unknown = timings;
  for (const key of path.split('.')) value = (value as Record<string, unknown>)[key];
  return value as number;
}

/** The value of a formula for the beat at `index`, given the counts. */
function evaluateFormula(formula: Formula, index: number, counts: Counts, timings: Timings): number {
  const count = (c: Count): number => {
    if (typeof c === 'number') return c;
    if (c === 'index') return index;
    const named = counts[c] ?? 0;
    return typeof named === 'number' ? named : named[index] ?? 0;
  };
  let sum = 0;
  for (const term of formula) {
    if (isSpacing(term)) {
      const share = timingAt(timings, term.room) / Math.max(1, count(term.over));
      sum += Math.min(timingAt(timings, term.spacing), term.whole ? Math.floor(share) : share) * count(term.times);
    } else sum += timingAt(timings, term.timing) * (term.times === undefined ? 1 : count(term.times));
  }
  return sum;
}

/**
 * Every beat of `defs`, in the order defined (each may follow only those before it), by name: instance `i` of a group
 * follows its anchor by its gap. A group with no instances has no beats, and a beat that follows the end of one is
 * anchored at the phase's start; one that follows its start is anchored where its first beat would have started.
 */
export function evaluateBeats<D extends readonly BeatDef[]>(defs: D, counts: Counts, timings: Timings): Record<D[number]['beat'], PlacedBeat[]> {
  const all: Counts = { ...counts, once: 1 };
  const placed: Record<string, PlacedBeat[]> = {};
  const amount = (name: string): number => { const n = all[name] ?? 0; return typeof n === 'number' ? n : n.length; };
  const place = (def: BeatDef, index: number): PlacedBeat => {
    const startsAt = anchorAt(def, index) + evaluateFormula(def.gap, index, all, timings);
    return { startsAt, endsAt: startsAt + evaluateFormula(def.length, index, all, timings) };
  };
  const anchorAt = (def: BeatDef, index: number): number => {
    const a = def.follows;
    if (a.to === 'phase' || a.to === 'event') return 0;
    return Math.max(a.atLeast ? timingAt(timings, a.atLeast) : 0, followedAt(def, a, index));
  };
  const followedAt = (def: BeatDef, a: Extract<Anchor, { to: 'start' | 'end' }>, index: number): number => {
    const group = placed[a.of] ?? [];
    if (a.to === 'end') {
      if (!group.length) return 0;
      return a.instance === 'same' ? group[Math.min(index, group.length - 1)]!.endsAt : a.instance === 'first' ? group[0]!.endsAt : Math.max(...group.map(b => b.endsAt));
    }
    if (a.instance === 'same') return group[Math.min(index, group.length - 1)]!.startsAt;
    if (group.length) return group[0]!.startsAt;
    const source = defs.find(d => d.beat === a.of);
    return source ? place(source, 0).startsAt : 0;
  };
  for (const def of defs) placed[def.beat] = Array.from({ length: amount(def.each) }, (_, index) => place(def, index));
  return placed as Record<D[number]['beat'], PlacedBeat[]>;
}

/** A dev-facing description of one group of beats. */
export interface BeatDescription {
  readonly beat: string;
  /** The count of beats in the group, by name; `once` for a single beat. */
  readonly each: string;
  /** What the beat follows, in words. */
  readonly follows: string;
  /** Its gap and length, as formulas over timings (by path) and counts. */
  readonly gap: string;
  readonly length: string;
  /** The timings that directly set it: the floor of its anchor, then those in its own gap or length, in the order they appear. */
  readonly setBy: readonly TimingPath[];
}

const formulaText = (formula: Formula): string => {
  if (!formula.length) return '0';
  return formula.map(term => {
    if (isSpacing(term)) return `min(${term.spacing}, ${term.whole ? 'floor(' : ''}${term.room} / ${term.over}${term.whole ? ')' : ''}) × ${term.times}`;
    return term.times === undefined ? term.timing : `${term.timing} × ${term.times}`;
  }).join(' + ');
};
const timingsOf = (formula: Formula): TimingPath[] => formula.flatMap(term => isSpacing(term) ? [term.spacing, term.room] : [term.timing]);
const anchorTimings = (anchor: Anchor): TimingPath[] => 'atLeast' in anchor && anchor.atLeast ? [anchor.atLeast] : [];

const followsText = (anchor: Anchor): string => {
  if (anchor.to === 'phase') return 'the start of the phase';
  if (anchor.to === 'event') return `the ${anchor.event}`;
  const of = `the ${anchor.to} of ${anchor.instance === 'same' ? `its ${anchor.of}` : `the ${anchor.instance} ${anchor.of}`}`;
  return anchor.atLeast ? `${of}, or ${anchor.atLeast} if later` : of;
};

/** A description of each group of `defs`, in the order defined. */
export function describeBeats(defs: readonly BeatDef[]): readonly BeatDescription[] {
  return defs.map(def => ({
    beat: def.beat,
    each: def.each,
    follows: followsText(def.follows),
    gap: formulaText(def.gap),
    length: formulaText(def.length),
    setBy: [...new Set([...anchorTimings(def.follows), ...timingsOf(def.gap), ...timingsOf(def.length)])],
  }));
}
