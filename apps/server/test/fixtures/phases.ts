import { presentationPhaseDurations, settleAfter, type ObservableTableSession, type PresentationPhaseKind, type PresentingPhaseKind, type Street, type TableMode } from '@poker/contracts';
import { dealMs } from './presentation.js';

/**
 * Presentation Phase lengths for server tests, from the shared presentation timing, so that tests follow it instead
 * of repeating its numbers.
 */

/** The shared length of a presenting phase of `kind`: for the deal, of `players` dealt in (heads-up unless given). */
export const lengthOf = (kind: PresentingPhaseKind, players = 2): number => kind === 'deal' ? dealMs(players) : presentationPhaseDurations[kind];

/** The length of the Settle after a phase of `kind` at a table of `mode` (Practice unless given). */
export const settleOf = (kind: PresentingPhaseKind, mode: TableMode = 'practice'): number => settleAfter(kind, mode);

/** A presenting phase of `kind` and its Settle together: how long the table presents it before anything else happens. */
export const presentedFor = (kind: PresentingPhaseKind, mode: TableMode = 'practice', players = 2): number => lengthOf(kind, players) + settleOf(kind, mode);

/** Phases laid back to back from `startsAt`, each starting when the one before it ends. */
export function backToBack(startsAt: number, phases: readonly (readonly [kind: PresentationPhaseKind, street: Street, durationMs: number])[]) {
  let cursor = startsAt;
  return phases.map(([kind, street, durationMs]) => {
    const phase = { kind, street, startsAt: cursor, endsAt: cursor + durationMs, durationMs };
    cursor = phase.endsAt;
    return phase;
  });
}

/** When the view's current Action Window opens. */
export const windowOpensAt = (view: ObservableTableSession): number => view.schedule.actionWindow!.opensAt;

/** When the view's latest Hand ends: when its last phase, the Settle after its payout, ends. */
export const handEndsAt = (view: ObservableTableSession): number => view.schedule.phases.at(-1)!.endsAt;
