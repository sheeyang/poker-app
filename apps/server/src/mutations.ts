import { createStrategy, isSupportedStrategy, immutableData, type Strategy } from '@poker/strategies';
import { JobRunner, type JobHandle } from './job-runner.js';
import { and, eq } from 'drizzle-orm';
import { createHash, randomUUID } from 'node:crypto';
import { CashGame, deriveSeed, type CashGameEvent } from '@poker/engine';
import type { ConcreteAction, ObservableGameView, StrategyDescriptor, SetPlayingStrategyRequest, SetTrainerConfigurationRequest, RetryBotRequest, ActRequest, MutationOutcome, TableLiveMessage, TableRuntimeStatus, PokerMutationRequest, SeatParticipantRequest, StandUpParticipantRequest, MoveParticipantRequest, SetSittingOutRequest, TopUpToRequest, SetButtonRequest } from '@poker/contracts';
import { findBinding, humanBindings, isBot, isHuman, memberBinding, upgradeTableSession, type PersistedHumanBinding, type PersistedTableSession, type BotActionProvenance, type StoredTableSession } from './aggregate.js';
import type { openDatabase } from './db/database.js';
import { creationRequests, processedRequests, tableSessions } from './db/schema.js';
import { membership, writeTableSession } from './membership.js';
import { projectTableSession, projectTableUpdate } from './projection.js';
import { CommitOutcomeUnknown } from './creation.js';
import { AcceptanceTransactions, type AcceptanceFaults } from './db/acceptance.js';
import { canonical } from './canonical.js';
import { executeStrategy } from './strategy-execution.js';
import type { FrozenEvaluationInput } from './analysis.js';
import type { FrozenScoreSummary } from './summaries.js';
import { validateTrainerConfiguration } from './validation.js';

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
type MutationAuthority = { kind: 'human'; userId: string } | { kind: 'bot'; identity?: BotIdentity };
interface AcceptedHumanIntent { readonly participantId: string; readonly decisionId: string; readonly fingerprint: string }
/** Test-only hooks wrap real PostgreSQL transactions and receive no mutable state. */
export interface MutationTransactionFaults extends AcceptanceFaults {
  readonly beforeCommit?: (context: { readonly tableSessionId: string; readonly requestId: string }) => Promise<void>;
  readonly afterCommit?: (context: { readonly tableSessionId: string; readonly requestId: string }) => Promise<void>;
}
const reject = (code: string, message: string): MutationOutcome => ({ ok: false, rejection: { code, message } });
const notFound = () => reject('not-found', 'This Table Session is unavailable to this local identity.');
const ownerRequired = () => reject('table-owner-required', 'Only the Table Owner can deal, manage Bots or change table options.');
/**
 * Who may ask for what, decided before request idempotency, so a remembered outcome is only ever replayed to
 * a requester who may make that request. Unknown Participants and acting as a Bot stay definitive rejections.
 */
