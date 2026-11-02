import { createStrategy, isSupportedStrategy, immutableData, type Strategy } from '@poker/strategies';
import { JobRunner, type JobHandle } from './job-runner.js';
import { and, eq } from 'drizzle-orm';
import { createHash, randomUUID } from 'node:crypto';
import { CashGame, deriveSeed, type CashGameEvent, type CashGameResult } from '@poker/engine';
import { defaultTrainerConfiguration, onlineTableCapacity, type ActionWindow, type ApplicationRejection, type ConcreteAction, type JoinLinkPreview, type JoinOutcome, type JoinTableRequest, type TableMode, type ObservableGameView, type StrategyDescriptor, SetPlayingStrategyRequest, SetTrainerConfigurationRequest, RetryBotRequest, ActRequest, MutationOutcome, TableLiveMessage, TableRuntimeStatus, PokerMutationRequest, SeatParticipantRequest, StandUpParticipantRequest, MoveParticipantRequest, SetSittingOutRequest, TopUpToRequest, SetButtonRequest } from '@poker/contracts';
import { findBinding, humanBindings, isBot, isHuman, memberBinding, upgradeTableSession, type PersistedHumanBinding, type PersistedTableSession, type BotActionProvenance, type StoredTableSession } from './aggregate.js';
import type { openDatabase } from './db/database.js';
import { creationRequests, localUsers, processedRequests, tableSessions } from './db/schema.js';
import { membership, tableOfJoinLink, writeTableSession } from './membership.js';
import { projectTableSession, projectTableUpdate } from './projection.js';
import { CommitOutcomeUnknown } from './creation.js';
import { AcceptanceTransactions, type AcceptanceFaults } from './db/acceptance.js';
import { canonical } from './canonical.js';
import { executeStrategy } from './strategy-execution.js';
import type { FrozenEvaluationInput } from './analysis.js';
import type { FrozenScoreSummary } from './summaries.js';
import { nameKey, validateTrainerConfiguration } from './validation.js';
import { systemClock, type ServerClock } from './clock.js';
import { beforeActionWindow, beforePayoutEnd, emptySchedule, nextWakeAt, pastActionDeadline, scheduleTransition } from './schedule.js';

/** Accepts a derived job result for a human Participant inside its table's FIFO. */
export type AcceptTableJobResult = (tableSessionId: string, participantId: string, accept: () => boolean) => Promise<boolean>;
type Database = ReturnType<typeof openDatabase>['db'];
type CommittedSession = { aggregate: PersistedTableSession; game: CashGame };
export class TableSessionRestorationError extends Error {
  constructor() { super('The complete committed Table Session could not be restored.'); }
}
export type PokerMutationKind = 'seat-participant' | 'start-hand' | 'act' | 'stand-up-participant' | 'move-participant' | 'set-sitting-out' | 'top-up-to' | 'set-button';
/** Internal controller authority. No browser route receives this capability. */
export interface TableSessionControllerCommands {
  submitAction(tableSessionId: string, request: ActRequest): Promise<MutationOutcome>;
  readPersistedSession(tableSessionId: string): Promise<PersistedTableSession | undefined>;
}
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
/** Ends a seated Participant's sit-out between Hands; `undefined` when there is nothing to resume. */
function resumeFromSittingOut(game: CashGame, participantId: string): CashGameResult | undefined {
  const { state } = game.forParticipant(participantId).getView();
  const participant = state.participants.find(candidate => candidate.participantId === participantId);
  return state.status !== 'active-hand' && participant?.seat != null && participant.sittingOut ? game.setSittingOut(participantId, false) : undefined;
}
/**
 * The Action Time Limit, in ms, that gives this Participant's Action Window an Action Deadline: only a human's,
 * and only under the table's limit. Bots never have one. Online Tables do not enforce their limit yet (#40 adds
 * their Timeout Action and its after-Hand sit-out), so only a Practice Table's limit applies.
 */
