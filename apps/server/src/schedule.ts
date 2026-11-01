import type { ActionWindow, DecisionId, ParticipantId, PresentationPhase, PresentationPhaseKind, ServerTime, TableSchedule } from '@poker/contracts';
import type { CashGameEvent } from '@poker/engine';

/**
 * Server-owned play timing (ADR-0032). Pure: callers supply the transition's events, the decision
 * current after it, and the time from the injected clock. The resulting schedule is persisted with
 * the commit that produced it; nothing here is a poker command.
 */
export const presentationDurations: Readonly<Record<PresentationPhaseKind, number>> = Object.freeze({ deal: 1500, street: 1000 });

export const emptySchedule: TableSchedule = Object.freeze({ phases: Object.freeze([]), actionWindow: null });

/** The current decision after a transition, or `null` when no one is to act. */
export type CurrentDecision = { readonly participantId: ParticipantId; readonly decisionId: DecisionId } | null;

const phaseEnd = (phases: readonly PresentationPhase[]) => phases.reduce((end, phase) => Math.max(end, phase.endsAt), -Infinity);

/**
 * The schedule after an accepted transition. Each phase starts when the previous one ends (or now),
 * a new Hand replaces the previous Hand's phases, and the Action Window of a new decision opens when the
 * last phase ends. A transition without Hand events (seating, configuration) leaves the schedule unchanged.
 */
export function scheduleTransition(previous: TableSchedule, events: readonly CashGameEvent[], decision: CurrentDecision, now: ServerTime): TableSchedule {
  if (!events.some(event => 'handId' in event)) return previous;
  let phases = [...previous.phases];
  let cursor = Math.max(now, phaseEnd(phases));
  const add = (kind: PresentationPhaseKind, handId: string, street: PresentationPhase['street']) => {
    const durationMs = presentationDurations[kind];
    phases.push({ kind, handId, street, startsAt: cursor, endsAt: cursor + durationMs, durationMs });
    cursor += durationMs;
  };
  for (const event of events) {
    if (event.type === 'hand-started') { phases = []; add('deal', event.handId, 'preflop'); }
    if (event.type === 'board-dealt') add('street', event.handId, event.street);
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

/** The next server time at which the table has scheduled work: today, its Action Window opening. */
export function nextWakeAt(schedule: TableSchedule, now: ServerTime): ServerTime | undefined {
  const opensAt = schedule.actionWindow?.opensAt;
  return opensAt !== undefined && opensAt > now ? opensAt : undefined;
}
