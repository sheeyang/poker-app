import { createStrategy, isSupportedStrategy, immutableData, type Strategy } from '@poker/strategies';
import type { JobRunner, JobHandle } from './job-runner.js';
import { and, eq } from 'drizzle-orm';
import { createHash, randomUUID } from 'node:crypto';
import { CashGame, deriveSeed, type CashGameEvent, type CashGameResult } from '@poker/engine';
import { defaultTrainerConfiguration, onlineTableCapacity, type ActionWindow, type ObservableGameView, type ApplicationRejection, type ConcreteAction, type JoinLinkPreview, type JoinOutcome, type JoinTableRequest, type LeaveTableRequest, type SavedTable, type TableMode, type StrategyDescriptor, type SetPlayingStrategyRequest, type SetTrainerConfigurationRequest, type RetryBotRequest, type SetTableOptionsRequest, type SetTablePasswordRequest, type AddBotRequest, type RemoveBotRequest, type ActRequest, type MutationOutcome, type TableLiveMessage, type TableRuntimeStatus, type PokerMutationRequest, type SeatParticipantRequest, type StandUpParticipantRequest, type RemoveParticipantRequest, type MoveParticipantRequest, type SetSittingOutRequest, type TopUpToRequest, type SetButtonRequest } from '@poker/contracts';
import { findBinding, humanBindings, isBot, isHuman, memberBinding, placesTaken, upgradeTableSession, type PersistedBotBinding, type PersistedTableSession, type BotActionProvenance, type StoredTableSession } from './aggregate.js';
import type { openDatabase } from './db/database.js';
import { creationRequests, localUsers, processedRequests, tableSessions } from './db/schema.js';
import { currentTable, membership, savedTableEntries, storedOnlineTable, writeTableSession } from './membership.js';
import { createGuestQueue, type GuestQueue } from './guest-queue.js';
import { projectConfiguration, projectOptions, projectTableSession, projectTableUpdate, recordedConfiguration } from './projection.js';
import { createTableRegistry, type TableHandle } from './table-registry.js';
import { CommitOutcomeUnknown } from './creation.js';
import type { AcceptanceTransactions, AcceptanceFaults } from './db/acceptance.js';
import { canonical } from './canonical.js';
import { executeStrategy } from './strategy-execution.js';
import type { FrozenEvaluationInput } from './analysis.js';
import type { FrozenScoreSummary } from './summaries.js';
import { nameKey, participantName, participantNameRules, validateTableOptionChanges, validateTrainerConfiguration } from './validation.js';
import { systemClock, type ServerClock } from './clock.js';
import { announceNextHand, beforeActionWindow, beforePayoutEnd, emptySchedule, nextWakeAt, pastActionDeadline, scheduleTransition, withoutNextHand, type CurrentDecision } from './schedule.js';
import { applyAfterHandRequests, duringHand, handInProgress, recordAfterHandRequest, standUpAndLeave } from './after-hand.js';
import { canDeal, dealingStep, stillDisconnected, type DealingParticipant } from './automatic-dealing.js';
import { humanMutationDenial, malformedPokerRequest, type PokerMutationKind } from './permissions.js';
import { currentTableElsewhere, liveAnalysisDisallowed as liveAnalysisRefused, notFound, ownerRequired, reject, requestIdConflict, tableFull, tablePasswordRequired, unavailableOnline, wrongTablePassword } from './rejections.js';
import { hashTablePassword, tablePasswordMatches, tablePasswordProblem } from './table-password.js';

/** Accepts a derived job result for a human Participant inside its table's FIFO. */
export type AcceptTableJobResult = (tableSessionId: string, participantId: string, accept: () => boolean) => Promise<boolean>;
type Database = ReturnType<typeof openDatabase>['db'];
type CommittedSession = { aggregate: PersistedTableSession; game: CashGame };
export class TableSessionRestorationError extends Error {
  constructor() { super('The complete committed Table Session could not be restored.'); }
}
export type { PokerMutationKind } from './permissions.js';
/** Internal controller authority. No browser route receives this capability. */
export interface TableSessionControllerCommands {
  submitAction(tableSessionId: string, request: ActRequest): Promise<MutationOutcome>;
  readPersistedSession(tableSessionId: string): Promise<PersistedTableSession | undefined>;
  /** Read-only: the IDs of the tables in memory now, for what the API cannot show. */
  loadedTables(): readonly string[];
}
/**
 * Work a table has scheduled for itself, each piece holding a handle on the table while it exists: its next wake-up
 * (an Action Window opening as a Presentation Phase ends, an Action Deadline, a payout or pause ending, a Next-Hand
 * Countdown), a Bot decision being computed, After-Hand Requests waiting to be applied, and the recovery of a commit
 * whose outcome is unknown.
 */
type ScheduledWork = 'wake' | 'bot-decision' | 'after-hand' | 'recovery';
/** A live subscription to a table, which holds a handle on the table until it ends. */
interface Subscriber { readonly userId: string; readonly publish: (update: TableLiveMessage) => void; readonly handle: TableHandle }
/**
 * A human request carries the server time it was received, which decides Action Window and Action Deadline
 * timing. `server` is the scheduler itself: it submits Timeout Actions for whoever holds the expired decision.
 */
type MutationAuthority = { kind: 'human'; userId: string; receivedAt: number } | { kind: 'bot'; identity?: BotIdentity } | { kind: 'server' };
interface AcceptedHumanIntent { readonly participantId: string; readonly decisionId: string; readonly fingerprint: string }
/** Test-only hooks wrap real PostgreSQL transactions and receive no mutable state. */
export interface MutationTransactionFaults extends AcceptanceFaults {
  readonly beforeCommit?: (context: { readonly tableSessionId: string; readonly requestId: string }) => Promise<void>;
  readonly afterCommit?: (context: { readonly tableSessionId: string; readonly requestId: string }) => Promise<void>;
}
/**
 * The table's public facts (status, Seats, stacks, sitting out, the Observable Game Configuration), the same from every
 * Participant's view. They are read from the owner's view, as the owner is always the first binding: the one place
 * the server reads table-wide facts through a Participant's projection.
 */
function publicView(game: CashGame, aggregate: PersistedTableSession) {
  return game.forParticipant(aggregate.bindings[0]!.participantId).getView();
}
/** The public state of the committed table. */
const tableState = (session: CommittedSession) => publicView(session.game, session.aggregate).state;
/** The Observable Game Configuration as it stands now: the seat-change permission can change between Hands. */
const tableConfiguration = (session: CommittedSession) => publicView(session.game, session.aggregate).configuration;
/** Ends a seated Participant's sit-out between Hands; `undefined` when there is nothing to resume. */
function resumeFromSittingOut(game: CashGame, participantId: string): CashGameResult | undefined {
  const { state } = game.forParticipant(participantId).getView();
  const participant = state.participants.find(candidate => candidate.participantId === participantId);
  return state.status !== 'active-hand' && participant?.seat != null && participant.sittingOut ? game.setSittingOut(participantId, false) : undefined;
}
/**
 * The Action Time Limit, in ms, that gives this Participant's Action Window an Action Deadline: only a human's,
 * and only under the table's limit, which every Online Table has. Bots never have one.
 */
function actionTimeLimitMs(aggregate: PersistedTableSession, participantId: string): number | undefined {
  const seconds = aggregate.options.actionTimeLimitSeconds;
  return seconds !== null && isHuman(findBinding(aggregate, participantId)) ? seconds * 1000 : undefined;
}
/**
 * Whether a human's Action Window opening now captures Live Analysis as disallowed: the table's Allow Live Analysis
 * at that moment. Bots have no Live Analysis.
 */
function liveAnalysisDisallowed(aggregate: PersistedTableSession, participantId: string): true | undefined {
  return !aggregate.options.allowLiveAnalysis && isHuman(findBinding(aggregate, participantId)) ? true : undefined;
}
/**
 * The decision current after a transition that produced `events` on `game`, with its Action Deadline, if any, and
 * the table's Allow Live Analysis, which its window captures.
 */
function decisionAfter(aggregate: PersistedTableSession, game: CashGame, events: readonly CashGameEvent[]): CurrentDecision {
  const handEvent = events.findLast(event => 'handId' in event);
  const hand = handEvent && 'handId' in handEvent ? game.getHand(handEvent.handId) : undefined;
  return hand?.actorId && hand.decisionId ? { participantId: hand.actorId, decisionId: hand.decisionId, actionTimeLimitMs: actionTimeLimitMs(aggregate, hand.actorId), liveAnalysisDisallowed: liveAnalysisDisallowed(aggregate, hand.actorId) } : null;
}
/**
 * Whether a human act received at `receivedAt` is late: it is for the current window and arrived after its
 * Action Deadline, or it was aimed at the decision a Timeout Action has since closed.
 */
