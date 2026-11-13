import { handEndsAt, nextHandCountdownMs, presentationPhaseLength, presentingPhase, settleAfter, settleLengths, type ActionWindow, type DecisionId, type HandId, type ParticipantId, type PhaseInputs, type PresentationPhase, type PresentingPhaseKind, type ServerTime, type SettleLengths, type Street, type TableMode, type TableSchedule } from '@poker/contracts';
import type { CashGameEvent } from '@poker/engine';

/**
 * Server-owned play timing (ADR-0032). Pure: callers supply the transition's events, the decision
 * current after it, and the time from the injected clock. The resulting schedule is persisted with
 * the commit that produced it; nothing here is a poker command. Phase and countdown lengths come from the shared
 * presentation timing (ADR-0039): a phase that presents something lasts as long as its beats take for it.
 */

export const emptySchedule: TableSchedule = Object.freeze({ phases: Object.freeze([]), actionWindow: null });

/**
 * The current decision after a transition, or `null` when no one is to act. `actionTimeLimitMs` is set only
 * when this decision's Participant has an Action Deadline: a human, under the table's Action Time Limit.
 * `liveAnalysisDisallowed` is the table's Allow Live Analysis, captured for a human's decision as its window opens.
 */
export type CurrentDecision = { readonly participantId: ParticipantId; readonly decisionId: DecisionId; readonly actionTimeLimitMs?: number; readonly liveAnalysisDisallowed?: true } | null;

/**
 * Reads the Phase Inputs of each phase a transition schedules, by kind, from the transition (phase-inputs.ts): for the
 * phase of `handId` that presents `street`.
 */
export type PhaseInputsReader = { readonly [K in PresentingPhaseKind]: (handId: HandId, street: Street) => PhaseInputs[K] };

const phaseEnd = (phases: readonly PresentationPhase[]) => phases.reduce((end, phase) => Math.max(end, phase.endsAt), -Infinity);

/** How a table's transitions are scheduled. */
export interface ScheduleOptions {
  /** The table's mode, which chooses the Settle after the payout; a Practice Table's when absent. */
  readonly mode?: TableMode;
  /** The Settle lengths: the shared ones unless given. */
  readonly settleLengths?: SettleLengths;
  /** What the transition's phases present. */
  readonly inputs: PhaseInputsReader;
}

/**
 * The schedule after an accepted transition. Each phase starts when the previous one ends (or now),
 * a new Hand replaces the previous Hand's phases, and the Action Window of a new decision opens when the
 * last phase ends. A transition without Hand events (seating, configuration) leaves the schedule unchanged.
 *
 * Phases follow the transition's events in order, so an all-in runout schedules the hole-card reveals
 * (showdown), then each remaining street, then the payout, all from one accepted action. A Hand won by
 * folds has no showdown. Each presenting phase is followed by its Settle, whose length that phase and, after the
 * payout, the table's mode choose; a Settle of 0 is not scheduled. The Settle after the payout is a Hand's last
 * phase. A transition with Hand events always ends any Next-Hand Countdown: the Hand it announced has started.
 */
