import { presentationPhaseDurations, settleAfter, type ObservableTableSession, type PresentationPhaseKind, type PresentingPhaseKind, type Street, type TableMode } from '@poker/contracts';
import { dealMs, showdownMs, streetMs } from './presentation.js';

/**
 * Presentation Phase lengths for server tests, from the shared presentation timing, so that tests follow it instead
 * of repeating its numbers.
 */

/** The shared length of a deal (of `players` dealt in, heads-up unless given) or a payout. Street reveals and showdowns: `streetMs`, `showdownMs`. */
export const lengthOf = (kind: Exclude<PresentingPhaseKind, 'street' | 'showdown'>, players = 2): number => kind === 'deal' ? dealMs(players) : presentationPhaseDurations[kind];

/** The length of the Settle after a phase of `kind` at a table of `mode` (Practice unless given). */
export const settleOf = (kind: PresentingPhaseKind, mode: TableMode = 'practice'): number => settleAfter(kind, mode);

/** A deal or payout and its Settle together: how long the table presents it before anything else happens. */
export const presentedFor = (kind: Exclude<PresentingPhaseKind, 'street' | 'showdown'>, mode: TableMode = 'practice', players = 2): number => lengthOf(kind, players) + settleOf(kind, mode);

/** A street reveal sweeping `swept` wagers and revealing `cardCount` board cards (the flop unless given), and its Settle. */
export const presentedStreetFor = (swept: number, cardCount = 3, mode: TableMode = 'practice'): number => streetMs(swept, cardCount) + settleOf('street', mode);

/** A showdown sweeping `swept` wagers and turning up `shown` hands (heads-up unless given), and its Settle. */
export const presentedShowdownFor = (swept: number, shown = 2, mode: TableMode = 'practice'): number => showdownMs(swept, shown) + settleOf('showdown', mode);

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
