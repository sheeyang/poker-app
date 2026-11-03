import { afterHandRequestStrength, type ParticipantId, type AfterHandRequestKind, type AfterHandRequest, type ServerTime, type TableSchedule } from '@poker/contracts';
import type { CashGame, CashGameEvent, CashGameResult } from '@poker/engine';
import { beforePayoutEnd } from './schedule.js';

/**
 * After-Hand requests. A change to a Participant that the table cannot make while a Hand is in progress is
 * recorded in the Persisted Table Session instead (`pendingChanges`), shown to everyone in the table view, and
 * applied together, in one committed transition, once the Hand's payout phase ends. That transition runs before
 * Deal is accepted (Practice) and before the pause between Hands begins (Online, M4-10).
 *
 * The model is a list of `{ participantId, change }` with at most one entry per Participant. A stronger
 * request replaces a weaker one in place; a weaker or equal request changes nothing. Adding a change (the
 * Online timeout and Bot-failure sit-outs, Removal) means adding it to `afterHandRequestStrength` (in contracts, which
 * the Trainer also reads) and to `applyAfterHandRequests`, nothing else here.
 */
/** Records a request, keeping the strongest change per Participant. Returns `pending` itself when nothing changes. */
export function recordAfterHandRequest(pending: readonly AfterHandRequest[], participantId: ParticipantId, change: AfterHandRequestKind): readonly AfterHandRequest[] {
  const existing = pending.find(entry => entry.participantId === participantId);
  if (!existing) return [...pending, { participantId, change }];
  if (afterHandRequestStrength[existing.change] >= afterHandRequestStrength[change]) return pending;
  return pending.map(entry => entry === existing ? { participantId, change } : entry);
}

/**
 * Whether a Hand is in progress for management: it is being played, or its result is still being presented.
 * A Hand ends when its payout phase does, not when its last decision is made: changing stacks or seats while
 * the payout is shown would reveal the result early, and Deal waits for the same instant.
 */
export function handInProgress(status: 'between-hands' | 'active-hand' | 'completed-hand', schedule: TableSchedule, now: ServerTime): boolean {
  return status === 'active-hand' || beforePayoutEnd(schedule, now);
}

/** The pending change a self-service request becomes during a Hand, or `undefined` when it never waits. */
export function afterHandRequestFor(kind: string, request: object): AfterHandRequestKind | undefined {
  if (kind === 'stand-up-participant') return 'stand-up';
  if (kind === 'leave-table') return 'leave-table';
  if (kind === 'remove-participant') return 'remove';
  if (kind === 'set-sitting-out' && (request as { sittingOut?: unknown }).sittingOut === true) return 'sit-out';
  return undefined;
}

/**
 * Applies every pending change to `game` (a working copy), in the order asked. A change that no longer
 * applies, because the Participant already stood up or sat out, is skipped: the aim was reached. Returns the
 * accepted events and the Participants whose membership of the table ended: by Leave Table (`left`), or by the
 * owner's Removal (`removed`).
 */
export function applyAfterHandRequests(game: CashGame, pending: readonly AfterHandRequest[]): { events: CashGameEvent[]; left: ParticipantId[]; removed: ParticipantId[] } {
  const events: CashGameEvent[] = [];
  const left: ParticipantId[] = [];
  const removed: ParticipantId[] = [];
  const run = (result: CashGameResult) => { if (result.ok) events.push(...result.events); return result; };
  for (const { participantId, change } of pending) {
    if (change === 'sit-out') run(game.setSittingOut(participantId, true));
    else if (change === 'stand-up') run(game.standUpParticipant(participantId));
    else {
      const departed = run(standUpAndLeave(game, participantId));
      // Removal ends the membership whatever CashGame says about its own record of them.
      if (change === 'remove') removed.push(participantId);
      else if (departed.ok) left.push(participantId);
    }
  }
  return { events, left, removed };
}

/**
 * Stand Up if seated, then Leave Table, on `game` (a working copy): how a Participant leaves, by their own Leave
 * Table, the owner's Removal or a Bot's removal, at once or after the Hand. A Participant CashGame never counted as
 * joined (a Practice human who never sat down, a Bot never seated) has nothing to leave there: only their binding's
 * membership ends, so that is no rejection. Returns the accepted events, or the rejection that stopped it.
 */
export function standUpAndLeave(game: CashGame, participantId: ParticipantId): CashGameResult {
  const seated = game.forParticipant(participantId).getView().state.participants.find(participant => participant.participantId === participantId)?.seat != null;
  const stood = seated ? game.standUpParticipant(participantId) : undefined;
  if (stood && !stood.ok) return stood;
  const left = game.leaveTable(participantId);
  if (!left.ok && left.rejection.code !== 'participant-not-joined') return left;
  return { ok: true, events: [...(stood?.events ?? []), ...(left.ok ? left.events : [])] };
}
