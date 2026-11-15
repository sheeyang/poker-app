import { committedTimings, dealBeatDescription, payoutBeatDescription, showdownBeatDescription, streetBeatDescription, timingNotes, type TableMode, type Timings, type TimingPath } from '@poker/contracts';
import type { LabBlock } from './motion-lab-model.js';

/**
 * The motion lab's timing edits (ADR-0040): pure. Edits are a sparse map from timing path to milliseconds, never more
 * than the differences from the committed timings. From them: the effective timings the replay plays, the list of
 * timings to show for a phase, and each phase's total.
 */

export type Edits = Readonly<Partial<Record<TimingPath, number>>>;

export interface ListedTiming { readonly path: TimingPath; readonly note: string; readonly committed: number }
export interface TimingGroup { readonly id: string; readonly timings: readonly ListedTiming[] }

const leaves = (value: unknown, prefix: string): [TimingPath, number][] =>
  typeof value === 'number' ? [[prefix as TimingPath, value]]
    : Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => leaves(child, `${prefix}.${key}`));

/** The committed value at a path. */
export const committedValue = (path: TimingPath): number => path.split('.').reduce<unknown>((node, key) => (node as Record<string, unknown>)[key], committedTimings) as number;

/** Every timing, grouped as the timing file groups them (a top-level number is a group of one). */
export const timingGroups: readonly TimingGroup[] = Object.keys(committedTimings).map(id => ({
  id,
  timings: leaves((committedTimings as Record<string, unknown>)[id], id).map(([path, committed]) => ({ path, note: timingNotes[path], committed })),
}));

/** The timings with the edits applied: a new object; the committed ones are untouched. */
export function effectiveTimings(edits: Edits): Timings {
  const copy = structuredClone(committedTimings) as Record<string, unknown>;
  for (const [path, value] of Object.entries(edits) as [TimingPath, number][]) {
    const keys = path.split('.');
    const last = keys.pop()!;
    keys.reduce<Record<string, unknown>>((node, key) => node[key] as Record<string, unknown>, copy)[last] = value;
  }
  return copy as Timings;
}

/** The edits with `path` set to `value` (whole milliseconds, at least 0); an edit equal to the committed value is no edit. */
export function setEdit(edits: Edits, path: TimingPath, value: number): Edits {
  const { [path]: _dropped, ...rest } = edits;
  const ms = Math.max(0, Math.round(value));
  return ms === committedValue(path) ? rest : { ...rest, [path]: ms };
}

/** A timing's value one arrow-key step on: 10 ms, or 50 ms with Shift; never below 0. */
export const nudged = (value: number, direction: 1 | -1, shift: boolean): number => Math.max(0, value + direction * (shift ? 50 : 10));

/** A timing's slider runs from 0 to three times its committed value. */
export const sliderMax = (path: TimingPath): number => committedValue(path) * 3;

const usedBy = (descriptions: readonly { readonly setBy: readonly TimingPath[] }[]): TimingPath[] => [...new Set(descriptions.flatMap(d => d.setBy))];

/** The timings the block at `index` uses: those its beats are set by; a Settle's own length (after a payout, the mode's); the countdown's. */
export function blockTimings(blocks: readonly LabBlock[], index: number, mode: TableMode): TimingPath[] {
  const block = blocks[index]!;
  switch (block.kind) {
    case 'deal': return usedBy(dealBeatDescription);
    case 'street': return usedBy(streetBeatDescription);
    case 'showdown': return usedBy(showdownBeatDescription);
    case 'payout': return usedBy(payoutBeatDescription);
    case 'countdown': return ['nextHandCountdownMs'];
    case 'settle': {
      const before = blocks[index - 1]?.kind;
      return before === 'payout' ? [`settle.payout.${mode}`] : [`settle.${before === 'deal' || before === 'showdown' ? before : 'street'}`] as TimingPath[];
    }
  }
}

/** The groups of the list, narrowed to `only` when given (empty groups left out). */
export function listedTimings(only?: readonly TimingPath[]): readonly TimingGroup[] {
  if (!only) return timingGroups;
  const wanted = new Set(only);
  return timingGroups.map(g => ({ id: g.id, timings: g.timings.filter(t => wanted.has(t.path)) })).filter(g => g.timings.length > 0);
}

/** Each block's length: how long the server would make the phase. */
export const phaseTotals = (blocks: readonly LabBlock[]): readonly { readonly label: string; readonly ms: number }[] => blocks.map(b => ({ label: b.label, ms: b.endsAt - b.startsAt }));