function humanMutationDenial(aggregate: PersistedTableSession, requester: PersistedHumanBinding, kind: PokerMutationKind, request: PokerMutationRequest): MutationOutcome | undefined {
  const owner = aggregate.ownerUserId === requester.userId;
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
export function createTableSessionMutations(db: Database, acceptance: AcceptanceTransactions, faults?: MutationTransactionFaults, bots?: BotRuntimeOptions) {
  const committed = new Map<string, CommittedSession>();
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
      const session = committed.get(id); if (session) ensureBot(id, session, true);
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
  function ensureBot(id: string, session: CommittedSession, force = false) {
    if (stopped || recovering.has(id) || !bots || bots.automaticBots === false) return;
    const proposed = capture(session, randomUUID());
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
    deliver(id, (session, participantId) => projectTableUpdate(session.aggregate, participantId, session.game, events, bots?.adminMode !== false));
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
  async function access(id: string, userId: string): Promise<{ participantId: string; owner: boolean } | undefined> {
    const cached = committed.get(id);
    if (!cached) return membership(db, id, userId);
    const binding = memberBinding(cached.aggregate, userId);
    return binding && { participantId: binding.participantId, owner: cached.aggregate.ownerUserId === userId };
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
  /** Upgrades any stored version and validates it completely, or throws TableSessionRestorationError. */
  function restorable(stored: StoredTableSession): CommittedSession {
    const aggregate = upgradeTableSession(stored);
    if (humanBindings(aggregate).some(binding => validateTrainerConfiguration(binding.trainerConfiguration, supportsStrategy))) throw new TableSessionRestorationError();
    const restored = CashGame.fromRecord(aggregate.pokerRecord);
    if (!restored.ok) throw new TableSessionRestorationError();
    return { aggregate, game: restored.game };
  }
  async function restore(id: string): Promise<CommittedSession | undefined> {
    const rows = await db.select().from(tableSessions).where(eq(tableSessions.id, id));
    const stored = rows[0]?.aggregate;
    if (!stored) return undefined;
    const session = restorable(stored);
    committed.set(id, session);
    if (!stopped) queueMicrotask(() => { void enqueue(id, async () => { const currentSession = committed.get(id); if (currentSession) ensureBot(id, currentSession); }).catch(() => {}); });
    return session;
  }
    async function read(id: string, userId: string) {
      await load(id, userId);
      const session = committed.get(id);
      const participantId = viewer(session, userId);
      if (!session || !participantId) return undefined;
      const projected = projectTableSession(session.aggregate, participantId, session.game, bots?.adminMode !== false);
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
        publish({ ...projectTableUpdate(session.aggregate, participantId, session.game, [], bots?.adminMode !== false), runtimeStatus: statuses.get(id) ?? { phase: 'idle' } });
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
            if (!result && request.expectedPokerRevision !== session.aggregate.pokerRevision) result = reject('stale-poker-revision', 'The table changed. Refresh its committed view before submitting a new attempt.');
            const binding = findBinding(session.aggregate, 'participantId' in request ? request.participantId : undefined);
            if (!result && kind !== 'start-hand' && kind !== 'set-button' && !binding) result = reject('participant-not-bound', 'Choose a Participant assigned to this Table Session.');
            if (!result && kind === 'act' && (authority.kind === 'human'
              ? !isHuman(binding) || binding.userId !== authority.userId
              : !isBot(binding))) result = reject('actor-not-authorized', authority.kind === 'human'
                ? 'This local identity can act only through its bound human Participant.'
                : 'Trusted controller commands can act only through a bound Bot.');
            if (!result) {
              const working = session.game.fork();
              const accepted = (() => {
                switch (kind) {
                  case 'start-hand': return working.startHand();
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
                if (authority.kind === 'human' && kind === 'act') acceptedHumanDecision = session.game.forParticipant((request as ActRequest).participantId).getView().state.decisionId ?? undefined;
                const pokerRecord = working.toRecord();
                const provenance = authority.kind === 'bot' && authority.identity ? (() => {
                  const { tableSessionId: _table, pokerRevision: _revision, ...identity } = authority.identity;
                  return { ...identity, commandIndex: pokerRecord.commands.length - 1 };
                })() : undefined;
                const aggregate: PersistedTableSession = { ...session.aggregate, pokerRecord, pokerRevision: session.aggregate.pokerRevision + 1, sessionRevision: session.aggregate.sessionRevision + 1,
                  ...(provenance ? { botProvenance: [...(session.aggregate.botProvenance ?? []), provenance] } : {}) };
                proposed = { aggregate, game: working };
                await writeTableSession(tx, session.aggregate, aggregate);
                result = { ok: true, tableSessionId: id, pokerRevision: aggregate.pokerRevision, sessionRevision: aggregate.sessionRevision };
              }
            }
            await tx.insert(processedRequests).values({ tableSessionId: id, requestId, fingerprint, outcome: result });
            return result;
          }, { ...faults, beforeCommit: () => faults?.beforeCommit?.(context) ?? Promise.resolve(), afterCommit: () => faults?.afterCommit?.(context) ?? Promise.resolve() });
          if (proposed) {
            committed.set(id, proposed); publishCommitted(id, acceptedEvents); ensureBot(id, proposed);
            if (authority.kind === 'human' && acceptedHumanDecision) analyzeAccepted(proposed, (request as ActRequest).participantId, acceptedHumanDecision);
          }
          return outcome;
        } catch (error) {
          if (error instanceof CommitOutcomeUnknown) {
            if (authority.kind === 'human' && acceptedHumanDecision) uncertainHumanActions.set(actionKey(id, requestId), { participantId: (request as ActRequest).participantId, decisionId: acceptedHumanDecision, fingerprint });
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
          if (fresh && outcome.ok && kind !== 'set-trainer-configuration') ensureBot(id, proposed ?? session, kind === 'retry-bot');
          return outcome;
        } catch (error) {
          if (error instanceof CommitOutcomeUnknown) pause(id);
          throw error;
        }
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
      await Promise.allSettled(rows.map(row => enqueue(row.id, async () => { const session = await load(row.id); if (session) ensureBot(row.id, session); })));
    }
    function stop() {
      stopped = true;
      clearInterval(recoveryTimer);
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
      const decisionIds = view.history.filter(hand => scope.scope === 'table-session' || hand.handId === scope.handId).flatMap(hand => hand.decisions.filter(decision => decision.action.participantId === participantId).map(decision => decision.decisionId));
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
    resumeBots,
    startRecovery,
    stop,
    close,
    readPersistedSession,
    /** Use only after promoting confirmed durable state, including application-only mutations. */
    publishCommitted,
    publishStatus,
    submit: (id: string, userId: string, kind: PokerMutationKind, request: PokerMutationRequest) => submit(id, { kind: 'human', userId }, kind, request),
    submitControllerAction: (id: string, request: ActRequest) => submit(id, { kind: 'bot' }, 'act', request),
  };
}
