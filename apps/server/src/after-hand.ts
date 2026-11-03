import { afterHandRequestStrength, type AfterHandRequest, type AfterHandRequestKind, type ApplicationRejection, type ObservableCashGameState, type ParticipantId, type PokerMutationRequest, type RemoveParticipantRequest, type ServerTime, type SetSittingOutRequest, type TableSchedule } from '@poker/contracts';
import type { CashGame, CashGameEvent, CashGameResult } from '@poker/engine';
import { isBot, isHuman, type PersistedBinding, type PersistedTableSession } from './aggregate.js';
import type { PokerMutationKind } from './permissions.js';
import { reject } from './rejections.js';
import { beforePayoutEnd } from './schedule.js';

/**
 * After-Hand Requests. A change to a Participant that the table cannot make while a Hand is in progress is
 * recorded in the Persisted Table Session instead (`pendingChanges`), shown to everyone in the table view, and
 * applied together, in one committed transition, once the Hand's payout phase ends. That transition runs before
 * Deal is accepted (Practice) and before the pause between Hands begins (Online).
 *
 * The model is a list of `{ participantId, change }` with at most one entry per Participant. A stronger
 * request replaces a weaker one in place; a weaker or equal request changes nothing. Which requests wait for the
 * Hand, and how each applies, is all here (`duringHand`, `afterHandRequestFor`, `applyAfterHandRequests`). A new kind
 * of request also needs its strength in contracts (`afterHandRequestStrength`), which the Trainer reads, and the
 * Trainer's own labels and availability (`self-service.ts`, `owner-controls.ts`).
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

/** The After-Hand Request a request becomes during a Hand, or `undefined` when it never waits for one. */
export function afterHandRequestFor(kind: PokerMutationKind, request: PokerMutationRequest): AfterHandRequestKind | undefined {
  if (kind === 'stand-up-participant') return 'stand-up';
  if (kind === 'leave-table') return 'leave-table';
  if (kind === 'remove-participant' || kind === 'remove-bot') return 'remove';
  if (kind === 'set-sitting-out' && (request as SetSittingOutRequest).sittingOut === true) return 'sit-out';
  return undefined;
}

/** The poker mutations that manage a Participant or the table between Hands, which a Hand in progress affects. */
const managementKinds: ReadonlySet<PokerMutationKind> = new Set(['stand-up-participant', 'move-participant', 'set-sitting-out', 'top-up-to', 'set-button', 'leave-table', 'remove-participant', 'remove-bot']);

/**
 * What a human's request that manages a Participant becomes while a Hand is in progress (being played, or its payout
 * being presented), judged on the table's public `state`. `undefined`: it proceeds normally. A rejection: the table
 * refuses it until the Hand ends, as CashGame does mid-Hand. `pending`: the After-Hand Requests with this one recorded.
 *
 * A human's own sit-out, Stand Up and Leave Table, and the owner's Removal of a Guest, wait for the Hand; so do the
 * owner's sit-out and removal of a seated Bot. A Participant without a Seat has nothing at stake and leaves at once,
 * and so does a Bot without one. Removal waits whether or not the Guest has a Seat, and outranks any weaker request.
 */
export function duringHand(state: ObservableCashGameState, aggregate: PersistedTableSession, kind: PokerMutationKind, target: PersistedBinding | undefined, request: PokerMutationRequest, now: ServerTime): { rejection: ApplicationRejection } | { pending: readonly AfterHandRequest[] } | undefined {
  if (!managementKinds.has(kind) || !handInProgress(state.status, aggregate.schedule, now)) return undefined;
  const mine = target ? state.participants.find(participant => participant.participantId === target.participantId) : undefined;
  if (kind === 'remove-participant') return { pending: recordAfterHandRequest(aggregate.pendingChanges, (request as RemoveParticipantRequest).participantId, 'remove') };
  if ((kind === 'remove-bot' || kind === 'leave-table') && mine?.seat == null) return undefined;
  // The owner can ask for a Bot's sit-out or removal now too; everything else about a Bot waits for the Hand.
  const change = isHuman(target) || isBot(target) && (kind === 'set-sitting-out' || kind === 'remove-bot') ? afterHandRequestFor(kind, request) : undefined;
  if (!target || !change) return { rejection: reject('active-hand', 'Manage Participants between Hands.') };
  if (mine?.seat == null) return { rejection: { ok: false, rejection: { code: 'participant-not-seated', message: 'Choose a seated Participant.', field: 'participantId' } } };
  if (kind === 'set-sitting-out' && mine.sittingOut) return { rejection: reject('sitting-out-unchanged', 'This Participant already has the requested sitting-out status.') };
  return { pending: recordAfterHandRequest(aggregate.pendingChanges, target.participantId, change) };
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