function missedActionDeadline(aggregate: PersistedTableSession, request: ActRequest, receivedAt: number): boolean {
  const timedOut = aggregate.timedOutWindow;
  return pastActionDeadline(aggregate.schedule.actionWindow, request.participantId, receivedAt)
    || timedOut?.pokerRevision === request.expectedPokerRevision && pastActionDeadline(timedOut, request.participantId, receivedAt);
}
/** Scheduled work that could not be saved (a Timeout Action, a step of Automatic Dealing) is tried again after this long. */
const timeoutRetryMs = 1000;
/** A request ID the scheduler may not reuse: its attempt proved never to have committed, or the table has moved on. */
const retiredRequestId = (outcome: MutationOutcome) => !outcome.ok && ['commit-not-applied', 'request-id-conflict'].includes(outcome.rejection.code);
/** How many derived request IDs (`<id>`, `<id>:2`…) scheduled work tries before it waits for its next wake-up. */
const derivedRequestAttempts = 8;
const derivedRequestId = (base: string, attempt: number) => base + (attempt > 1 ? ':' + attempt : '');
type Transaction = Parameters<Parameters<AcceptanceTransactions['run']>[2]>[0];
/** What a table request's transaction decided: its outcome and, when it changes the table, the session it commits. */
interface TableDecision<O> { readonly outcome: O; readonly next?: CommittedSession }
type BotIdentity = Omit<BotActionProvenance, 'commandIndex'> & { readonly tableSessionId: string; readonly pokerRevision: number };
export interface BotRuntimeOptions {
  readonly runner: JobRunner;
  readonly automaticBots?: boolean;
  readonly adminMode?: boolean;
  readonly strategyFactory?: (descriptor: StrategyDescriptor) => Strategy;
  readonly supportsStrategy?: (descriptor: unknown) => boolean;
  readonly onHumanActionAccepted?: (input: FrozenEvaluationInput) => unknown | Promise<unknown>;
}
export function createTableSessionMutations(db: Database, acceptance: AcceptanceTransactions, faults?: MutationTransactionFaults, bots?: BotRuntimeOptions, clock: ServerClock = systemClock, guests: GuestQueue = createGuestQueue()) {
  /** The only way to reach a table in memory: each committed table, while something needs it (ADR-0035). */
  const tables = createTableRegistry<CommittedSession>({ clock, load: loadTable, loaded: tableLoaded, drain: drained, unloaded: tableUnloaded });
  /** One pending wake-up per table, at its schedule's next instant (`nextWakeAt`). */
  const wakes = new Map<string, { at: number; cancel: () => void }>();
  const queue = new Map<string, Promise<unknown>>();
  const recovering = new Set<string>();
  /** The handle each piece of a table's scheduled work holds on it. */
  const scheduledHolds = new Map<string, Map<ScheduledWork, TableHandle>>();
  // Only this live process remembers an unproven candidate; restart creates no analysis obligation.
  const uncertainHumanActions = new Map<string, AcceptedHumanIntent>();
  const actionKey = (id: string, requestId: string) => JSON.stringify([id, requestId]);
  const subscribers = new Map<string, Set<Subscriber>>();
  /** The connected Participants last published per Online Table, so each change of who is connected is published once. */
  const presence = new Map<string, string>();
  const statuses = new Map<string, TableRuntimeStatus['status']>();
  /** The Hand in which an Online Bot's failure is being shown: it stays shown until that Hand is over. */
  const failedHands = new Map<string, string>();
  const work = new Map<string, { identity: BotIdentity; attempt: number; handle?: JobHandle<ConcreteAction> }>();
  let stopped = false;
  let recoveryTimer: ReturnType<typeof setInterval> | undefined;
  const scheduledRecovery = new Set<string>();
  const strategyFactory = bots?.strategyFactory ?? createStrategy;
  const supportsStrategy = bots?.supportsStrategy ?? isSupportedStrategy;
  /**
   * Runs `operation` in the table's FIFO. Queued work on a loaded table holds a handle on it until it has run. Never
   * acquire a table from inside its own FIFO: an unload waits for that FIFO, and an acquire waits for the unload.
   */
  function enqueue<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const handle = tables.retain(id);
    const previous = queue.get(id) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(operation);
    queue.set(id, next);
    return next.finally(() => { if (queue.get(id) === next) queue.delete(id); handle?.release(); });
  }
  /** Settles once the table's FIFO is empty: an unload waits for its queued work. */
  async function drained(id: string): Promise<void> {
    for (let pending = queue.get(id); pending; pending = queue.get(id)) await pending.catch(() => undefined);
  }
  /** Holds a handle on the table for one kind of its scheduled work while `needed`, and releases it once not. */
  function holdWhile(id: string, work: ScheduledWork, needed: boolean) {
    const holds = scheduledHolds.get(id);
    const held = holds?.get(work);
    if (needed && !held) {
      const handle = tables.retain(id);
      if (!handle) return;
      if (holds) holds.set(work, handle); else scheduledHolds.set(id, new Map([[work, handle]]));
    } else if (!needed && held) {
      holds!.delete(work);
      if (!holds!.size) scheduledHolds.delete(id);
      held.release();
    }
  }
  /** Makes `session` the loaded table's committed copy, as each commit and each recovery does. */
  function promote(id: string, session: CommittedSession) {
    tables.set(id, session);
    holdWhile(id, 'after-hand', session.aggregate.pendingChanges.length > 0);
  }
  function capture(session: CommittedSession, evaluationRequestId: string) {
    for (const binding of session.aggregate.bindings) {
      if (!isBot(binding) || binding.removed) continue;
      const view = session.game.forParticipant(binding.participantId).getView();
      if (view.state.actorId !== binding.participantId || !view.state.handId || !view.state.decisionId) continue;
      const masterSeed = session.aggregate.pokerRecord.configuration.seed;
      const identity: BotIdentity = immutableData({ tableSessionId: session.aggregate.tableSessionId, pokerRevision: session.aggregate.pokerRevision,
        participantId: binding.participantId, handId: view.state.handId, decisionId: view.state.decisionId,
        playingStrategy: binding.controller.playingStrategy, assignmentId: binding.assignmentId ?? 'initial:' + binding.participantId,
        evaluationSeed: deriveSeed(masterSeed, 'policy', binding.participantId, view.state.decisionId),
        selectionSeed: deriveSeed(masterSeed, 'selector', binding.participantId, view.state.decisionId),
        inputFingerprint: createHash('sha256').update(canonical(view)).digest('hex'), evaluationRequestId,
      });
      return { identity, view };
    }
    return undefined;
  }
  function current(id: string, identity: BotIdentity): boolean {
    if (stopped || recovering.has(id) || work.get(id)?.identity.evaluationRequestId !== identity.evaluationRequestId) return false;
    const session = tables.get(id);
    const fresh = session && capture(session, identity.evaluationRequestId);
    return !!fresh && canonical(fresh.identity) === canonical(identity);
  }
  function retire(id: string) { const prior = work.get(id); work.delete(id); prior?.handle?.cancel(); holdWhile(id, 'bot-decision', false); }
  function pause(id: string) {
    const fresh = !recovering.has(id);
    recovering.add(id); retire(id); holdWhile(id, 'recovery', true);
    if (fresh || statuses.get(id)?.phase !== 'recovering') publishStatus(id, { phase: 'recovering' });
  }
  async function reconcile(id: string): Promise<boolean> {
    const attempts = (await acceptance.attempts()).filter(entry => entry.tableSessionId === id);
    const acceptedHumans: { key: string; intent: AcceptedHumanIntent }[] = [];
    let pending = false;
    for (const attempt of attempts) {
      const status = await acceptance.status(attempt);
      if (status === 'pending') { pending = true; continue; }
      const key = actionKey(id, attempt.requestId);
      if (status === 'noncommit') { uncertainHumanActions.delete(key); continue; }
      if (status === 'committed') {
        // The transaction oracle and its outcome are intentionally distinct snapshots.
        const rows = attempt.kind === 'table'
          ? await db.select().from(processedRequests).where(and(eq(processedRequests.tableSessionId, id), eq(processedRequests.requestId, attempt.requestId)))
          : await db.select().from(creationRequests).where(and(eq(creationRequests.userId, attempt.id), eq(creationRequests.requestId, attempt.requestId)));
        if (!rows[0] || rows[0].fingerprint !== attempt.fingerprint) { pending = true; continue; }
        // Refreshing replaces game, revisions, bindings, assignments and provenance together.
        await refresh(id);
        const intent = uncertainHumanActions.get(key);
        if (intent && rows[0].fingerprint === intent.fingerprint && rows[0].outcome.ok) acceptedHumans.push({ key, intent });
        else uncertainHumanActions.delete(key);
        await acceptance.forget(attempt).catch(() => {});
      }
    }
    if (pending) { pause(id); return false; }
    if (recovering.has(id)) {
      await refresh(id);
      retire(id); recovering.delete(id);
      publishCommitted(id); publishStatus(id, { phase: 'idle' });
      const session = tables.get(id); if (session) await runSchedule(id, session, true);
      holdWhile(id, 'recovery', false);
    }
    const session = tables.get(id);
    for (const { key, intent } of acceptedHumans) {
      uncertainHumanActions.delete(key);
      if (session) analyzeAccepted(session, intent.participantId, intent.decisionId);
    }
    return true;
  }
  async function resolveRequest(id: string, requestId: string, fingerprint: string): Promise<MutationOutcome | undefined> {
    const attempt = await acceptance.find({ kind: 'table', id, requestId });
    if (attempt && attempt.fingerprint !== fingerprint) return requestIdConflict();
    if (attempt) {
      const status = await acceptance.status(attempt);
      if (status === 'pending') { pause(id); throw new CommitOutcomeUnknown('The earlier transaction remains unresolved.'); }
      if (status === 'noncommit') { await reconcile(id); return reject('commit-not-applied', 'The attempt did not commit. Submit a new requestId to deliberately try again.'); }
      pause(id);
    }
    if (recovering.has(id)) await reconcile(id);
    const rows = await db.select().from(processedRequests).where(and(eq(processedRequests.tableSessionId, id), eq(processedRequests.requestId, requestId)));
    if (rows[0]) return rows[0].fingerprint === fingerprint ? rows[0].outcome : requestIdConflict();
    if (attempt || recovering.has(id)) return reject('session-recovering', 'This Table Session is paused while a commit outcome is unknown.');
  }
  async function startRecovery() {
    for (const attempt of await acceptance.attempts()) if (attempt.state === 'pending' && attempt.tableSessionId) pause(attempt.tableSessionId);
    recoveryTimer = setInterval(() => {
      if (stopped) return;
      for (const id of recovering) {
        if (scheduledRecovery.has(id)) continue;
        scheduledRecovery.add(id);
        void enqueue(id, () => reconcile(id)).catch(() => {}).finally(() => scheduledRecovery.delete(id));
      }
    }, 100);
    recoveryTimer.unref();
  }
  /**
   * Brings a table up to date with its committed schedule. It runs in the table FIFO, after every commit and
   * restore and at each wake-up: it wakes the table again at the schedule's next instant, then requests the
   * current Bot decision once its Action Window is open. Later scheduled work (after-Hand transitions,
   * Next-Hand Countdowns) belongs here, keyed off `nextWakeAt`.
   *
   * Due work that commits runs first, by calling `accept` directly (never `submit`/`enqueue`, which would wait
   * on this FIFO turn), and that commit runs `runSchedule` again. Such work handles its own failures, so the
   * commit that called `runSchedule` keeps its outcome. An Action Deadline that has passed, including
   * during an outage, resolves as its Timeout Action here (`timeOut`), before any further action is accepted:
   * a human's late act is rejected with `action-deadline-passed` whichever runs first.
   *
   * The end of a Hand's payout phase (`payoutEndsAt`) is one of those wake-ups: it fires here, in the FIFO,
   * and `loadScheduledTables` reaches it after a restart. Deal itself is gated by the clock alone (`beforePayoutEnd`
   * in `accept`). The work that must happen when the Hand ends runs from here once
   * `payoutEndsAt(schedule) <= clock.now()`: applying the after-Hand requests (`settleAfterHand`), queued as
   * its own FIFO task. `accept` runs the same step first, so a request that arrives ahead of this wake-up
   * still sees them applied.
   *
   * At an Online Table, Automatic Dealing (`dealNextHand`) follows: once the pause between Hands has ended and
   * the after-Hand requests are applied, a Next-Hand Countdown is announced if the table can deal, and an expired
   * countdown runs its recheck, including one that expired during an outage. A connection change runs the
   * schedule too, since it can let the table deal.
   */
  async function runSchedule(id: string, session: CommittedSession, forceBot = false): Promise<void> {
    if (stopped || recovering.has(id)) return;
    const window = session.aggregate.schedule.actionWindow;
    if (window && pastActionDeadline(window, window.participantId, clock.now())) { await timeOut(id, window); return; }
    try { if (await dealNextHand(id)) return; }
    catch (error) { if (!(error instanceof CommitOutcomeUnknown) && !stopped) wake(id, clock.now() + timeoutRetryMs); return; }
    wake(id, nextWakeAt(session.aggregate.schedule, clock.now()));
    if (afterHandDue(session)) void enqueue(id, () => settleAfterHand(id)).catch(() => {});
    ensureBot(id, session, forceBot);
  }
  /** Whether the Hand has ended (its payout phase is over) with after-Hand requests still waiting to be applied. */
  function afterHandDue(session: CommittedSession): boolean {
    const { aggregate } = session;
    if (!aggregate.pendingChanges.length) return false;
    const { status } = tableState(session);
    return !handInProgress(status, aggregate.schedule, clock.now());
  }
  /**
   * Applies every after-Hand request in one committed transition once the Hand's payout phase has ended, and
   * clears them in the same transaction: one poker revision step for all engine commands, one session revision
   * step. Runs in the table FIFO (from `runSchedule`, or at the start of `accept`), so a Deal can never be
   * accepted ahead of it. Idempotent: it does nothing unless requests are pending, its request ID derives from
   * the session revision they were pending at, and a restart finds the requests still pending or already gone.
   *
   * At an Online Table the pause between Hands is already in the schedule (it follows the payout phase), and
   * Automatic Dealing announces no Next-Hand Countdown while requests are pending, so this transition always
   * comes first, including the sit-outs that Timeout Actions queue.
   */
  async function settleAfterHand(id: string): Promise<void> {
    await commitScheduled(id, session => {
      if (!afterHandDue(session)) return undefined;
      const { aggregate } = session;
      const working = session.game.fork();
      const applied = applyAfterHandRequests(working, aggregate.pendingChanges);
      const next: PersistedTableSession = { ...aggregate, sessionRevision: aggregate.sessionRevision + 1, pendingChanges: [],
        ...(applied.events.length ? { pokerRecord: working.toRecord(), pokerRevision: aggregate.pokerRevision + 1 } : {}),
        bindings: aggregate.bindings.map(binding => isHuman(binding) && applied.left.includes(binding.participantId) ? { ...binding, membership: 'left' as const }
          : isHuman(binding) && applied.removed.includes(binding.participantId) ? { ...binding, membership: 'left' as const }
          : isBot(binding) && applied.removed.includes(binding.participantId) ? { ...binding, removed: true as const } : binding) };
      return { requestId: 'after-hand:' + aggregate.sessionRevision, fingerprint: createHash('sha256').update('after-hand-v1:' + canonical({ changes: aggregate.pendingChanges })).digest('hex'),
        events: applied.events, next: { aggregate: next, game: working } };
    });
  }
  /**
   * Plays the Timeout Action of an Action Window whose deadline has passed: Check when it is legal, otherwise
   * Fold, as an ordinary accepted act for that Participant. Its request ID derives from the decision, so timers,
   * retries and restarts resolve to one outcome. Only an attempt proven never to have committed retires its ID
   * (`commit-not-applied`, or `request-id-conflict` once the table has moved on), and a further derived ID takes
   * over. A Timeout Action that could not be saved is tried again shortly; an unknown COMMIT pauses the table,
   * whose recovery runs the schedule again.
   */
  async function timeOut(id: string, window: ActionWindow) {
    for (let attempt = 1; attempt <= derivedRequestAttempts; attempt++) {
      const session = tables.get(id);
      if (!session || stopped || recovering.has(id)) return;
      const { state } = session.game.forParticipant(window.participantId).getView();
      if (state.actorId !== window.participantId || state.decisionId !== window.decisionId) return;
      const action: ConcreteAction = state.legalActions.some(legal => legal.type === 'check') ? { type: 'check' } : { type: 'fold' };
      const requestId = derivedRequestId('timeout:' + window.decisionId, attempt);
      let outcome: MutationOutcome;
      try { outcome = await accept(id, { kind: 'server' }, 'act', { requestId, expectedPokerRevision: session.aggregate.pokerRevision, participantId: window.participantId, action }); }
      catch (error) { if (!(error instanceof CommitOutcomeUnknown) && !stopped) wake(id, clock.now() + timeoutRetryMs); return; }
      if (!retiredRequestId(outcome)) return;
    }
  }
  /** Every Participant at the table as Automatic Dealing judges them, with who is connected now. */
  function dealingParticipants(id: string, session: CommittedSession, state = tableState(session)): DealingParticipant[] {
    const connected = new Set(connectedParticipants(id, session));
    return state.participants.map(p => ({ participantId: p.participantId, seat: p.seat, stack: p.stack, sittingOut: p.sittingOut, human: isHuman(findBinding(session.aggregate, p.participantId)), connected: connected.has(p.participantId) }));
  }
  /**
   * Automatic Dealing, at Online Tables only (`automatic-dealing.ts`). Announcing a Next-Hand Countdown is a
   * committed schedule change (`countdown:<session revision>`). At its expiry one committed transition sits out the
   * humans still disconnected and then either deals (`deal:<Hand ID>`, from the Hand sequence) or cancels the
   * countdown (`no-deal:<session revision>`). Returns whether it committed, in which case that commit has already
   * run the schedule again.
   */
  async function dealNextHand(id: string): Promise<boolean> {
    return commitScheduled(id, session => {
      const { aggregate } = session;
      if (aggregate.mode !== 'online') return undefined;
      const state = tableState(session);
      const participants = dealingParticipants(id, session, state);
      const now = clock.now();
      const step = dealingStep({ status: state.status, schedule: aggregate.schedule, pendingChanges: aggregate.pendingChanges.length, participants }, now);
      const fingerprint = (contents: object) => createHash('sha256').update('next-hand-v2:' + canonical({ sessionRevision: aggregate.sessionRevision, ...contents })).digest('hex');
      if (step === 'announce') return { requestId: 'countdown:' + aggregate.sessionRevision, fingerprint: fingerprint({ step }), events: [],
        next: { aggregate: { ...aggregate, sessionRevision: aggregate.sessionRevision + 1, schedule: announceNextHand(aggregate.schedule, now) }, game: session.game } };
      if (step !== 'expire') return undefined;
      // Humans still disconnected are sat out first; resuming is theirs to ask for.
      const working = session.game.fork();
      const disconnected = stillDisconnected(participants);
      const events: CashGameEvent[] = disconnected.flatMap(participantId => { const result = working.setSittingOut(participantId, true); return result.ok ? result.events : []; });
      const dealt = canDeal(participants) ? working.startHand() : undefined;
      const started = dealt?.ok ? dealt.events.find(event => event.type === 'hand-started') : undefined;
      if (dealt?.ok) events.push(...dealt.events);
      const schedule = started ? scheduleTransition(withoutNextHand(aggregate.schedule), events, decisionAfter(aggregate, working, events), now, { pauseBetweenHands: true }) : withoutNextHand(aggregate.schedule);
      const next: PersistedTableSession = { ...aggregate, sessionRevision: aggregate.sessionRevision + 1, schedule, ...(events.length ? { pokerRecord: working.toRecord(), pokerRevision: aggregate.pokerRevision + 1 } : {}) };
      return { requestId: started && 'handId' in started ? 'deal:' + started.handId : 'no-deal:' + aggregate.sessionRevision, fingerprint: fingerprint({ step, sittingOut: disconnected, deal: !!started }), events, next: { aggregate: next, game: working } };
    });
  }
  /**
   * Commits a transition the scheduler makes by itself, planned from the committed table inside its FIFO turn. Its
   * request ID derives from the table's state, so retries and restarts resolve to one outcome; only an attempt
   * proven never to have committed retires it, and a further derived ID (`:2`, `:3`…) takes over. After COMMIT the
   * transition is published and the schedule runs again. Returns whether this call committed.
   */
  async function commitScheduled(id: string, plan: (session: CommittedSession) => { requestId: string; fingerprint: string; next: CommittedSession; events: readonly CashGameEvent[] } | undefined): Promise<boolean> {
    for (let attempt = 1; attempt <= derivedRequestAttempts; attempt++) {
      const session = tables.get(id);
      if (!session || stopped || recovering.has(id)) return false;
      const transition = plan(session);
      if (!transition) return false;
      const requestId = derivedRequestId(transition.requestId, attempt);
      const known = await resolveRequest(id, requestId, transition.fingerprint);
      if (known && retiredRequestId(known)) continue;
      // A remembered outcome means it applied; a table restored meanwhile is planned again by its own schedule run.
      if (known || tables.get(id) !== session) return false;
      const { next } = transition;
      const { outcome, committed: written } = await commitTableRequest(id, requestId, transition.fingerprint, session.aggregate, () => ({ next,
        outcome: { ok: true, tableSessionId: id, pokerRevision: next.aggregate.pokerRevision, sessionRevision: next.aggregate.sessionRevision } }));
      if (!written) { if (retiredRequestId(outcome)) continue; return false; }
      publishCommitted(id, transition.events);
      await runSchedule(id, written);
      return true;
    }
    return false;
  }
  /**
   * The one commit path of every table request, a Guest's or the scheduler's. In one transaction it replays the
   * outcome remembered for this request ID, or refuses its reuse for different contents. Otherwise `decide` judges the
   * request against the committed table, and its outcome is remembered and the session it stages, if any, written
   * (`writeTableSession`, with the membership index), all in one COMMIT. After COMMIT the staged session is the table's
   * committed state; publishing it and running the schedule are the caller's. `decided` tells whether `decide` ran
   * rather than a remembered outcome being replayed. An unconfirmed COMMIT pauses the table, and is rethrown.
   */
  async function commitTableRequest<O extends MutationOutcome>(id: string, requestId: string, fingerprint: string, previous: PersistedTableSession, decide: (tx: Transaction) => Promise<TableDecision<O>> | TableDecision<O>): Promise<{ outcome: O; committed?: CommittedSession; decided: boolean }> {
    const context = { tableSessionId: id, requestId };
    let decision: TableDecision<O> | undefined;
    try {
      const outcome = await acceptance.run({ kind: 'table', id, requestId }, fingerprint, async (tx): Promise<O> => {
        const rows = await tx.select().from(processedRequests).where(and(eq(processedRequests.tableSessionId, id), eq(processedRequests.requestId, requestId)));
        if (rows[0]) return (rows[0].fingerprint === fingerprint ? rows[0].outcome : requestIdConflict()) as O;
        const decided = await decide(tx);
        if (decided.next) await writeTableSession(tx, previous, decided.next.aggregate);
        await tx.insert(processedRequests).values({ tableSessionId: id, requestId, fingerprint, outcome: decided.outcome });
        decision = decided;
        return decided.outcome;
      }, { ...faults, beforeCommit: () => faults?.beforeCommit?.(context) ?? Promise.resolve(), afterCommit: () => faults?.afterCommit?.(context) ?? Promise.resolve() });
      const next = (decision as TableDecision<O> | undefined)?.next;
      if (next) promote(id, next);
      return { outcome, ...(next ? { committed: next } : {}), decided: !!decision };
    } catch (error) {
      if (error instanceof CommitOutcomeUnknown) pause(id);
      throw error;
    }
  }
  /** Wakes the table at `at`, replacing any other wake-up; `undefined` cancels it. A pending wake-up holds the table. */
  function wake(id: string, at: number | undefined) {
    const pending = wakes.get(id);
    if (pending?.at === at) return;
    pending?.cancel(); wakes.delete(id);
    if (at !== undefined) {
      const entry = { at, cancel: () => {} };
      wakes.set(id, entry);
      entry.cancel = clock.setTimer(at, () => {
        if (wakes.get(id) !== entry) return;
        wakes.delete(id);
        // The queued schedule run holds the table from here.
        if (!stopped) void enqueue(id, async () => { const session = tables.get(id); if (session) await runSchedule(id, session); }).catch(() => {});
        holdWhile(id, 'wake', wakes.has(id));
      });
    }
    holdWhile(id, 'wake', wakes.has(id));
  }
  /**
   * Requests the current Bot decision once its Action Window is open. `attempt` counts the requests for the same
   * decision at an Online Table, where a failed decision is retried once (`botFailed`).
   */
  function ensureBot(id: string, session: CommittedSession, force = false, attempt = 1) {
    if (stopped || recovering.has(id) || !bots || bots.automaticBots === false) return;
    const window = session.aggregate.schedule.actionWindow;
    // A Bot's decision is requested only once its Action Window opens; its wake-up comes back here.
    const proposed = window && clock.now() < window.opensAt ? undefined : capture(session, randomUUID());
    const prior = work.get(id);
    if (!force && prior && current(id, prior.identity)) return;
    retire(id);
    if (!proposed) {
      // An Online Bot failure stays shown until the Hand it happened in is over.
      const shown = failedHands.get(id) !== undefined && failedHands.get(id) === session.aggregate.schedule.phases[0]?.handId;
      if (statuses.has(id) && statuses.get(id)?.phase !== 'idle' && !shown) publishStatus(id, { phase: 'idle' });
      return;
    }
    const pending: { identity: BotIdentity; attempt: number; handle?: JobHandle<ConcreteAction> } = { identity: proposed.identity, attempt };
    work.set(id, pending);
    // Held until the decision's result has been handled; a failure kept on show at a Practice Table holds nothing.
    holdWhile(id, 'bot-decision', true);
    publishStatus(id, { phase: 'thinking', participantId: proposed.identity.participantId });
    pending.handle = bots.runner.submit('bot-decision', { view: proposed.view, descriptor: proposed.identity.playingStrategy, evaluationSeed: proposed.identity.evaluationSeed, selectionSeed: proposed.identity.selectionSeed }, async (input, execution) => {
      const { selectedAction } = await executeStrategy(strategyFactory(input.descriptor), input.view, { evaluationSeed: input.evaluationSeed, selectionSeed: input.selectionSeed, signal: execution.signal });
      return selectedAction;
    });
    void pending.handle.result.then(result => {
      if (stopped) return;
      return enqueue(id, async () => {
        if (!current(id, pending.identity)) return;
        if (!result.ok) { await botFailed(id, pending, result.code); return; }
        try {
          const outcome = await accept(id, { kind: 'bot', identity: pending.identity }, 'act', { requestId: 'bot:' + pending.identity.evaluationRequestId, expectedPokerRevision: pending.identity.pokerRevision, participantId: pending.identity.participantId, action: result.value });
          if (!outcome.ok && current(id, pending.identity)) await botFailed(id, pending, 'failed');
        } catch { if (current(id, pending.identity)) await botFailed(id, pending, 'persistence-unavailable'); }
      });
    }).catch(() => {}).finally(() => { if (work.get(id) === pending) holdWhile(id, 'bot-decision', false); });
  }
  /**
   * A Bot decision failed. At a Practice Table the failure is shown and recovery is the owner's: Retry, or another
   * Playing Strategy (ADR-0018). At an Online Table it is retried once with identical inputs and seeds (`capture`
   * derives them from the decision). If the retry fails too, the failure is shown to everyone at the table and the
   * server plays the Bot's Timeout Action, which also sits the Bot out after the Hand (see `accept`). Capacity is never
   * one of these failures: the JobRunner always admits a Bot decision and keeps a slot for it (`job-runner.ts`).
   */
  async function botFailed(id: string, pending: { identity: BotIdentity; attempt: number }, code: NonNullable<TableRuntimeStatus['status']['code']>) {
    const session = tables.get(id);
    const failure = { phase: 'failed' as const, participantId: pending.identity.participantId, code };
    if (session?.aggregate.mode !== 'online') { publishStatus(id, failure); return; }
    if (pending.attempt < 2) { ensureBot(id, session, true, pending.attempt + 1); return; }
    retire(id);
    publishStatus(id, failure);
    failedHands.set(id, pending.identity.handId);
    const window = session.aggregate.schedule.actionWindow;
    if (window?.decisionId === pending.identity.decisionId) await timeOut(id, window);
  }
  /** Every view, subscription and route is for the Guest's own joined, unremoved Participant. */
  function viewer(session: CommittedSession | undefined, userId: string) {
    return session && memberBinding(session.aggregate, userId)?.participantId;
  }
  function captureEvaluation(session: CommittedSession, participantId: string, decisionId: string): FrozenEvaluationInput | null {
    const binding = findBinding(session.aggregate, participantId);
    if (!isHuman(binding)) return null;
    const participant = session.game.forParticipant(participantId);
    const current = participant.getView();
    const accepted = current.history.flatMap(hand => hand.decisions).find(decision => decision.decisionId === decisionId && decision.action.participantId === participantId);
    let view: ObservableGameView;
    try { view = participant.getView({ at: { decisionId } }); } catch (error) { if (error instanceof RangeError) return null; throw error; }
    if (view.state.actorId !== participantId || !view.state.handId || !view.state.legalActions.length || !accepted && current.state.decisionId !== decisionId) return null;
    const masterSeed = session.aggregate.pokerRecord.configuration.seed;
    return immutableData({ view, ...(accepted ? { acceptedAction: accepted.action.action } : {}), identity: {
      tableSessionId: session.aggregate.tableSessionId, participantId, handId: view.state.handId, decisionId,
      referenceStrategy: binding.trainerConfiguration.referenceStrategy,
      inputFingerprint: createHash('sha256').update(canonical(view)).digest('hex'),
      evaluationSeed: deriveSeed(masterSeed, 'policy', participantId, decisionId),
      selectionSeed: deriveSeed(masterSeed, 'selector', participantId, decisionId),
      engineVersion: session.aggregate.pokerRecord.engineVersion, randomVersion: 'v1', evaluationVersion: 'v1',
    } });
  }
  function analyzeAccepted(session: CommittedSession, participantId: string, decisionId: string) {
    if (stopped || !bots?.onHumanActionAccepted) return;
    try {
      const input = captureEvaluation(session, participantId, decisionId);
      if (input?.acceptedAction) void Promise.resolve(bots.onHumanActionAccepted(input)).catch(() => {});
    } catch { /* Derived analysis cannot change a confirmed poker outcome. */ }
  }
  function deliver(id: string, projection: (session: CommittedSession, participantId: string) => TableLiveMessage) {
    const session = tables.get(id);
    const entries = subscribers.get(id);
    if (!session || !entries) return;
    // A dropped subscription no longer needs the table.
    const drop = (entry: Subscriber) => { entries.delete(entry); entry.handle.release(); };
    for (const entry of entries) {
      const participantId = viewer(session, entry.userId);
      if (!participantId) {
        // A Guest whose membership ended is told once, so their client leaves the table; anyone else is dropped silently.
        const ended = humanBindings(session.aggregate).some(binding => binding.userId === entry.userId && binding.membership === 'left');
        if (ended) try { entry.publish({ type: 'table-membership-ended', tableSessionId: id }); } catch { /* The subscriber is gone. */ }
        drop(entry); continue;
      }
      // A delivery failure cannot change a confirmed mutation's outcome.
      try { entry.publish(projection(session, participantId)); } catch { drop(entry); }
    }
    if (entries.size === 0) subscribers.delete(id);
  }
  function publishCommitted(id: string, events: readonly CashGameEvent[] = []) {
    const connected = connectedParticipants(id);
    // Every complete update carries who is connected, so it publishes the current list too.
    presence.set(id, connected.join(','));
    deliver(id, (session, participantId) => projectTableUpdate(session.aggregate, participantId, session.game, clock.now(), events, bots?.adminMode !== false, connected));
  }
  /**
   * The joined human Participants whose Guest has at least one live connection subscribed to the table. Transient:
   * never persisted, so after a restart every human counts as disconnected until they reconnect.
   */
  function connectedParticipants(id: string, session = tables.get(id)): string[] {
    const entries = subscribers.get(id);
    if (!session || !entries?.size) return [];
    const users = new Set([...entries].map(entry => entry.userId));
    return humanBindings(session.aggregate).filter(binding => binding.membership === 'joined' && users.has(binding.userId)).map(binding => binding.participantId);
  }
  /**
   * After a subscription starts or ends: at an Online Table, publishes a change of who is connected to everyone
   * subscribed, without a revision, and runs the schedule, since a connection can let the table deal. Practice
   * Tables have a single human, so their connection changes are not published.
   */
  function connectionChanged(id: string) {
    const session = tables.get(id);
    if (stopped || session?.aggregate.mode !== 'online') return;
    const connected = connectedParticipants(id, session);
    if (presence.get(id) === connected.join(',')) return;
    presence.set(id, connected.join(','));
    deliver(id, () => ({ type: 'table-presence', tableSessionId: id, connectedParticipantIds: connected }));
    void enqueue(id, async () => { const current = tables.get(id); if (current) await runSchedule(id, current); }).catch(() => {});
  }
  function publishStatus(id: string, status: TableRuntimeStatus['status']) {
    if (stopped) return;
    if (recovering.has(id) && status.phase !== 'recovering') return;
    if (status.phase !== 'failed') failedHands.delete(id);
    const failures: Record<NonNullable<TableRuntimeStatus['status']['code']>, string> = { capacity: 'The computation queue is full. Retry this Bot decision.', cancelled: 'Bot computation was cancelled. Retry this decision.', timeout: 'Bot computation timed out. Retry or change its Playing Strategy.', failed: 'Bot computation failed. Retry or change its Playing Strategy.', incompatible: 'This Playing Strategy does not support the current decision.', 'invalid-policy': 'The Policy returned an invalid distribution. Retry or change its Playing Strategy.', 'selection-failed': 'The Action Selector could not select a valid Choice.', 'persistence-unavailable': 'The Bot action could not be saved. Retry this decision.' };
    const code = status.code && Object.hasOwn(failures, status.code) ? status.code : 'failed';
    // At an Online Table nobody repairs a Bot mid-Hand: the server has already played its Timeout Action.
    const online = tables.get(id)?.aggregate.mode === 'online';
    const message = online ? 'This Bot’s decision failed twice, so the server played its Timeout Action. It sits out after this hand.' : failures[code];
    const safeStatus: TableRuntimeStatus['status'] = { phase: status.phase, ...(status.participantId ? { participantId: status.participantId } : {}),
      ...(status.phase === 'failed' ? { code, message } : status.phase === 'recovering' ? { message: 'This Table Session is paused while its commit outcome is unknown.' } : {}) };
    statuses.set(id, safeStatus);
    deliver(id, () => ({ type: 'table-status', tableSessionId: id, status: safeStatus }));
  }
  /** Membership from the loaded table when it is in memory, otherwise from the index, without loading the table. */
  async function access(id: string, userId: string): Promise<{ participantId: string; owner: boolean; mode: TableMode } | undefined> {
    const cached = tables.get(id);
    if (!cached) return membership(db, id, userId);
    const binding = memberBinding(cached.aggregate, userId);
    return binding && { participantId: binding.participantId, owner: cached.aggregate.ownerUserId === userId, mode: cached.aggregate.mode };
  }
  /**
   * A handle on a table for a request from a Guest who is joined at it, or `undefined`: anyone else cannot learn
   * that it exists. Membership is checked before loading, against the stored memberships when the table is not in
   * memory, so a request from anyone not at the table never loads it.
   */
  async function acquireMember(id: string, userId: string): Promise<TableHandle | undefined> {
    return await access(id, userId) ? tables.acquire(id) : undefined;
  }
  /**
   * Runs `operation` for a request from a Guest joined at the table, holding a handle on it while the request is
   * handled; `undefined` for anyone else.
   */
  async function asMember<T>(id: string, userId: string, operation: () => Promise<T>): Promise<T | undefined> {
    const handle = await acquireMember(id, userId);
    if (!handle) return undefined;
    try { return await operation(); } finally { handle.release(); }
  }
  /** Runs `operation` holding a handle on the table, loading it if needed; `undefined` when there is no such table. */
  async function holding<T>(id: string, operation: () => Promise<T>): Promise<T | undefined> {
    const handle = await tables.acquire(id);
    if (!handle) return undefined;
    try { return await operation(); } finally { handle.release(); }
  }
  /**
   * Loads a table from its record, for the registry. A table this process has not loaded may have an unresolved
   * acceptance journaled for it (an earlier process's, or a creation whose COMMIT went unconfirmed), so it is paused
   * until recovery proves the outcome. A loaded table needs no such check: every acceptance this process makes for it
   * pauses it itself when its COMMIT goes unconfirmed, and an attempt still in flight is not unresolved. Reads of a
   * loaded table therefore never wait on the journal.
   */
  async function loadTable(id: string): Promise<CommittedSession | undefined> {
    if (!recovering.has(id) && (await acceptance.attempts()).some(entry => entry.tableSessionId === id && entry.state === 'pending')) pause(id);
    return readCommitted(id);
  }
  /** A table has just been loaded: its scheduled work takes its handles, and its schedule runs. */
  function tableLoaded(id: string, session: CommittedSession) {
    holdWhile(id, 'recovery', recovering.has(id));
    holdWhile(id, 'after-hand', session.aggregate.pendingChanges.length > 0);
    if (!stopped) void enqueue(id, async () => { const current = tables.get(id); if (current) await runSchedule(id, current); }).catch(() => {});
  }
  /** A table has left memory: nothing it kept only in memory outlives it. */
  function tableUnloaded(id: string) {
    wake(id, undefined); retire(id);
    for (const handle of scheduledHolds.get(id)?.values() ?? []) handle.release();
    scheduledHolds.delete(id);
    for (const entry of subscribers.get(id) ?? []) entry.handle.release();
    subscribers.delete(id); statuses.delete(id); presence.delete(id); failedHands.delete(id);
  }
  /**
   * A table written before scheduled play may be mid-decision without a recorded Action Window. That
   * window opened before the upgrade, so it is restored as open since time 0.
   */
  function unscheduledWindow(aggregate: PersistedTableSession, game: CashGame): PersistedTableSession['schedule'] {
    for (const binding of aggregate.bindings) {
      const { state } = game.forParticipant(binding.participantId).getView();
      if (state.status !== 'active-hand') break;
      if (state.actorId && state.decisionId) return { phases: [], actionWindow: { participantId: state.actorId, decisionId: state.decisionId, opensAt: 0, ...(liveAnalysisDisallowed(aggregate, state.actorId) ? { liveAnalysisDisallowed: true as const } : {}) } };
    }
    return emptySchedule;
  }
  /** Upgrades any stored version and validates it completely, or throws TableSessionRestorationError. */
  function restorable(stored: StoredTableSession): CommittedSession {
    const aggregate = upgradeTableSession(stored);
    if (!aggregate || humanBindings(aggregate).some(binding => validateTrainerConfiguration(binding.trainerConfiguration, supportsStrategy))) throw new TableSessionRestorationError();
    const restored = CashGame.fromRecord(aggregate.pokerRecord);
    if (!restored.ok) throw new TableSessionRestorationError();
    // Version 1 predates scheduled play; every version-2 row records its schedule.
    return { aggregate: stored.schemaVersion === 2 ? aggregate : { ...aggregate, schedule: unscheduledWindow(aggregate, restored.game) }, game: restored.game };
  }
  /** The committed table as its record stands, restored completely; `undefined` when there is no such table. */
  async function readCommitted(id: string): Promise<CommittedSession | undefined> {
    const rows = await db.select().from(tableSessions).where(eq(tableSessions.id, id));
    const stored = rows[0]?.aggregate;
    return stored && restorable(stored);
  }
  /**
   * Replaces a loaded table's copy with its committed record, as recovery does once a commit's outcome is proven, and
   * runs its schedule. A table that is not in memory stays unloaded: it is read fresh when next loaded.
   */
  async function refresh(id: string) {
    if (!tables.get(id)) return;
    const session = await readCommitted(id);
    if (!session || !tables.get(id)) return;
    promote(id, session);
    if (!stopped) queueMicrotask(() => { void enqueue(id, async () => { const current = tables.get(id); if (current) await runSchedule(id, current); }).catch(() => {}); });
  }
    async function read(id: string, userId: string) {
      return asMember(id, userId, async () => {
        const session = tables.get(id);
        const participantId = viewer(session, userId);
        if (!session || !participantId) return undefined;
        const projected = projectTableSession(session.aggregate, participantId, session.game, clock.now(), bots?.adminMode !== false, connectedParticipants(id, session));
        return { ...projected, runtimeStatus: statuses.get(id) ?? { phase: 'idle' as const } };
      });
    }
    /**
     * Subscribes a Guest joined at the table to its live updates, or `undefined` for anyone else. The subscription
     * holds a handle on the table until the returned function ends it, or until the Guest's membership ends.
     */
    async function subscribe(id: string, userId: string, publish: (update: TableLiveMessage) => void) {
      const handle = await acquireMember(id, userId);
      if (!handle) return undefined;
      const session = tables.get(id);
      const participantId = viewer(session, userId);
      if (!session || !participantId) { handle.release(); return undefined; }
      const entries = subscribers.get(id) ?? new Set();
      const entry: Subscriber = { userId, publish, handle };
      const end = () => { entries.delete(entry); if (entries.size === 0 && subscribers.get(id) === entries) subscribers.delete(id); handle.release(); };
      entries.add(entry);
      subscribers.set(id, entries);
      // No facade is retained: each projection binds the current committed game.
      try {
        publish({ ...projectTableUpdate(session.aggregate, participantId, session.game, clock.now(), [], bots?.adminMode !== false, connectedParticipants(id, session)), runtimeStatus: statuses.get(id) ?? { phase: 'idle' } });
        const status = statuses.get(id);
        if (status) publish({ type: 'table-status', tableSessionId: id, status });
      } catch (error) {
        end();
        throw error;
      }
      connectionChanged(id);
      return () => { end(); connectionChanged(id); };
    }
    async function accept(id: string, authority: MutationAuthority, kind: PokerMutationKind, request: PokerMutationRequest): Promise<MutationOutcome> {
        // The caller holds the table: a request's handle, or the scheduled work that runs this.
        let session = tables.get(id);
        // After-Hand requests whose Hand has ended are applied before anything else is judged, Deal included.
        if (session && afterHandDue(session)) { await settleAfterHand(id); session = tables.get(id); }
        const requester = session && authority.kind === 'human' ? memberBinding(session.aggregate, authority.userId) : undefined;
        if (!session || (authority.kind === 'human' && !requester)) return notFound();
        if (stopped) return reject('server-closing', 'The server is closing.');
        const denial = requester && humanMutationDenial(session.aggregate, requester, kind, request);
        if (denial) return denial;
        const { requestId, ...contents } = request;
        const fingerprint = createHash('sha256').update('poker-mutation-v1:' + canonical({ source: authority.kind, kind, contents })).digest('hex');
        const existing = await resolveRequest(id, requestId, fingerprint); if (existing) return existing;
        session = tables.get(id)!;
        if (authority.kind === 'bot' && authority.identity && !current(id, authority.identity)) return reject('obsolete-bot-work', 'The Bot decision changed.');
        let proposed: CommittedSession | undefined;
        let acceptedHumanDecision: string | undefined;
        let acceptedEvents: readonly CashGameEvent[] = [];
        let ending: { participantId: string; membership: 'left' } | undefined;
        let addedBot: PersistedBotBinding | undefined;
        let removedBot: string | undefined;
        try {
          const { outcome, committed: next } = await commitTableRequest(id, requestId, fingerprint, session.aggregate, (): TableDecision<MutationOutcome> => {
            let result = malformedPokerRequest(kind, request);
            // A late act is told so even after its Timeout Action has moved the table on.
            if (!result && kind === 'act' && authority.kind === 'human' && missedActionDeadline(session.aggregate, request as ActRequest, authority.receivedAt))
              result = reject('action-deadline-passed', 'Your action reached the server after your Action Deadline, so the Timeout Action was played for you: Check, or Fold when Check was not legal.');
            if (!result && request.expectedPokerRevision !== session.aggregate.pokerRevision) result = reject('stale-poker-revision', 'The table changed. Refresh its committed view before submitting a new attempt.');
            const binding = findBinding(session.aggregate, 'participantId' in request ? request.participantId : undefined);
            if (!result && kind !== 'start-hand' && kind !== 'set-button' && kind !== 'add-bot' && !binding) result = reject('participant-not-bound', 'Choose a Participant assigned to this Table Session.');
            if (!result && isBot(binding) && binding.removed) result = reject('bot-removed', 'The Table Owner removed this Bot from the table.');
            if (!result && kind === 'remove-participant' && !(isHuman(binding) && binding.membership === 'joined')) result = reject('participant-not-joined', 'This Participant has already left the table or been removed.');
            // The scheduler's own Timeout Action may act for whoever holds the expired decision.
            if (!result && kind === 'act' && authority.kind !== 'server' && (authority.kind === 'human'
              ? !isHuman(binding) || binding.userId !== authority.userId
              : !isBot(binding))) result = reject('actor-not-authorized', authority.kind === 'human'
                ? 'This local identity can act only through its bound human Participant.'
                : 'Trusted controller commands can act only through a bound Bot.');
            // Timing is judged by when a human's request arrived, and by now for the server's own work.
            const arrivedAt = authority.kind === 'human' ? authority.receivedAt : clock.now();
            // No one acts during a Presentation Phase, and the next Hand is not dealt before the last one is paid out.
            if (!result && kind === 'act' && beforeActionWindow(session.aggregate.schedule, (request as ActRequest).participantId, arrivedAt))
              result = reject('action-window-not-open', 'This decision’s Action Window opens when the current Presentation Phase ends. Act once it opens.');
            if (!result && kind === 'start-hand' && beforePayoutEnd(session.aggregate.schedule, arrivedAt))
              result = reject('payout-phase-not-ended', 'The last Hand is still being paid out. Deal when its payout phase ends.');
            // Judged when the request is processed, not when it arrived: the Hand ends for management when its payout phase does.
            const during = !result && authority.kind === 'human' ? duringHand(tableState(session), session.aggregate, kind, binding, request, clock.now()) : undefined;
            if (during && 'rejection' in during) result = during.rejection;
            else if (during) {
              const current = session.aggregate;
              if (during.pending === current.pendingChanges) result = { ok: true, tableSessionId: id, pokerRevision: current.pokerRevision, sessionRevision: current.sessionRevision, afterHand: true };
              else {
                const aggregate: PersistedTableSession = { ...current, sessionRevision: current.sessionRevision + 1, pendingChanges: during.pending };
                proposed = { aggregate, game: session.game };
                result = { ok: true, tableSessionId: id, pokerRevision: aggregate.pokerRevision, sessionRevision: aggregate.sessionRevision, afterHand: true };
              }
            }
            if (!result) {
              const working = session.game.fork();
              const accepted = (() => {
                switch (kind) {
                  case 'start-hand': {
                    // Deal brings the dealing human back from a sit-out they chose, in the same commit.
                    const resumed = requester ? resumeFromSittingOut(working, requester.participantId) : undefined;
                    if (resumed && !resumed.ok) return resumed;
                    const dealt = working.startHand();
                    return dealt.ok && resumed ? { ok: true as const, events: [...resumed.events, ...dealt.events] } : dealt;
                  }
                  case 'act': return working.act((request as ActRequest).participantId, (request as ActRequest).action);
                  case 'seat-participant': return working.seatParticipant((request as SeatParticipantRequest).participantId, (request as SeatParticipantRequest).seat, (request as SeatParticipantRequest).buyIn);
                  case 'stand-up-participant': return working.standUpParticipant((request as StandUpParticipantRequest).participantId);
                  case 'move-participant': return working.moveParticipant((request as MoveParticipantRequest).participantId, (request as MoveParticipantRequest).seat);
                  case 'set-sitting-out': return working.setSittingOut((request as SetSittingOutRequest).participantId, (request as SetSittingOutRequest).sittingOut);
                  case 'top-up-to': return working.topUpTo((request as TopUpToRequest).participantId, (request as TopUpToRequest).targetStack);
                  case 'set-button': return working.setButton((request as SetButtonRequest).seat);
                  case 'add-bot': {
                    // The Bot is bound and seated in one commit, even mid-Hand: Hand participants are frozen, so it is dealt in next Hand.
                    const intent = request as AddBotRequest;
                    const name = participantName(intent.name);
                    const invalid = (code: string, field: string, message: string) => ({ ok: false as const, rejection: { code, field, message } });
                    if (session.aggregate.mode === 'online' && placesTaken(session.aggregate) >= onlineTableCapacity) return tableFull('Remove a Bot, or wait for someone to leave, before adding another.');
                    if (name === undefined) return invalid('invalid-bot-name', 'name', participantNameRules);
                    if (!supportsStrategy(intent.playingStrategy)) return invalid('unsupported-strategy', 'playingStrategy', 'Choose a supported complete Playing Strategy.');
                    if (session.aggregate.bindings.some(candidate => nameKey(candidate.name) === nameKey(name))) return invalid('name-taken', 'name', 'Someone at this table already uses that name, ignoring case. Choose a different name for the Bot.');
                    const { configuration, state } = publicView(working, session.aggregate);
                    const seat = intent.seat ?? Array.from({ length: configuration.seatCount }, (_, index) => index + 1).find(open => !state.participants.some(p => p.seat === open));
                    if (seat === undefined) return invalid('no-empty-seat', 'seat', 'Every Seat is taken. Make room before adding a Bot.');
                    const participantId = randomUUID();
                    const seated = working.seatParticipant(participantId, seat, intent.buyIn);
                    if (seated.ok) addedBot = { participantId, name, controller: { kind: 'bot', playingStrategy: immutableData(intent.playingStrategy) }, assignmentId: randomUUID() };
                    return seated;
                  }
                  case 'remove-bot': {
                    const participantId = (request as RemoveBotRequest).participantId;
                    const left = standUpAndLeave(working, participantId);
                    if (left.ok) removedBot = participantId;
                    return left;
                  }
                  case 'leave-table': case 'remove-participant': {
                    // Removal is a Leave Table the owner imposes: nothing records the difference, and the Guest may join again.
                    const participantId = (request as LeaveTableRequest | RemoveParticipantRequest).participantId;
                    const left = standUpAndLeave(working, participantId);
                    if (left.ok) ending = { participantId, membership: 'left' };
                    return left;
                  }
                }
              })();
              if (!accepted.ok) result = { ok: false, rejection: accepted.rejection };
              else {
                acceptedEvents = accepted.events;
                // A Timeout Action is the human's own decision too, so it is analyzed and scored like one.
                if (kind === 'act' && isHuman(binding)) acceptedHumanDecision = session.game.forParticipant((request as ActRequest).participantId).getView().state.decisionId ?? undefined;
                const window = session.aggregate.schedule.actionWindow;
                const timedOutWindow = kind === 'act' && window?.deadlineAt !== undefined && pastActionDeadline(window, (request as ActRequest).participantId, arrivedAt)
                  ? { participantId: window.participantId, decisionId: window.decisionId, deadlineAt: window.deadlineAt, pokerRevision: session.aggregate.pokerRevision } : undefined;
                const pokerRecord = working.toRecord();
                const provenance = authority.kind === 'bot' && authority.identity ? (() => {
                  const { tableSessionId: _table, pokerRevision: _revision, ...identity } = authority.identity;
                  return { ...identity, commandIndex: pokerRecord.commands.length - 1 };
                })() : undefined;
                // The schedule commits with the transition that produced it; Automatic Dealing pauses between Hands.
                const schedule = scheduleTransition(session.aggregate.schedule, accepted.events, decisionAfter(session.aggregate, working, accepted.events), clock.now(), { pauseBetweenHands: session.aggregate.mode === 'online' });
                // At an Online Table a Timeout Action, a human's or a failed Bot's, also sits its Participant out after the Hand.
                const sitsOutAfterHand = kind === 'act' && authority.kind === 'server' && session.aggregate.mode === 'online' ? (request as ActRequest).participantId : undefined;
                const aggregate: PersistedTableSession = { ...session.aggregate, pokerRecord, pokerRevision: session.aggregate.pokerRevision + (accepted.events.length ? 1 : 0), sessionRevision: session.aggregate.sessionRevision + 1,
                  ...(provenance ? { botProvenance: [...(session.aggregate.botProvenance ?? []), provenance] } : {}), ...(timedOutWindow ? { timedOutWindow } : {}), schedule,
                  ...(sitsOutAfterHand ? { pendingChanges: recordAfterHandRequest(session.aggregate.pendingChanges, sitsOutAfterHand, 'sit-out') } : {}),
                  ...(addedBot ? { bindings: [...session.aggregate.bindings, addedBot] } : {}),
                  ...(removedBot ? { pendingChanges: session.aggregate.pendingChanges.filter(entry => entry.participantId !== removedBot),
                    bindings: session.aggregate.bindings.map(item => isBot(item) && item.participantId === removedBot ? { ...item, removed: true as const } : item) } : {}),
                  ...(ending ? { pendingChanges: session.aggregate.pendingChanges.filter(entry => entry.participantId !== ending!.participantId), bindings: session.aggregate.bindings.map(item => isHuman(item) && item.participantId === ending!.participantId ? { ...item, membership: ending!.membership } : item) } : {}) };
                proposed = { aggregate, game: working };
                result = { ok: true, tableSessionId: id, pokerRevision: aggregate.pokerRevision, sessionRevision: aggregate.sessionRevision };
              }
            }
            return { outcome: result, ...(proposed ? { next: proposed } : {}) };
          });
          if (next) {
            publishCommitted(id, acceptedEvents);
            if (acceptedHumanDecision) analyzeAccepted(next, (request as ActRequest).participantId, acceptedHumanDecision);
            await runSchedule(id, next);
          }
          return outcome;
        } catch (error) {
          // The table is paused already; its recovery analyzes the human's decision if the COMMIT proves to have happened.
          if (error instanceof CommitOutcomeUnknown && acceptedHumanDecision) uncertainHumanActions.set(actionKey(id, requestId), { participantId: (request as ActRequest).participantId, decisionId: acceptedHumanDecision, fingerprint });
          throw error;
        }
    }
    /** Runs a mutation in the table's FIFO. The caller holds the table until it has been handled. */
    function submit(id: string, authority: MutationAuthority, kind: PokerMutationKind, request: PokerMutationRequest) {
      return enqueue(id, () => accept(id, authority, kind, request));
    }
    /**
     * Bot controller changes and table options require Table Ownership; a Trainer
     * configuration change is the requester's own. Table options change only at an Online Table, between Hands.
     */
    async function configure(id: string, userId: string, kind: 'set-playing-strategy' | 'retry-bot' | 'set-trainer-configuration' | 'set-table-options', request: SetPlayingStrategyRequest | RetryBotRequest | SetTrainerConfigurationRequest | SetTableOptionsRequest): Promise<MutationOutcome> {
      return await asMember(id, userId, () => enqueue(id, async (): Promise<MutationOutcome> => {
        let session = tables.get(id);
        const requester = session && memberBinding(session.aggregate, userId);
        if (!session || !requester) return notFound();
        if (stopped) return reject('server-closing', 'The server is closing.');
        if (kind !== 'set-trainer-configuration' && session.aggregate.ownerUserId !== userId) return ownerRequired();
        // Explicit Bot recovery is Practice's: an Online Table retries a failed decision once, then plays its Timeout Action.
        if (kind === 'retry-bot' && session.aggregate.mode === 'online') return unavailableOnline('At an Online Table the server retries a failed Bot decision itself, then plays its Timeout Action.');
        const { requestId, ...contents } = request;
        const fingerprint = createHash('sha256').update('controller-mutation-v2:' + canonical({ userId, kind, contents })).digest('hex');
        const existing = await resolveRequest(id, requestId, fingerprint); if (existing) return existing;
        session = tables.get(id)!;
        let proposed: CommittedSession | undefined;
        let optionEvents: readonly CashGameEvent[] = [];
        const { outcome, committed: next, decided } = await commitTableRequest(id, requestId, fingerprint, session.aggregate, (): TableDecision<MutationOutcome> => {
            const trainer = kind === 'set-trainer-configuration', bot = kind === 'set-playing-strategy' || kind === 'retry-bot', tableOptions = kind === 'set-table-options';
            const fields = ['requestId', 'expectedSessionRevision', ...(trainer ? ['trainerConfiguration'] : tableOptions ? ['options'] : bot ? ['participantId', ...(kind === 'set-playing-strategy' ? ['playingStrategy'] : [])] : [])];
            let result: MutationOutcome | undefined;
            if (Object.keys(request).some(key => !fields.includes(key)) || !Number.isSafeInteger(request.expectedSessionRevision) || request.expectedSessionRevision < 0) result = reject(trainer ? 'invalid-trainer-configuration' : tableOptions ? 'invalid-table-options' : 'invalid-controller-request', 'Supply supported configuration fields and a nonnegative expectedSessionRevision.');
            if (!result && tableOptions) result = validateTableOptionChanges((request as SetTableOptionsRequest).options);
            if (!result && request.expectedSessionRevision !== session.aggregate.sessionRevision) result = reject('stale-session-revision', 'The table changed. Refresh before submitting a new configuration request.');
            if (!result && tableOptions) {
              // A Practice Table keeps the options it was created with. At an Online Table they change between Hands only: a Hand lasts until its payout phase ends.
              if (session.aggregate.mode !== 'online') result = reject('unavailable-at-practice-tables', 'A Practice Table keeps the options it was created with.');
              else if (handInProgress(tableState(session).status, session.aggregate.schedule, clock.now())) result = reject('active-hand', 'Change table options between Hands, once the payout has been shown.');
            }
            if (!result && tableOptions) {
              const changes = (request as SetTableOptionsRequest).options, current = session.aggregate.options;
              const next = { actionTimeLimitSeconds: changes.actionTimeLimitSeconds ?? current.actionTimeLimitSeconds, allowLiveAnalysis: changes.allowLiveAnalysis ?? current.allowLiveAnalysis };
              // Allow Live Analysis takes effect from the next Action Window that opens, which captures it.
              // The seat-change permission is CashGame's: one more command, in the same transaction as the options.
              const working = session.game.fork();
              const seatChanges = changes.allowSeatChanges !== undefined && changes.allowSeatChanges !== tableConfiguration(session).allowSeatChanges ? working.setSeatChanges(changes.allowSeatChanges) : undefined;
              if (seatChanges && !seatChanges.ok) result = { ok: false, rejection: seatChanges.rejection };
              else if (seatChanges || next.actionTimeLimitSeconds !== current.actionTimeLimitSeconds || next.allowLiveAnalysis !== current.allowLiveAnalysis) {
                optionEvents = seatChanges?.events ?? [];
                const aggregate: PersistedTableSession = { ...session.aggregate, sessionRevision: session.aggregate.sessionRevision + 1, options: next,
                  ...(seatChanges ? { pokerRecord: working.toRecord(), pokerRevision: session.aggregate.pokerRevision + 1 } : {}) };
                proposed = { aggregate, game: seatChanges ? working : session.game };
              }
            }
            if (!result && bot && !isBot(findBinding(session.aggregate, (request as RetryBotRequest).participantId))) result = reject('participant-not-bot', 'Choose a bound Bot.');
            if (!result && bot && (findBinding(session.aggregate, (request as RetryBotRequest).participantId) as PersistedBotBinding).removed) result = reject('bot-removed', 'The Table Owner removed this Bot from the table.');
            if (!result && kind === 'set-playing-strategy' && !supportsStrategy((request as SetPlayingStrategyRequest).playingStrategy)) result = reject('unsupported-strategy', 'Choose a supported complete Playing Strategy.');
            if (!result && kind === 'retry-bot' && capture(session, '')?.identity.participantId !== (request as RetryBotRequest).participantId) result = reject('bot-not-current', 'Retry is available only for the current Bot decision.');
            if (!result && trainer) {
              const configuration = (request as SetTrainerConfigurationRequest).trainerConfiguration;
              result = validateTrainerConfiguration(configuration, supportsStrategy);
              if (!result) {
                const aggregate: PersistedTableSession = { ...session.aggregate, sessionRevision: session.aggregate.sessionRevision + 1,
                  bindings: session.aggregate.bindings.map(item => item.participantId === requester.participantId ? { ...requester, trainerConfiguration: immutableData(configuration) } : item) };
                proposed = { aggregate, game: session.game };
              }
            }
            if (!result && kind === 'set-playing-strategy') {
              const aggregate: PersistedTableSession = { ...session.aggregate, sessionRevision: session.aggregate.sessionRevision + 1,
                bindings: session.aggregate.bindings.map(item => isBot(item) && item.participantId === (request as SetPlayingStrategyRequest).participantId ? { ...item, assignmentId: randomUUID(), controller: { kind: 'bot', playingStrategy: immutableData((request as SetPlayingStrategyRequest).playingStrategy) } } : item) };
              proposed = { aggregate, game: session.game };
            }
            result ??= { ok: true, tableSessionId: id, pokerRevision: proposed?.aggregate.pokerRevision ?? session.aggregate.pokerRevision, sessionRevision: proposed?.aggregate.sessionRevision ?? session.aggregate.sessionRevision };
            return { outcome: result, ...(proposed ? { next: proposed } : {}) };
        });
        if (next) publishCommitted(id, optionEvents);
        if (decided && outcome.ok && (kind === 'set-playing-strategy' || kind === 'retry-bot')) await runSchedule(id, next ?? session, kind === 'retry-bot');
        return outcome;
      })) ?? notFound();
    }
    /**
     * The Table Owner sets, changes or removes (`null`) an Online Table's Table Password, at any time, even during a
     * Hand: it advances only the session revision, and nobody at the table is affected. Only newcomers need it. The
     * password is hashed before the table's turn, since hashing is slow by design, and its fingerprint records only
     * whether it sets or removes, so the password never reaches it.
     */
    async function setTablePassword(id: string, userId: string, request: SetTablePasswordRequest): Promise<MutationOutcome> {
      return await asMember(id, userId, async () => {
        const { requestId, ...contents } = request;
        if (Object.keys(contents).some(key => key !== 'tablePassword') || !Object.hasOwn(contents, 'tablePassword')) return reject('invalid-table-password', 'Supply a requestId and the tablePassword, or null to remove it.');
        const { tablePassword } = request;
        const problem = tablePassword === null ? undefined : tablePasswordProblem(tablePassword);
        if (problem) return problem;
        const permitted = (session: CommittedSession | undefined) => {
          if (!session || !memberBinding(session.aggregate, userId)) return notFound();
          if (stopped) return reject('server-closing', 'The server is closing.');
          if (session.aggregate.ownerUserId !== userId) return ownerRequired();
          if (session.aggregate.mode !== 'online') return reject('unavailable-at-practice-tables', 'A Practice Table has no Join Link, so it has no Table Password.');
        };
        // Refused before hashing, and again in the table's turn, where ownership is decided.
        const refused = permitted(tables.get(id));
        if (refused) return refused;
        const tablePasswordHash = tablePassword === null ? undefined : await hashTablePassword(tablePassword);
        return enqueue(id, async (): Promise<MutationOutcome> => {
          let session = tables.get(id);
          const denial = permitted(session);
          if (denial) return denial;
          const fingerprint = createHash('sha256').update('table-password-v1:' + canonical({ userId, sets: tablePassword !== null })).digest('hex');
          const existing = await resolveRequest(id, requestId, fingerprint); if (existing) return existing;
          session = tables.get(id)!;
          const { tablePasswordHash: _previous, ...rest } = session.aggregate;
          const aggregate: PersistedTableSession = { ...rest, sessionRevision: rest.sessionRevision + 1, ...(tablePasswordHash ? { tablePasswordHash } : {}) };
          const { outcome, committed: next } = await commitTableRequest(id, requestId, fingerprint, session.aggregate, (): TableDecision<MutationOutcome> => ({
            outcome: { ok: true, tableSessionId: id, pokerRevision: aggregate.pokerRevision, sessionRevision: aggregate.sessionRevision },
            next: { aggregate, game: session.game },
          }));
          if (next) publishCommitted(id);
          return outcome;
        });
      }) ?? notFound();
    }
    /**
     * Joins the Online Table that this Join Link, its own address, names, as the Guest's one Participant there
     * (ADR-0033). The link is the authorization, so there is no expected revision. A Guest who already joined gets
     * their Participant back, and one who left, the Table Owner included, returns as the same Participant under
     * their original name. An ID that names no Online Table is not found, and never loads anything: only a join to an
     * Online Table that exists does. A Guest at another Online Table, their Current Table, is refused: the join runs in
     * the Guest's turn (`guests`), which creation shares, so no other request of theirs can pass that check meanwhile.
     *
     * Anyone not at a table with a Table Password must give it, a Guest who left or was removed and a former owner
     * included. It is checked against the stored table before loading it, and again if it changed meanwhile. A missing
     * or wrong password is a definitive rejection that is never remembered under the request ID, and the password
     * never reaches the fingerprint. `passwordAttempt` is asked before each check of a password, so that only a join
     * that could otherwise succeed spends one: the Current Table refusal comes first.
     */
    async function join(id: string, userId: string, request: JoinTableRequest, passwordAttempt?: () => ApplicationRejection | undefined): Promise<JoinOutcome> {
      const stored = await storedOnlineTable(db, id);
      if (!stored) return notFound();
      const { requestId, tablePassword, ...contents } = request;
      if (Object.keys(contents).length || tablePassword !== undefined && typeof tablePassword !== 'string') return reject('invalid-mutation-request', 'Joining carries only a requestId, and the Table Password when the table has one.');
      // The Guest's turn is taken before the table's handle and FIFO, never inside them.
      return await guests.run(userId, async (): Promise<JoinOutcome> => {
        const upgraded = upgradeTableSession(stored);
        // Checked again in the table's turn; this early answer only spares a password attempt.
        const away = upgraded && memberBinding(upgraded, userId) ? undefined : await currentTable(db, userId);
        if (away && away !== id) return currentTableElsewhere(away);
        let checked = await passwordRefusal(upgraded, userId, tablePassword, undefined, passwordAttempt);
        if (checked.refusal) return checked.refusal;
        return await holding(id, () => enqueue(id, async (): Promise<JoinOutcome> => {
        let session = tables.get(id);
        if (!session) return notFound();
        if (stopped) return reject('server-closing', 'The server is closing.');
        const fingerprint = createHash('sha256').update('join-table-v1:' + canonical({ userId })).digest('hex');
        const existing = await resolveRequest(id, requestId, fingerprint); if (existing) return existing as JoinOutcome;
        session = tables.get(id)!;
        // Not remembered under the request ID: once the Guest leaves their Current Table, the same request joins.
        const elsewhere = memberBinding(session.aggregate, userId) ? undefined : await currentTable(db, userId);
        if (elsewhere && elsewhere !== id) return currentTableElsewhere(elsewhere);
        // The owner may have changed the password since it was checked. Neither refusal is remembered either.
        checked = await passwordRefusal(session.aggregate, userId, tablePassword, checked.verified, passwordAttempt);
        if (checked.refusal) return checked.refusal;
        session = tables.get(id)!;
        let proposed: CommittedSession | undefined;
        let events: readonly CashGameEvent[] = [];
        const { outcome, committed: next } = await commitTableRequest(id, requestId, fingerprint, session.aggregate, async (tx): Promise<TableDecision<JoinOutcome>> => {
            const { aggregate } = session;
            const binding = humanBindings(aggregate).find(candidate => candidate.userId === userId);
            const guest = (await tx.select({ displayName: localUsers.displayName }).from(localUsers).where(eq(localUsers.id, userId)))[0]?.displayName;
            const acknowledged = (participantId: string, next = aggregate): JoinOutcome => ({ ok: true, tableSessionId: id, participantId, pokerRevision: next.pokerRevision, sessionRevision: next.sessionRevision });
            let result: JoinOutcome | undefined;
            if (binding?.membership === 'joined') result = acknowledged(binding.participantId);
            else if (!binding && !guest) result = reject('display-name-required', 'Choose a display name before joining a table.');
            // The owner's place is held after they leave, so only someone else can find the table full.
            else if (binding?.userId !== aggregate.ownerUserId && placesTaken(aggregate) >= onlineTableCapacity) result = tableFull('Ask the Table Owner to make room.');
            else if (!binding && aggregate.bindings.some(candidate => nameKey(candidate.name) === nameKey(guest!))) result = reject('name-taken', 'Someone at this table already uses that name, ignoring case. Choose a different display name.');
            if (!result) {
              const participantId = binding?.participantId ?? randomUUID();
              const working = session.game.fork();
              const joined = working.joinTable(participantId);
              // An engine that already counts the Participant as joined needs no second command.
              if (!joined.ok && joined.rejection.code !== 'participant-already-joined') result = { ok: false, rejection: joined.rejection };
              else {
                if (joined.ok) events = joined.events;
                const next: PersistedTableSession = { ...aggregate, sessionRevision: aggregate.sessionRevision + 1,
                  ...(joined.ok ? { pokerRecord: working.toRecord(), pokerRevision: aggregate.pokerRevision + 1 } : {}),
                  bindings: binding ? aggregate.bindings.map(candidate => candidate.participantId === participantId ? { ...binding, membership: 'joined' as const } : candidate)
                    : [...aggregate.bindings, { participantId, name: guest!, controller: { kind: 'human' }, userId, membership: 'joined', trainerConfiguration: structuredClone(defaultTrainerConfiguration) }] };
                proposed = { aggregate: next, game: working };
                result = acknowledged(participantId, next);
              }
            }
            return { outcome: result, ...(proposed ? { next: proposed } : {}) };
        });
        if (next) publishCommitted(id, events);
        return outcome;
      })) ?? notFound();
      });
    }
    /**
     * Why a Guest cannot join this table with `password`: undefined `refusal` when they need none (no Table Password,
     * or they are at the table) or give the right one. `verified` is the hash it last matched, so that a password
     * already checked against an unchanged hash is not hashed again. `attempt` is asked first each time a password is
     * actually checked, and may refuse it (the per-address limit on password attempts).
     */
    async function passwordRefusal(aggregate: PersistedTableSession | undefined, userId: string, password: string | undefined, verified: string | undefined, attempt?: () => ApplicationRejection | undefined): Promise<{ refusal?: ApplicationRejection; verified?: string }> {
      const hash = aggregate?.tablePasswordHash;
      if (!hash || memberBinding(aggregate, userId)) return { verified };
      if (hash === verified) return { verified };
      if (password === undefined || password === '') return { refusal: tablePasswordRequired() };
      const limited = attempt?.();
      if (limited) return { refusal: limited };
      return await tablePasswordMatches(password, hash) ? { verified: hash } : { refusal: wrongTablePassword() };
    }
    /**
     * What an Online Table's Join Link shows before joining, for the Guest opening it: undefined, answered as not
     * found, for an ID that names no Online Table. A Guest not at a table with a Table Password learns only its
     * owner's name and that the password is required. It is read from the stored
     * table, never loading it: the Guest opening the link is not at the table yet.
     */
    async function previewJoin(userId: string, id: string): Promise<JoinLinkPreview | ApplicationRejection | undefined> {
      const stored = await storedOnlineTable(db, id);
      if (!stored) return undefined;
      const aggregate = upgradeTableSession(stored);
      if (!aggregate) throw new TableSessionRestorationError();
      const humans = humanBindings(aggregate);
      const owner = humans.find(binding => binding.userId === aggregate.ownerUserId)!;
      // Behind a Table Password, the table's details stay with the people at it.
      if (aggregate.tablePasswordHash && !memberBinding(aggregate, userId)) return { ok: true, ownerName: owner.name, passwordRequired: true };
      const returning = humans.find(binding => binding.userId === userId && binding.membership === 'left');
      return { ok: true as const, ownerName: owner.name, configuration: projectConfiguration(recordedConfiguration(aggregate.pokerRecord)), options: projectOptions(aggregate.options),
        placesTaken: placesTaken(aggregate), alreadyJoined: !!memberBinding(aggregate, userId), ...(returning ? { returningAs: returning.name } : {}) };
    }
    /**
     * The Guest's saved tables (`savedTableEntries`), each with its format and blinds, read from the stored row: no
     * table is acquired or loaded, and none of the table's play appears. A row that cannot be upgraded is still listed,
     * without them.
     */
    async function savedTables(userId: string): Promise<SavedTable[]> {
      return (await savedTableEntries(db, userId)).map(({ stored, ...entry }): SavedTable => {
        const aggregate = upgradeTableSession(stored);
        if (!aggregate) return entry;
        const { seatCount, smallBlind, bigBlind, ante } = recordedConfiguration(aggregate.pokerRecord);
        return { ...entry, seatCount, stakes: { smallBlind, bigBlind, ante } };
      });
    }
    async function readPersistedSession(id: string) {
      const rows = await db.select().from(tableSessions).where(eq(tableSessions.id, id));
      const stored = rows[0]?.aggregate;
      return stored && immutableData(restorable(stored).aggregate);
    }
    /**
     * Loads at startup only the tables with scheduled work (`loadAtStartup`, ADR-0035) and runs each one's schedule, so
     * that its deadlines keep running without anyone at it. An Action Deadline that expired during the outage resolves
     * there, once. Every other table loads the first time a request needs it.
     */
    async function loadScheduledTables() {
      const rows = await db.select({ id: tableSessions.id }).from(tableSessions).where(eq(tableSessions.loadAtStartup, true));
      // A corrupt session remains unavailable at its routes without preventing other sessions from starting.
      // Loading a table queues its schedule run; startup waits for it.
      await Promise.allSettled(rows.map(row => holding(row.id, () => drained(row.id))));
    }
    function stop() {
      stopped = true;
      clearInterval(recoveryTimer);
      tables.close();
      for (const pending of wakes.values()) pending.cancel();
      wakes.clear();
      uncertainHumanActions.clear();
      for (const id of work.keys()) retire(id);
    }
    async function close() {
      stop();
      await bots?.runner.close();
      await Promise.allSettled([...queue.values()]);
    }
  function captureScoreSummary(id: string, userId: string, scope: import('@poker/contracts').ScoreSummaryScope) {
    return asMember(id, userId, () => enqueue(id, async (): Promise<FrozenScoreSummary | null | undefined> => {
      const session = tables.get(id);
      const binding = session && memberBinding(session.aggregate, userId);
      if (!session || !binding) return undefined;
      const participantId = binding.participantId;
      if (stopped || recovering.has(id)) throw new Error('Table Session is unavailable.');
      if (scope.scope === 'hand' && !session.game.getHand(scope.handId)) return null;
      const view = session.game.forParticipant(participantId).getView();
      const decisionIds = view.history.filter(hand => scope.scope === 'table-session' ? hand.result !== undefined : hand.handId === scope.handId).flatMap(hand => hand.decisions.filter(decision => decision.action.participantId === participantId).map(decision => decision.decisionId));
      const members = decisionIds.map(decisionId => captureEvaluation(session, participantId, decisionId)!);
      return immutableData({ participantId, tableSessionId: id, ...scope, capturedPokerRevision: session.aggregate.pokerRevision, referenceStrategy: binding.trainerConfiguration.referenceStrategy, decisionIds, members });
    }));
  }
  return {
    // Historical work validates its frozen request/attempt in this queue; live revision may advance. A result that
    // arrives after its table has unloaded loads it again, so that it is accepted as it would have been.
    acceptJobResult: async (id: string, participantId: string, accept: () => boolean) => !stopped && !!await holding(id, () => enqueue(id, async () => {
      const session = tables.get(id);
      if (stopped || !session || !isHuman(findBinding(session.aggregate, participantId))) return false;
      return accept();
    })),
    captureHandSummary: (id: string, userId: string, handId: string) => captureScoreSummary(id, userId, { scope: 'hand', handId }),
    captureSessionSummary: (id: string, userId: string) => captureScoreSummary(id, userId, { scope: 'table-session' }),
    /**
     * The frozen inputs for the requesting Guest's own decision. Analysis of the current decision before it is
     * accepted is Live Analysis: refused when its Action Window captured Allow Live Analysis as disallowed.
     */
    captureEvaluation: (id: string, userId: string, decisionId: string) => asMember(id, userId, () => enqueue(id, async (): Promise<FrozenEvaluationInput | ApplicationRejection | null | undefined> => {
      const session = tables.get(id);
      const participantId = viewer(session, userId);
      if (!session || !participantId) return undefined;
      if (stopped || recovering.has(id)) throw new Error('Table Session is unavailable.');
      const input = captureEvaluation(session, participantId, decisionId);
      if (!input || input.acceptedAction) return input;
      const window = session.aggregate.schedule.actionWindow;
      const disallowed = window?.decisionId === decisionId ? !!window.liveAnalysisDisallowed : !session.aggregate.options.allowLiveAnalysis;
      return disallowed ? liveAnalysisRefused() : input;
    })),
    /** The requesting Guest's joined Participant at a table, and whether they own it; undefined means not-found. */
    access,
    /** The Guest to notify for a joined human Participant of a loaded table. */
    controllerOf(id: string, participantId: string): string | undefined {
      const session = tables.get(id);
      const binding = session && findBinding(session.aggregate, participantId);
      return isHuman(binding) && binding.membership === 'joined' ? binding.userId : undefined;
    },
    read,
    subscribe,
    configure,
    setTablePassword,
    join,
    previewJoin,
    savedTables,
    loadScheduledTables,
    startRecovery,
    stop,
    close,
    readPersistedSession,
    /** Use only after promoting confirmed durable state, including application-only mutations. */
    publishCommitted,
    publishStatus,
    /** A Guest's mutation, timed by when it arrived. Only a Guest joined at the table can make the request load it. */
    submit: async (id: string, userId: string, kind: PokerMutationKind, request: PokerMutationRequest): Promise<MutationOutcome> => {
      const authority: MutationAuthority = { kind: 'human', userId, receivedAt: clock.now() };
      return await asMember(id, userId, () => submit(id, authority, kind, request)) ?? notFound();
    },
    submitControllerAction: async (id: string, request: ActRequest): Promise<MutationOutcome> => await holding(id, () => submit(id, { kind: 'bot' }, 'act', request)) ?? notFound(),
    loadedTables: () => tables.loadedIds(),
  };
}