export function scheduleTransition(previous: TableSchedule, events: readonly CashGameEvent[], decision: CurrentDecision, now: ServerTime, options: ScheduleOptions): TableSchedule {
  if (!events.some(event => 'handId' in event)) return previous;
  let phases = [...previous.phases];
  let cursor = Math.max(now, phaseEnd(phases));
  // The Hand is on the street of its latest phase; a showdown and a payout present the street the Hand reached.
  let street: Street = phases.at(-1)?.street ?? 'preflop';
  const settle = (after: PresentingPhaseKind, handId: string) => {
    const durationMs = settleAfter(after, options.mode ?? 'practice', options.settleLengths ?? settleLengths);
    if (durationMs <= 0) return;
    phases.push({ kind: 'settle', handId, street, startsAt: cursor, endsAt: cursor + durationMs, durationMs });
    cursor += durationMs;
  };
  // A phase carries what it presents, and lasts as long as its beats take for it (ADR-0039).
  const add = <K extends PresentingPhaseKind>(kind: K, handId: string) => {
    const phase = presentingPhase(kind, options.inputs[kind](handId, street)), durationMs = presentationPhaseLength(phase);
    phases.push({ ...phase, handId, street, startsAt: cursor, endsAt: cursor + durationMs, durationMs });
    cursor += durationMs;
    settle(kind, handId);
  };
  for (const event of events) {
    if (event.type === 'hand-started') { phases = []; street = 'preflop'; add('deal', event.handId); }
    if (event.type === 'hole-cards-revealed' && !phases.some(phase => phase.kind === 'showdown' && phase.handId === event.handId)) add('showdown', event.handId);
    if (event.type === 'board-dealt') { street = event.street; add('street', event.handId); }
    if (event.type === 'hand-completed') add('payout', event.handId);
  }
  // A decision that stays current keeps its window, and so its Action Deadline and captured Allow Live Analysis.
  const kept = previous.actionWindow && decision && previous.actionWindow.decisionId === decision.decisionId ? previous.actionWindow : undefined;
  const actionWindow: ActionWindow | null = kept ?? (decision ? { participantId: decision.participantId, decisionId: decision.decisionId, opensAt: cursor,
    ...(decision.actionTimeLimitMs !== undefined ? { deadlineAt: cursor + decision.actionTimeLimitMs } : {}),
    ...(decision.liveAnalysisDisallowed ? { liveAnalysisDisallowed: true as const } : {}) } : null);
  return { phases, actionWindow };
}

/** Whether an action by `participantId` at server time `at` arrives before their Action Window opens. */
export function beforeActionWindow(schedule: TableSchedule, participantId: ParticipantId, at: ServerTime): boolean {
  const window = schedule.actionWindow;
  return !!window && window.participantId === participantId && at < window.opensAt;
}

/**
 * Whether an action by `participantId` at server time `at` arrives after the Action Deadline of `window`.
 * An action received at the deadline itself is on time.
 */
export function pastActionDeadline(window: Pick<ActionWindow, 'participantId' | 'deadlineAt'> | null | undefined, participantId: ParticipantId, at: ServerTime): boolean {
  return !!window && window.participantId === participantId && window.deadlineAt !== undefined && at > window.deadlineAt;
}

/** The first server time past the window's Action Deadline, from which its Timeout Action is due. */
const timeoutDueAt = (window: ActionWindow | null) => window?.deadlineAt === undefined ? undefined : window.deadlineAt + 1;

/** Whether a Deal at server time `at` arrives before the latest Hand has ended (`handEndsAt`). */
export function beforeHandEnd(schedule: TableSchedule, at: ServerTime): boolean {
  const endsAt = handEndsAt(schedule.phases);
  return endsAt !== undefined && at < endsAt;
}

/** The schedule with a Next-Hand Countdown announced at `now`. */
export function announceNextHand(schedule: TableSchedule, now: ServerTime): TableSchedule {
  return { ...schedule, nextHandCountdown: { startsAt: now, endsAt: now + nextHandCountdownMs, durationMs: nextHandCountdownMs } };
}

/** The schedule without its Next-Hand Countdown, as when the countdown is cancelled. */
export function withoutNextHand(schedule: TableSchedule): TableSchedule {
  return { phases: schedule.phases, actionWindow: schedule.actionWindow };
}

/**
 * The next server time at which the table has scheduled work: its Action Window opening, the moment its Action
 * Deadline has passed, the end of the Hand, or the expiry of its Next-Hand Countdown.
 */
export function nextWakeAt(schedule: TableSchedule, now: ServerTime): ServerTime | undefined {
  const instants = [schedule.actionWindow?.opensAt, timeoutDueAt(schedule.actionWindow), handEndsAt(schedule.phases), schedule.nextHandCountdown?.endsAt]
    .filter((at): at is ServerTime => at !== undefined && at > now);
  return instants.length ? Math.min(...instants) : undefined;
}
