import type { TimingPath } from '@poker/contracts';
import { effectiveTimings, timingGroups, type Edits } from './motion-lab-edits.js';

/**
 * The motion lab's saved edits and export (ADR-0040): pure. Edits are saved in the browser, each against the committed
 * value it was made from, so a later change to the committed timings never silently overrides (or is overridden by) one.
 */

/** An edit with the committed value it was made from. */
export interface SavedEdit { readonly value: number; readonly base: number }
export type Saved = Readonly<Partial<Record<TimingPath, SavedEdit>>>;

/** An edit whose committed value has changed since: held back until the maintainer keeps or drops it. */
export interface FlaggedEdit { readonly path: TimingPath; readonly value: number; readonly base: number; readonly committed: number }

export interface Reconciled {
  /** What to keep saved: edits that still count, and the flagged ones until decided. */
  readonly saved: Saved;
  /** The edits that apply to the replay. */
  readonly edits: Edits;
  readonly flagged: readonly FlaggedEdit[];
  /** Paths of saved edits to timings that no longer exist (dropped). */
  readonly removed: readonly TimingPath[];
}

const committedAt = new Map<string, number>(timingGroups.flatMap(g => g.timings.map(t => [t.path, t.committed] as const)));

/** The saved edits checked against the committed timings: the rules for base changed, timing removed and equal to committed. */
export function reconcile(saved: Saved): Reconciled {
  const keep: Partial<Record<TimingPath, SavedEdit>> = {}, edits: Partial<Record<TimingPath, number>> = {}, flagged: FlaggedEdit[] = [], removed: TimingPath[] = [];
  for (const [path, edit] of Object.entries(saved) as [TimingPath, SavedEdit][]) {
    const committed = committedAt.get(path);
    if (committed === undefined) { removed.push(path); continue; }
    if (edit.value === committed) continue;
    keep[path] = edit;
    if (edit.base === committed) edits[path] = edit.value;
    else flagged.push({ path, value: edit.value, base: edit.base, committed });
  }
  return { saved: keep, edits, flagged, removed };
}

/** Records `edits` as saved, each against the committed value now; a flagged edit (not in `edits`) stays as it is. */
export function saveEdits(saved: Saved, edits: Edits): Saved {
  const next: Partial<Record<TimingPath, SavedEdit>> = {};
  for (const [path, edit] of Object.entries(saved) as [TimingPath, SavedEdit][]) if (!(path in edits) && committedAt.get(path) !== edit.base) next[path] = edit;
  for (const [path, value] of Object.entries(edits) as [TimingPath, number][]) next[path] = { value, base: committedAt.get(path)! };
  return next;
}

/** Keeps a flagged edit: it now counts against the current committed value. */
export function keepFlagged(saved: Saved, path: TimingPath): Saved {
  const edit = saved[path], committed = committedAt.get(path);
  return edit && committed !== undefined ? { ...saved, [path]: { value: edit.value, base: committed } } : saved;
}

/** Drops a saved edit. */
export function dropSaved(saved: Saved, path: TimingPath): Saved {
  const { [path]: _dropped, ...rest } = saved;
  return rest;
}

export interface Change { readonly path: TimingPath; readonly old: number; readonly value: number }

/** Each changed timing against its old (committed) value, in the timing file's order; unchanged timings are left out. */
export const exportPreview = (edits: Edits): Change[] =>
  timingGroups.flatMap(g => g.timings).flatMap(t => (t.path in edits && edits[t.path] !== t.committed ? [{ path: t.path, old: t.committed, value: edits[t.path]! }] : []));

/** The whole timing file with the edits applied: the committed file's shape (two-space indent, CRLF line endings, a final line break), ready to paste over it. */
export const exportTimings = (edits: Edits): string => `${JSON.stringify(effectiveTimings(edits), null, 2)}\n`.replace(/\n/g, '\r\n');