function actionTimeLimitMs(aggregate: PersistedTableSession, participantId: string): number | undefined {
  const seconds = aggregate.options.actionTimeLimitSeconds;
  return seconds !== null && aggregate.mode === 'practice' && isHuman(findBinding(aggregate, participantId)) ? seconds * 1000 : undefined;
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
/** A Timeout Action that could not be saved is tried again after this long. */
const timeoutRetryMs = 1000;
const reject = (code: string, message: string): ApplicationRejection => ({ ok: false, rejection: { code, message } });
const notFound = () => reject('not-found', 'This Table Session is unavailable to this local identity.');
const ownerRequired = () => reject('table-owner-required', 'Only the Table Owner can deal, manage Bots or change table options.');
const unavailableOnline = (message: string) => reject('unavailable-at-online-tables', message);
const invalidJoinLink = () => reject('invalid-join-link', 'This Join Link does not work. Ask the Table Owner for a new one.');
/**
 * Who may ask for what, decided before request idempotency, so a remembered outcome is only ever replayed to
 * a requester who may make that request. Unknown Participants and acting as a Bot stay definitive rejections.
 */
function humanMutationDenial(aggregate: PersistedTableSession, requester: PersistedHumanBinding, kind: PokerMutationKind, request: PokerMutationRequest): MutationOutcome | undefined {
  const owner = aggregate.ownerUserId === requester.userId;
  if (kind === 'start-hand' && owner && aggregate.mode === 'online') return unavailableOnline('Hands at an Online Table are dealt automatically.');
  if (kind === 'start-hand' || kind === 'set-button') return owner ? undefined : ownerRequired();
  const target = findBinding(aggregate, (request as { participantId?: unknown }).participantId);
  if (isHuman(target) && target.participantId !== requester.participantId) return reject('not-your-participant', 'Only its own Human Controller can act for or manage this Participant.');
  if (isBot(target) && kind !== 'act' && !owner) return ownerRequired();
}
function applicationRejection(kind: PokerMutationKind, request: PokerMutationRequest): MutationOutcome | undefined {
  const commandFields: Record<PokerMutationKind, readonly string[]> = {
    'seat-participant': ['participantId', 'seat', 'buyIn'], 'start-hand': [], act: ['participantId', 'action'],
    'stand-up-participant': ['participantId'], 'move-participant': ['participantId', 'seat'], 'set-sitting-out': ['participantId', 'sittingOut'], 'top-up-to': ['participantId', 'targetStack'], 'set-button': ['seat'],
  };
  const fields = ['requestId', 'expectedPokerRevision', ...commandFields[kind]];
  if (Object.keys(request).some(key => !fields.includes(key)) || !Number.isSafeInteger(request.expectedPokerRevision) || request.expectedPokerRevision < 0)
    return reject('invalid-mutation-request', 'Supply supported mutation fields and a nonnegative expectedPokerRevision.');
}
type BotIdentity = Omit<BotActionProvenance, 'commandIndex'> & { readonly tableSessionId: string; readonly pokerRevision: number };
export interface BotRuntimeOptions {
  readonly runner: JobRunner;
  readonly automaticBots?: boolean;
  readonly adminMode?: boolean;
  readonly strategyFactory?: (descriptor: StrategyDescriptor) => Strategy;
  readonly supportsStrategy?: (descriptor: unknown) => boolean;
  readonly onHumanActionAccepted?: (input: FrozenEvaluationInput) => unknown | Promise<unknown>;
}
export function createTableSessionMutations(db: Database, acceptance: AcceptanceTransactions, faults?: MutationTransactionFaults, bots?: BotRuntimeOptions, clock: ServerClock = systemClock) {
  const committed = new Map<string, CommittedSession>();
  /** One pending wake-up per table, at its schedule's next instant (`nextWakeAt`). */
  const wakes = new Map<string, { at: number; cancel: () => void }>();
  const loading = new Map<string, Promise<CommittedSession | undefined>>();
  const queue = new Map<string, Promise<unknown>>();
  const recovering = new Set<string>();
  // Only this live process remembers an unproven candidate; restart creates no analysis obligation.
  const uncertainHumanActions = new Map<string, AcceptedHumanIntent>();
  const actionKey = (id: string, requestId: string) => JSON.stringify([id, requestId]);
  const subscribers = new Map<string, Set<{ userId: string; publish: (update: TableLiveMessage) => void }>>();
  const statuses = new Map<string, TableRuntimeStatus['status']>();
  const work = new Map<string, { identity: BotIdentity; handle?: JobHandle<ConcreteAction> }>();
  let stopped = false;
  let recoveryTimer: ReturnType<typeof setInterval> | undefined;
  const scheduledRecovery = new Set<string>();
  const strategyFactory = bots?.strategyFactory ?? createStrategy;
  const supportsStrategy = bots?.supportsStrategy ?? isSupportedStrategy;
  function enqueue<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const previous = queue.get(id) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(operation);
    queue.set(id, next);
    return next.finally(() => { if (queue.get(id) === next) queue.delete(id); });
  }
  function capture(session: CommittedSession, evaluationRequestId: string) {
    for (const binding of session.aggregate.bindings) {
      if (!isBot(binding)) continue;
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
    const session = committed.get(id);
    const fresh = session && capture(session, identity.evaluationRequestId);
    return !!fresh && canonical(fresh.identity) === canonical(identity);
  }
  function retire(id: string) { const prior = work.get(id); work.delete(id); prior?.handle?.cancel(); }
  function pause(id: string) {
    const fresh = !recovering.has(id);
    recovering.add(id); retire(id);
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
        // Restore replaces game, revisions, bindings, assignments and provenance together.
        await restore(id);
        const intent = uncertainHumanActions.get(key);
        if (intent && rows[0].fingerprint === intent.fingerprint && rows[0].outcome.ok) acceptedHumans.push({ key, intent });
        else uncertainHumanActions.delete(key);
        await acceptance.forget(attempt).catch(() => {});
      }
    }
    if (pending) { pause(id); return false; }
    if (recovering.has(id)) {
      await restore(id);
      retire(id); recovering.delete(id);
      publishCommitted(id); publishStatus(id, { phase: 'idle' });
      const session = committed.get(id); if (session) await runSchedule(id, session, true);
    }
    const session = committed.get(id);
    for (const { key, intent } of acceptedHumans) {
      uncertainHumanActions.delete(key);
      if (session) analyzeAccepted(session, intent.participantId, intent.decisionId);
    }
    return true;
  }
  async function resolveRequest(id: string, requestId: string, fingerprint: string): Promise<MutationOutcome | undefined> {
    const attempt = await acceptance.find({ kind: 'table', id, requestId });
    if (attempt && attempt.fingerprint !== fingerprint) return reject('request-id-conflict', 'This requestId was already used for different mutation contents.');
    if (attempt) {
      const status = await acceptance.status(attempt);
      if (status === 'pending') { pause(id); throw new CommitOutcomeUnknown('The earlier transaction remains unresolved.'); }
      if (status === 'noncommit') { await reconcile(id); return reject('commit-not-applied', 'The attempt did not commit. Submit a new requestId to deliberately try again.'); }
      pause(id);
    }
    if (recovering.has(id)) await reconcile(id);
    const rows = await db.select().from(processedRequests).where(and(eq(processedRequests.tableSessionId, id), eq(processedRequests.requestId, requestId)));
    if (rows[0]) return rows[0].fingerprint === fingerprint ? rows[0].outcome : reject('request-id-conflict', 'This requestId was already used for different mutation contents.');
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
   * and `resumeBots` reaches it after a restart. Today nothing is due then, because Deal is gated by the
   * clock alone (`beforePayoutEnd` in `accept`). Work that must happen when the Hand ends, such as applying
   * after-Hand requests, runs here when `payoutEndsAt(schedule) <= clock.now()`, and `accept` must run it
   * before it accepts a Deal that arrives ahead of this wake-up.
   */
  async function runSchedule(id: string, session: CommittedSession, forceBot = false): Promise<void> {
    if (stopped || recovering.has(id)) return;
    const window = session.aggregate.schedule.actionWindow;
    if (window && pastActionDeadline(window, window.participantId, clock.now())) { await timeOut(id, window); return; }
    wake(id, nextWakeAt(session.aggregate.schedule, clock.now()));
    ensureBot(id, session, forceBot);
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
    for (let attempt = 1; attempt <= 8; attempt++) {
      const session = committed.get(id);
      if (!session || stopped || recovering.has(id)) return;
      const { state } = session.game.forParticipant(window.participantId).getView();
      if (state.actorId !== window.participantId || state.decisionId !== window.decisionId) return;
      const action: ConcreteAction = state.legalActions.some(legal => legal.type === 'check') ? { type: 'check' } : { type: 'fold' };
      const requestId = 'timeout:' + window.decisionId + (attempt > 1 ? ':' + attempt : '');
      let outcome: MutationOutcome;
      try { outcome = await accept(id, { kind: 'server' }, 'act', { requestId, expectedPokerRevision: session.aggregate.pokerRevision, participantId: window.participantId, action }); }
      catch (error) { if (!(error instanceof CommitOutcomeUnknown) && !stopped) wake(id, clock.now() + timeoutRetryMs); return; }
      if (outcome.ok || !['commit-not-applied', 'request-id-conflict'].includes(outcome.rejection.code)) return;
    }
  }
  function wake(id: string, at: number | undefined) {
    const pending = wakes.get(id);
    if (pending?.at === at) return;
    pending?.cancel(); wakes.delete(id);
    if (at === undefined) return;
    const entry = { at, cancel: () => {} };
    wakes.set(id, entry);
    entry.cancel = clock.setTimer(at, () => {
      if (wakes.get(id) !== entry) return;
      wakes.delete(id);
      if (stopped) return;
      void enqueue(id, async () => { const session = committed.get(id); if (session) await runSchedule(id, session); }).catch(() => {});
    });
  }
  function ensureBot(id: string, session: CommittedSession, force = false) {
    if (stopped || recovering.has(id) || !bots || bots.automaticBots === false) return;
    const window = session.aggregate.schedule.actionWindow;
    // A Bot's decision is requested only once its Action Window opens; its wake-up comes back here.
    const proposed = window && clock.now() < window.opensAt ? undefined : capture(session, randomUUID());
    const prior = work.get(id);
    if (!force && prior && current(id, prior.identity)) return;
    retire(id);
    if (!proposed) { if (statuses.has(id) && statuses.get(id)?.phase !== 'idle') publishStatus(id, { phase: 'idle' }); return; }
    const pending: { identity: BotIdentity; handle?: JobHandle<ConcreteAction> } = { identity: proposed.identity };
    work.set(id, pending);
    publishStatus(id, { phase: 'thinking', participantId: proposed.identity.participantId });
    pending.handle = bots.runner.submit('bot-decision', { view: proposed.view, descriptor: proposed.identity.playingStrategy, evaluationSeed: proposed.identity.evaluationSeed, selectionSeed: proposed.identity.selectionSeed }, async (input, execution) => {
      const { selectedAction } = await executeStrategy(strategyFactory(input.descriptor), input.view, { evaluationSeed: input.evaluationSeed, selectionSeed: input.selectionSeed, signal: execution.signal });
      return selectedAction;
    });
    void pending.handle.result.then(result => {
      if (stopped) return;
      return enqueue(id, async () => {
        if (!current(id, pending.identity)) return;
        if (!result.ok) { publishStatus(id, { phase: 'failed', participantId: pending.identity.participantId, code: result.code }); return; }
        try {
          const outcome = await accept(id, { kind: 'bot', identity: pending.identity }, 'act', { requestId: 'bot:' + pending.identity.evaluationRequestId, expectedPokerRevision: pending.identity.pokerRevision, participantId: pending.identity.participantId, action: result.value });
          if (!outcome.ok && current(id, pending.identity)) publishStatus(id, { phase: 'failed', participantId: pending.identity.participantId, code: 'failed' });
        } catch { if (current(id, pending.identity)) publishStatus(id, { phase: 'failed', participantId: pending.identity.participantId, code: 'persistence-unavailable' }); }
      });
    }).catch(() => {});
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
    let view;
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
    const session = committed.get(id);
    const entries = subscribers.get(id);
    if (!session || !entries) return;
    for (const entry of entries) {
      const participantId = viewer(session, entry.userId);
      if (!participantId) { entries.delete(entry); continue; }
      // A delivery failure cannot change a confirmed mutation's outcome.
      try { entry.publish(projection(session, participantId)); } catch { entries.delete(entry); }
    }
    if (entries.size === 0) subscribers.delete(id);
  }
  function publishCommitted(id: string, events: readonly CashGameEvent[] = []) {
    deliver(id, (session, participantId) => projectTableUpdate(session.aggregate, participantId, session.game, clock.now(), events, bots?.adminMode !== false));
  }
  function publishStatus(id: string, status: TableRuntimeStatus['status']) {
    if (stopped) return;
    if (recovering.has(id) && status.phase !== 'recovering') return;
    const failures: Record<NonNullable<TableRuntimeStatus['status']['code']>, string> = { capacity: 'The computation queue is full. Retry this Bot decision.', cancelled: 'Bot computation was cancelled. Retry this decision.', timeout: 'Bot computation timed out. Retry or change its Playing Strategy.', failed: 'Bot computation failed. Retry or change its Playing Strategy.', incompatible: 'This Playing Strategy does not support the current decision.', 'invalid-policy': 'The Policy returned an invalid distribution. Retry or change its Playing Strategy.', 'selection-failed': 'The Action Selector could not select a valid Choice.', 'persistence-unavailable': 'The Bot action could not be saved. Retry this decision.' };
    const code = status.code && Object.hasOwn(failures, status.code) ? status.code : 'failed';
    const safeStatus: TableRuntimeStatus['status'] = { phase: status.phase, ...(status.participantId ? { participantId: status.participantId } : {}),
      ...(status.phase === 'failed' ? { code, message: failures[code] } : status.phase === 'recovering' ? { message: 'This Table Session is paused while its commit outcome is unknown.' } : {}) };
    statuses.set(id, safeStatus);
    deliver(id, () => ({ type: 'table-status', tableSessionId: id, status: safeStatus }));
  }
  /** Membership from the committed aggregate when cached, otherwise from the index, without restoring the table. */
  async function access(id: string, userId: string): Promise<{ participantId: string; owner: boolean; mode: TableMode } | undefined> {
    const cached = committed.get(id);
    if (!cached) return membership(db, id, userId);
    const binding = memberBinding(cached.aggregate, userId);
    return binding && { participantId: binding.participantId, owner: cached.aggregate.ownerUserId === userId, mode: cached.aggregate.mode };
  }
  /** With a Guest, loads only a table they have joined: anyone else cannot learn that it exists. */
  async function load(id: string, userId?: string): Promise<CommittedSession | undefined> {
    if (!recovering.has(id) && (await acceptance.attempts()).some(entry => entry.tableSessionId === id && entry.state === 'pending')) pause(id);
    const cached = committed.get(id);
    if (cached) return userId && !viewer(cached, userId) ? undefined : cached;
    if (userId) {
      if (!await access(id, userId)) return undefined;
      // Another operation may have promoted a newer game while authorization was read.
      const current = committed.get(id);
      if (current) return current;
    }
    const pending = loading.get(id);
    if (pending) return pending;
    const operation = restore(id);
    loading.set(id, operation);
    try { return await operation; } finally { loading.delete(id); }
  }
  /**
   * A table written before scheduled play may be mid-decision without a recorded Action Window. That
   * window opened before the upgrade, so it is restored as open since time 0.
   */
  function unscheduledWindow(aggregate: PersistedTableSession, game: CashGame): PersistedTableSession['schedule'] {
    for (const binding of aggregate.bindings) {
      const { state } = game.forParticipant(binding.participantId).getView();
      if (state.status !== 'active-hand') break;
      if (state.actorId && state.decisionId) return { phases: [], actionWindow: { participantId: state.actorId, decisionId: state.decisionId, opensAt: 0 } };
    }
    return emptySchedule;
  }
  /** Upgrades any stored version and validates it completely, or throws TableSessionRestorationError. */
  function restorable(stored: StoredTableSession): CommittedSession {
    const aggregate = upgradeTableSession(stored);
    if (humanBindings(aggregate).some(binding => validateTrainerConfiguration(binding.trainerConfiguration, supportsStrategy))) throw new TableSessionRestorationError();
    const restored = CashGame.fromRecord(aggregate.pokerRecord);
    if (!restored.ok) throw new TableSessionRestorationError();
    const scheduled = stored.schemaVersion === 2 && !!stored.schedule;
    return { aggregate: scheduled ? aggregate : { ...aggregate, schedule: unscheduledWindow(aggregate, restored.game) }, game: restored.game };
  }
  async function restore(id: string): Promise<CommittedSession | undefined> {
    const rows = await db.select().from(tableSessions).where(eq(tableSessions.id, id));
    const stored = rows[0]?.aggregate;
    if (!stored) return undefined;
    const session = restorable(stored);
    committed.set(id, session);
    if (!stopped) queueMicrotask(() => { void enqueue(id, async () => { const currentSession = committed.get(id); if (currentSession) await runSchedule(id, currentSession); }).catch(() => {}); });
    return session;
  }
    async function read(id: string, userId: string) {
      await load(id, userId);
      const session = committed.get(id);
      const participantId = viewer(session, userId);
      if (!session || !participantId) return undefined;
      const projected = projectTableSession(session.aggregate, participantId, session.game, clock.now(), bots?.adminMode !== false);
      return { ...projected, runtimeStatus: statuses.get(id) ?? { phase: 'idle' as const } };
    }
    async function subscribe(id: string, userId: string, publish: (update: TableLiveMessage) => void) {
      await load(id, userId);
      const session = committed.get(id);
      const participantId = viewer(session, userId);
      if (!session || !participantId) return undefined;
      const entries = subscribers.get(id) ?? new Set();
      const entry = { userId, publish };
      entries.add(entry);
      subscribers.set(id, entries);
      // No facade is retained: each projection binds the current committed game.
      try {
        publish({ ...projectTableUpdate(session.aggregate, participantId, session.game, clock.now(), [], bots?.adminMode !== false), runtimeStatus: statuses.get(id) ?? { phase: 'idle' } });
        const status = statuses.get(id);
        if (status) publish({ type: 'table-status', tableSessionId: id, status });
      } catch (error) {
        entries.delete(entry); if (entries.size === 0) subscribers.delete(id);
        throw error;
      }
      return () => { entries.delete(entry); if (entries.size === 0) subscribers.delete(id); };
    }
    async function accept(id: string, authority: MutationAuthority, kind: PokerMutationKind, request: PokerMutationRequest): Promise<MutationOutcome> {
        let session = await load(id, authority.kind === 'human' ? authority.userId : undefined);
        const requester = session && authority.kind === 'human' ? memberBinding(session.aggregate, authority.userId) : undefined;
        if (!session || (authority.kind === 'human' && !requester)) return notFound();
        if (stopped) return reject('server-closing', 'The server is closing.');
        const denial = requester && humanMutationDenial(session.aggregate, requester, kind, request);
        if (denial) return denial;
        const { requestId, ...contents } = request;
        const fingerprint = createHash('sha256').update('poker-mutation-v1:' + canonical({ source: authority.kind, kind, contents })).digest('hex');
        const existing = await resolveRequest(id, requestId, fingerprint); if (existing) return existing;
        session = committed.get(id)!;
        if (authority.kind === 'bot' && authority.identity && !current(id, authority.identity)) return reject('obsolete-bot-work', 'The Bot decision changed.');
        let proposed: CommittedSession | undefined;
        let acceptedHumanDecision: string | undefined;
        let acceptedEvents: readonly CashGameEvent[] = [];
        const context = { tableSessionId: id, requestId };
        try {
          const outcome = await acceptance.run({ kind: 'table', id, requestId }, fingerprint, async (tx): Promise<MutationOutcome> => {
            const rows = await tx.select().from(processedRequests).where(and(eq(processedRequests.tableSessionId, id), eq(processedRequests.requestId, requestId)));
            const known = rows[0];
            if (known) return known.fingerprint === fingerprint ? known.outcome : reject('request-id-conflict', 'This requestId was already used for different mutation contents.');
            let result = applicationRejection(kind, request);
            // A late act is told so even after its Timeout Action has moved the table on.
            if (!result && kind === 'act' && authority.kind === 'human' && missedActionDeadline(session.aggregate, request as ActRequest, authority.receivedAt))
              result = reject('action-deadline-passed', 'Your action reached the server after your Action Deadline, so the Timeout Action was played for you: Check, or Fold when Check was not legal.');
            if (!result && request.expectedPokerRevision !== session.aggregate.pokerRevision) result = reject('stale-poker-revision', 'The table changed. Refresh its committed view before submitting a new attempt.');
            const binding = findBinding(session.aggregate, 'participantId' in request ? request.participantId : undefined);
            if (!result && kind !== 'start-hand' && kind !== 'set-button' && !binding) result = reject('participant-not-bound', 'Choose a Participant assigned to this Table Session.');
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
                // The schedule commits with the transition that produced it.
                const handEvent = accepted.events.findLast(event => 'handId' in event);
                const hand = handEvent && 'handId' in handEvent ? working.getHand(handEvent.handId) : undefined;
                const decision = hand?.actorId && hand.decisionId ? { participantId: hand.actorId, decisionId: hand.decisionId, actionTimeLimitMs: actionTimeLimitMs(session.aggregate, hand.actorId) } : null;
                const schedule = scheduleTransition(session.aggregate.schedule, accepted.events, decision, clock.now());
                const aggregate: PersistedTableSession = { ...session.aggregate, pokerRecord, pokerRevision: session.aggregate.pokerRevision + 1, sessionRevision: session.aggregate.sessionRevision + 1,
                  ...(provenance ? { botProvenance: [...(session.aggregate.botProvenance ?? []), provenance] } : {}), ...(timedOutWindow ? { timedOutWindow } : {}), schedule };
                proposed = { aggregate, game: working };
                await writeTableSession(tx, session.aggregate, aggregate);
                result = { ok: true, tableSessionId: id, pokerRevision: aggregate.pokerRevision, sessionRevision: aggregate.sessionRevision };
              }
            }
            await tx.insert(processedRequests).values({ tableSessionId: id, requestId, fingerprint, outcome: result });
            return result;
          }, { ...faults, beforeCommit: () => faults?.beforeCommit?.(context) ?? Promise.resolve(), afterCommit: () => faults?.afterCommit?.(context) ?? Promise.resolve() });
          if (proposed) {
            committed.set(id, proposed); publishCommitted(id, acceptedEvents);
            if (acceptedHumanDecision) analyzeAccepted(proposed, (request as ActRequest).participantId, acceptedHumanDecision);
            await runSchedule(id, proposed);
          }
          return outcome;
        } catch (error) {
          if (error instanceof CommitOutcomeUnknown) {
            if (acceptedHumanDecision) uncertainHumanActions.set(actionKey(id, requestId), { participantId: (request as ActRequest).participantId, decisionId: acceptedHumanDecision, fingerprint });
            pause(id);
          }
          throw error;
        }
    }
    function submit(id: string, authority: MutationAuthority, kind: PokerMutationKind, request: PokerMutationRequest) {
      return enqueue(id, () => accept(id, authority, kind, request));
    }
    /** Bot controller changes require Table Ownership; a Trainer configuration change is the requester's own. */
    async function configure(id: string, userId: string, kind: 'set-playing-strategy' | 'retry-bot' | 'set-trainer-configuration', request: SetPlayingStrategyRequest | RetryBotRequest | SetTrainerConfigurationRequest): Promise<MutationOutcome> {
      return enqueue(id, async () => {
        let session = await load(id, userId);
        const requester = session && memberBinding(session.aggregate, userId);
        if (!session || !requester) return notFound();
        if (stopped) return reject('server-closing', 'The server is closing.');
        if (kind !== 'set-trainer-configuration' && session.aggregate.ownerUserId !== userId) return ownerRequired();
        const { requestId, ...contents } = request;
        const fingerprint = createHash('sha256').update('controller-mutation-v2:' + canonical({ userId, kind, contents })).digest('hex');
        const existing = await resolveRequest(id, requestId, fingerprint); if (existing) return existing;
        session = committed.get(id)!;
        let proposed: CommittedSession | undefined;
        let fresh = false;
        try {
          const outcome = await acceptance.run({ kind: 'table', id, requestId }, fingerprint, async tx => {
            const rows = await tx.select().from(processedRequests).where(and(eq(processedRequests.tableSessionId, id), eq(processedRequests.requestId, requestId)));
            if (rows[0]) return rows[0].fingerprint === fingerprint ? rows[0].outcome : reject('request-id-conflict', 'This requestId was already used for different mutation contents.');
            const trainer = kind === 'set-trainer-configuration';
            const fields = ['requestId', 'expectedSessionRevision', ...(trainer ? ['trainerConfiguration'] : ['participantId', ...(kind === 'set-playing-strategy' ? ['playingStrategy'] : [])])];
            let result: MutationOutcome | undefined;
            if (Object.keys(request).some(key => !fields.includes(key)) || !Number.isSafeInteger(request.expectedSessionRevision) || request.expectedSessionRevision < 0) result = reject(trainer ? 'invalid-trainer-configuration' : 'invalid-controller-request', 'Supply supported configuration fields and a nonnegative expectedSessionRevision.');
            if (!result && request.expectedSessionRevision !== session.aggregate.sessionRevision) result = reject('stale-session-revision', 'The table changed. Refresh before submitting a new configuration request.');
            if (!result && !trainer && !isBot(findBinding(session.aggregate, (request as RetryBotRequest).participantId))) result = reject('participant-not-bot', 'Choose a bound Bot.');
            if (!result && kind === 'set-playing-strategy' && !supportsStrategy((request as SetPlayingStrategyRequest).playingStrategy)) result = reject('unsupported-strategy', 'Choose a supported complete Playing Strategy.');
            if (!result && kind === 'retry-bot' && capture(session, '')?.identity.participantId !== (request as RetryBotRequest).participantId) result = reject('bot-not-current', 'Retry is available only for the current Bot decision.');
            if (!result && trainer) {
              const configuration = (request as SetTrainerConfigurationRequest).trainerConfiguration;
              result = validateTrainerConfiguration(configuration, supportsStrategy);
              if (!result) {
                const aggregate: PersistedTableSession = { ...session.aggregate, sessionRevision: session.aggregate.sessionRevision + 1,
                  bindings: session.aggregate.bindings.map(item => item.participantId === requester.participantId ? { ...requester, trainerConfiguration: immutableData(configuration) } : item) };
                proposed = { aggregate, game: session.game };
                await writeTableSession(tx, session.aggregate, aggregate);
              }
            }
            if (!result && kind === 'set-playing-strategy') {
              const aggregate: PersistedTableSession = { ...session.aggregate, sessionRevision: session.aggregate.sessionRevision + 1,
                bindings: session.aggregate.bindings.map(item => isBot(item) && item.participantId === (request as SetPlayingStrategyRequest).participantId ? { ...item, assignmentId: randomUUID(), controller: { kind: 'bot', playingStrategy: immutableData((request as SetPlayingStrategyRequest).playingStrategy) } } : item) };
              proposed = { aggregate, game: session.game };
              await writeTableSession(tx, session.aggregate, aggregate);
            }
            result ??= { ok: true, tableSessionId: id, pokerRevision: session.aggregate.pokerRevision, sessionRevision: proposed?.aggregate.sessionRevision ?? session.aggregate.sessionRevision };
            await tx.insert(processedRequests).values({ tableSessionId: id, requestId, fingerprint, outcome: result });
            fresh = true;
            return result;
          }, { ...faults, beforeCommit: () => faults?.beforeCommit?.({ tableSessionId: id, requestId }) ?? Promise.resolve(), afterCommit: () => faults?.afterCommit?.({ tableSessionId: id, requestId }) ?? Promise.resolve() });
          if (proposed) { committed.set(id, proposed); publishCommitted(id); }
          if (fresh && outcome.ok && kind !== 'set-trainer-configuration') await runSchedule(id, proposed ?? session, kind === 'retry-bot');
          return outcome;
        } catch (error) {
          if (error instanceof CommitOutcomeUnknown) pause(id);
          throw error;
        }
      });
    }
    /**
     * Joins the Online Table that this Join Link opens, as the Guest's one Participant there. The link is the
     * authorization, so there is no expected revision. A Guest who already joined gets their Participant back,
     * and one who left rejoins as the same Participant under their original name.
     */
    async function join(userId: string, token: string, request: JoinTableRequest): Promise<JoinOutcome> {
      const id = await tableOfJoinLink(db, token);
      if (!id) return invalidJoinLink();
      return enqueue(id, async () => {
        let session = await load(id);
        // The link may have been replaced while this request waited for its turn.
        if (!session || session.aggregate.joinToken !== token) return invalidJoinLink();
        if (stopped) return reject('server-closing', 'The server is closing.');
        const { requestId, ...contents } = request;
        if (Object.keys(contents).length) return reject('invalid-mutation-request', 'Joining carries only a requestId.');
        const fingerprint = createHash('sha256').update('join-table-v1:' + canonical({ userId })).digest('hex');
        const existing = await resolveRequest(id, requestId, fingerprint); if (existing) return existing as JoinOutcome;
        session = committed.get(id)!;
        let proposed: CommittedSession | undefined;
        let events: readonly CashGameEvent[] = [];
        const context = { tableSessionId: id, requestId };
        try {
          const outcome = await acceptance.run({ kind: 'table', id, requestId }, fingerprint, async (tx): Promise<JoinOutcome> => {
            const rows = await tx.select().from(processedRequests).where(and(eq(processedRequests.tableSessionId, id), eq(processedRequests.requestId, requestId)));
            if (rows[0]) return rows[0].fingerprint === fingerprint ? rows[0].outcome as JoinOutcome : reject('request-id-conflict', 'This requestId was already used for different mutation contents.');
            const { aggregate } = session;
            const binding = humanBindings(aggregate).find(candidate => candidate.userId === userId);
            const guest = (await tx.select({ displayName: localUsers.displayName }).from(localUsers).where(eq(localUsers.id, userId)))[0]?.displayName;
            const acknowledged = (participantId: string, next = aggregate): JoinOutcome => ({ ok: true, tableSessionId: id, participantId, pokerRevision: next.pokerRevision, sessionRevision: next.sessionRevision });
            let result: JoinOutcome | undefined;
            if (binding?.membership === 'removed') result = reject('guest-removed', 'The Table Owner removed you from this table, so you cannot join it again.');
            else if (binding?.membership === 'joined') result = acknowledged(binding.participantId);
            else if (!binding && !guest) result = reject('display-name-required', 'Choose a display name before joining a table.');
            else if (humanBindings(aggregate).filter(candidate => candidate.membership === 'joined').length >= onlineTableCapacity) result = reject('table-full', 'This table already has ' + onlineTableCapacity + ' players. Ask the Table Owner to make room.');
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
                await writeTableSession(tx, aggregate, next);
                result = acknowledged(participantId, next);
              }
            }
            await tx.insert(processedRequests).values({ tableSessionId: id, requestId, fingerprint, outcome: result });
            return result;
          }, { ...faults, beforeCommit: () => faults?.beforeCommit?.(context) ?? Promise.resolve(), afterCommit: () => faults?.afterCommit?.(context) ?? Promise.resolve() });
          if (proposed) { committed.set(id, proposed); publishCommitted(id, events); }
          return outcome;
        } catch (error) {
          if (error instanceof CommitOutcomeUnknown) pause(id);
          throw error;
        }
      });
    }
    /** What a Join Link shows before joining, for the Guest holding it. */
    async function previewJoin(userId: string, token: string): Promise<JoinLinkPreview | undefined> {
      const id = await tableOfJoinLink(db, token);
      if (!id) return undefined;
      return enqueue(id, async () => {
        const session = await load(id);
        if (!session || session.aggregate.joinToken !== token) return undefined;
        const { aggregate } = session;
        const humans = humanBindings(aggregate);
        const owner = humans.find(binding => binding.userId === aggregate.ownerUserId)!;
        // Every Participant's view carries the same public configuration.
        const { configuration } = session.game.forParticipant(owner.participantId).getView();
        return { ok: true as const, ownerName: owner.name, configuration, options: { ...aggregate.options },
          joinedCount: humans.filter(binding => binding.membership === 'joined').length, alreadyJoined: !!memberBinding(aggregate, userId) };
      });
    }
    async function readPersistedSession(id: string) {
      const rows = await db.select().from(tableSessions).where(eq(tableSessions.id, id));
      const stored = rows[0]?.aggregate;
      return stored && immutableData(restorable(stored).aggregate);
    }
    async function resumeBots() {
      const rows = await db.select({ id: tableSessions.id }).from(tableSessions);
      // A corrupt session remains unavailable at its routes without preventing other sessions from starting.
      await Promise.allSettled(rows.map(row => enqueue(row.id, async () => { const session = await load(row.id); if (session) await runSchedule(row.id, session); })));
    }
    function stop() {
      stopped = true;
      clearInterval(recoveryTimer);
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
    return enqueue(id, async (): Promise<FrozenScoreSummary | null | undefined> => {
      const session = await load(id, userId);
      const binding = session && memberBinding(session.aggregate, userId);
      if (!session || !binding) return undefined;
      const participantId = binding.participantId;
      if (stopped || recovering.has(id)) throw new Error('Table Session is unavailable.');
      if (scope.scope === 'hand' && !session.game.getHand(scope.handId)) return null;
      const view = session.game.forParticipant(participantId).getView();
      const decisionIds = view.history.filter(hand => scope.scope === 'table-session' ? hand.result !== undefined : hand.handId === scope.handId).flatMap(hand => hand.decisions.filter(decision => decision.action.participantId === participantId).map(decision => decision.decisionId));
      const members = decisionIds.map(decisionId => captureEvaluation(session, participantId, decisionId)!);
      return immutableData({ participantId, tableSessionId: id, ...scope, capturedPokerRevision: session.aggregate.pokerRevision, referenceStrategy: binding.trainerConfiguration.referenceStrategy, decisionIds, members });
    });
  }
  return {
    // Historical work validates its frozen request/attempt in this queue; live revision may advance.
    acceptJobResult: (id: string, participantId: string, accept: () => boolean) => enqueue(id, async () => {
      const session = committed.get(id);
      if (stopped || !session || !isHuman(findBinding(session.aggregate, participantId))) return false;
      return accept();
    }),
    captureHandSummary: (id: string, userId: string, handId: string) => captureScoreSummary(id, userId, { scope: 'hand', handId }),
    captureSessionSummary: (id: string, userId: string) => captureScoreSummary(id, userId, { scope: 'table-session' }),
    captureEvaluation: (id: string, userId: string, decisionId: string) => enqueue(id, async (): Promise<FrozenEvaluationInput | null | undefined> => {
      const session = await load(id, userId);
      const participantId = viewer(session, userId);
      if (!session || !participantId) return undefined;
      if (stopped || recovering.has(id)) throw new Error('Table Session is unavailable.');
      return captureEvaluation(session, participantId, decisionId);
    }),
    /** The requesting Guest's joined Participant at a table, and whether they own it; undefined means not-found. */
    access,
    /** The Guest to notify for a joined human Participant of a loaded table. */
    controllerOf(id: string, participantId: string): string | undefined {
      const session = committed.get(id);
      const binding = session && findBinding(session.aggregate, participantId);
      return isHuman(binding) && binding.membership === 'joined' ? binding.userId : undefined;
    },
    read,
    subscribe,
    configure,
    join,
    previewJoin,
    resumeBots,
    startRecovery,
    stop,
    close,
    readPersistedSession,
    /** Use only after promoting confirmed durable state, including application-only mutations. */
    publishCommitted,
    publishStatus,
    submit: (id: string, userId: string, kind: PokerMutationKind, request: PokerMutationRequest) => submit(id, { kind: 'human', userId, receivedAt: clock.now() }, kind, request),
    submitControllerAction: (id: string, request: ActRequest) => submit(id, { kind: 'bot' }, 'act', request),
  };
}
