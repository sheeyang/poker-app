import type { ActionWindow, DecisionId, ParticipantId, PresentationPhase, PresentationPhaseKind, ServerTime, Street, TableSchedule } from '@poker/contracts';
import type { CashGameEvent } from '@poker/engine';

/**
 * Server-owned play timing (ADR-0032). Pure: callers supply the transition's events, the decision
 * current after it, and the time from the injected clock. The resulting schedule is persisted with
 * the commit that produced it; nothing here is a poker command.
 */
export const presentationDurations: Readonly<Record<PresentationPhaseKind, number>> = Object.freeze({ deal: 1500, street: 1000, showdown: 2000, payout: 2000 });

export const emptySchedule: TableSchedule = Object.freeze({ phases: Object.freeze([]), actionWindow: null });

/** The current decision after a transition, or `null` when no one is to act. */
export type CurrentDecision = { readonly participantId: ParticipantId; readonly decisionId: DecisionId } | null;

const phaseEnd = (phases: readonly PresentationPhase[]) => phases.reduce((end, phase) => Math.max(end, phase.endsAt), -Infinity);

/**
 * The schedule after an accepted transition. Each phase starts when the previous one ends (or now),
 * a new Hand replaces the previous Hand's phases, and the Action Window of a new decision opens when the
 * last phase ends. A transition without Hand events (seating, configuration) leaves the schedule unchanged.
 *
 * Phases follow the transition's events in order, so an all-in runout schedules the hole-card reveals
 * (showdown), then each remaining street, then the payout, all from one accepted action. A Hand won by
 * folds has no showdown. The payout phase is always a Hand's last.
 */
export function scheduleTransition(previous: TableSchedule, events: readonly CashGameEvent[], decision: CurrentDecision, now: ServerTime): TableSchedule {
  if (!events.some(event => 'handId' in event)) return previous;
  let phases = [...previous.phases];
  let cursor = Math.max(now, phaseEnd(phases));
  // The Hand is on the street of its latest phase; a showdown and a payout present the street the Hand reached.
  let street: Street = phases.at(-1)?.street ?? 'preflop';
  const add = (kind: PresentationPhaseKind, handId: string) => {
    const durationMs = presentationDurations[kind];
    phases.push({ kind, handId, street, startsAt: cursor, endsAt: cursor + durationMs, durationMs });
    cursor += durationMs;
  };
  for (const event of events) {
    if (event.type === 'hand-started') { phases = []; street = 'preflop'; add('deal', event.handId); }
    if (event.type === 'hole-cards-revealed' && !phases.some(phase => phase.kind === 'showdown' && phase.handId === event.handId)) add('showdown', event.handId);
    if (event.type === 'board-dealt') { street = event.street; add('street', event.handId); }
    if (event.type === 'hand-completed') add('payout', event.handId);
  }
  const kept = previous.actionWindow && decision && previous.actionWindow.decisionId === decision.decisionId ? previous.actionWindow : undefined;
  const actionWindow: ActionWindow | null = kept ?? (decision ? { participantId: decision.participantId, decisionId: decision.decisionId, opensAt: cursor } : null);
  return { phases, actionWindow };
}

/** Whether an action by `participantId` at server time `at` arrives before their Action Window opens. */
export function beforeActionWindow(schedule: TableSchedule, participantId: ParticipantId, at: ServerTime): boolean {
  const window = schedule.actionWindow;
  return !!window && window.participantId === participantId && at < window.opensAt;
}

/**
 * When the latest Hand's payout phase ends, or `undefined` when no Hand has been paid out. This instant
 * is the end of a Hand's presentation: Deal is accepted from it, and after-Hand work (requests applied
 * between Hands, the pause and countdown of Automatic Dealing) follows it.
 */
export function payoutEndsAt(schedule: TableSchedule): ServerTime | undefined {
  return schedule.phases.findLast(phase => phase.kind === 'payout')?.endsAt;
}

/** Whether a Deal at server time `at` arrives before the latest Hand's payout phase has ended. */
export function beforePayoutEnd(schedule: TableSchedule, at: ServerTime): boolean {
  const endsAt = payoutEndsAt(schedule);
  return endsAt !== undefined && at < endsAt;
}

/** The next server time at which the table has scheduled work: its Action Window opening, or the end of the payout phase. */
export function nextWakeAt(schedule: TableSchedule, now: ServerTime): ServerTime | undefined {
  const instants = [schedule.actionWindow?.opensAt, payoutEndsAt(schedule)].filter((at): at is ServerTime => at !== undefined && at > now);
  return instants.length ? Math.min(...instants) : undefined;
}
