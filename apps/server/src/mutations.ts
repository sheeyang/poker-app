import { baselineStrategy, isBaselineStrategy, immutableData, validatePolicyResult, PolicyValidationError, type Strategy } from '@poker/strategies';
import { JobRunner, JobFailure, type JobHandle, type JobFailureCode } from './job-runner.js';
import { and, eq } from 'drizzle-orm';
import { createHash, randomUUID } from 'node:crypto';
import { CashGame, deriveSeed, type CashGameEvent } from '@poker/engine';
import type { ConcreteAction, ObservableGameView, StrategyDescriptor, SetPlayingStrategyRequest, RetryBotRequest, ActRequest, MutationOutcome, TableLiveMessage, TableRuntimeStatus, PokerMutationRequest, SeatParticipantRequest, LeaveParticipantRequest, MoveParticipantRequest, SetSittingOutRequest, TopUpToRequest, SetButtonRequest } from '@poker/contracts';
import type { PersistedTableSession, BotActionProvenance } from './aggregate.js';
import type { openDatabase } from './db/database.js';
import { processedRequests, tableSessions } from './db/schema.js';
import { projectTableSession, projectTableUpdate } from './projection.js';
import { CommitOutcomeUnknown } from './creation.js';

type Database = ReturnType<typeof openDatabase>['db'];
type CommittedSession = { aggregate: PersistedTableSession; game: CashGame };
export class TableSessionRestorationError extends Error {
  constructor() { super('The complete committed Table Session could not be restored.'); }
}
export type PokerMutationKind = 'seat-participant' | 'start-hand' | 'act' | 'leave-participant' | 'move-participant' | 'set-sitting-out' | 'top-up-to' | 'set-button';
/** Internal controller authority. No browser route receives this capability. */
export interface TableSessionControllerCommands {
  submitAction(tableSessionId: string, request: ActRequest): Promise<MutationOutcome>;
  readPersistedSession(tableSessionId: string): Promise<PersistedTableSession | undefined>;
}
type MutationAuthority = { kind: 'human'; userId: string } | { kind: 'bot'; identity?: BotIdentity };
/** Test-only hooks wrap real PostgreSQL transactions and receive no mutable state. */
export interface MutationTransactionFaults {
  readonly beforeCommit?: (context: { readonly tableSessionId: string; readonly requestId: string }) => Promise<void>;
  readonly afterCommit?: (context: { readonly tableSessionId: string; readonly requestId: string }) => Promise<void>;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical((value as Record<string, unknown>)[key])).join(',') + '}';
  return JSON.stringify(value);
}
const reject = (code: string, message: string): MutationOutcome => ({ ok: false, rejection: { code, message } });
function applicationRejection(kind: PokerMutationKind, request: PokerMutationRequest): MutationOutcome | undefined {
  const commandFields: Record<PokerMutationKind, readonly string[]> = {
    'seat-participant': ['participantId', 'seat', 'buyIn'], 'start-hand': [], act: ['participantId', 'action'],
    'leave-participant': ['participantId'], 'move-participant': ['participantId', 'seat'], 'set-sitting-out': ['participantId', 'sittingOut'], 'top-up-to': ['participantId', 'targetStack'], 'set-button': ['seat'],
  };
  const fields = ['requestId', 'expectedPokerRevision', ...commandFields[kind]];
  if (Object.keys(request).some(key => !fields.includes(key)) || !Number.isSafeInteger(request.expectedPokerRevision) || request.expectedPokerRevision < 0)
    return reject('invalid-mutation-request', 'Supply supported mutation fields and a nonnegative expectedPokerRevision.');
}
type BotIdentity = Omit<BotActionProvenance, 'commandIndex'> & { readonly tableSessionId: string; readonly pokerRevision: number };
export interface BotRuntimeOptions {
  readonly runner: JobRunner;
  readonly automaticBots?: boolean;
  readonly strategyFactory?: (descriptor: StrategyDescriptor) => Strategy;
  readonly supportsStrategy?: (descriptor: unknown) => boolean;
}
export function createTableSessionMutations(db: Database, faults?: MutationTransactionFaults, bots?: BotRuntimeOptions) {
  const committed = new Map<string, CommittedSession>();
  const loading = new Map<string, Promise<CommittedSession | undefined>>();
  const queue = new Map<string, Promise<unknown>>();
  const recovering = new Set<string>();
  const subscribers = new Map<string, Set<{ ownerUserId: string; publish: (update: TableLiveMessage) => void }>>();
  const statuses = new Map<string, TableRuntimeStatus['status']>();
  const work = new Map<string, { identity: BotIdentity; handle?: JobHandle<ConcreteAction> }>();
  let stopped = false;
  const strategyFactory = bots?.strategyFactory ?? baselineStrategy;
  const supportsStrategy = bots?.supportsStrategy ?? isBaselineStrategy;
  function enqueue<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const previous = queue.get(id) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(operation);
    queue.set(id, next);
    return next.finally(() => { if (queue.get(id) === next) queue.delete(id); });
  }
  function capture(session: CommittedSession, evaluationRequestId: string) {
    const actor = session.game.forParticipant(session.aggregate.bindings[0]!.participantId).getView().state.actorId;
    const binding = session.aggregate.bindings.find(binding => binding.participantId === actor);
    if (!binding || binding.controller.kind !== 'bot') return undefined;
    const view = session.game.forParticipant(binding.participantId).getView();
    if (!view.state.handId || !view.state.decisionId) return undefined;
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
  function current(id: string, identity: BotIdentity): boolean {
    if (stopped || recovering.has(id) || work.get(id)?.identity.evaluationRequestId !== identity.evaluationRequestId) return false;
    const session = committed.get(id);
    const fresh = session && capture(session, identity.evaluationRequestId);
    return !!fresh && canonical(fresh.identity) === canonical(identity);
  }
  function retire(id: string) { const prior = work.get(id); work.delete(id); prior?.handle?.cancel(); }
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
    pending.handle = bots.runner.submit({ view: proposed.view, descriptor: proposed.identity.playingStrategy, evaluationSeed: proposed.identity.evaluationSeed, selectionSeed: proposed.identity.selectionSeed }, async (input, execution) => {
      const strategy = strategyFactory(input.descriptor);
      const compatibility = await strategy.policy.checkCompatibility(input.view);
      if (!compatibility.compatible) throw new JobFailure('incompatible');
      const raw = await strategy.policy.evaluate(input.view, { evaluationSeed: input.evaluationSeed, signal: execution.signal });
      let result;
      try { result = validatePolicyResult(raw, input.view); } catch (error) { if (error instanceof PolicyValidationError) throw new JobFailure('invalid-policy'); throw error; }
      try {
        const action = strategy.actionSelector.select(result.choices, { selectionSeed: input.selectionSeed });
        if (!result.choices.some(choice => canonical(choice.action) === canonical(action))) throw new Error('Not a Choice');
        return action;
      } catch { throw new JobFailure('selection-failed'); }
    });
    void pending.handle.result.then(result => {
      if (stopped) return;
      return enqueue(id, async () => {
        if (!current(id, pending.identity)) return;
        if (!result.ok) { publishStatus(id, { phase: 'failed', participantId: pending.identity.participantId, code: result.code }); return; }
        try {
          const outcome = await accept(id, { kind: 'bot', identity: pending.identity }, 'act', { requestId: 'bot:' + pending.identity.evaluationRequestId, expectedPokerRevision: pending.identity.pokerRevision, participantId: pending.identity.participantId, action: result.value });
          if (!outcome.ok && current(id, pending.identity)) publishStatus(id, { phase: 'failed', participantId: pending.identity.participantId, code: 'failed' });
        } catch { if (current(id, pending.identity)) publishStatus(id, { phase: 'failed', participantId: pending.identity.participantId, code: 'failed' }); }
      });
    }).catch(() => {});
  }
  function observer(session: CommittedSession | undefined, ownerUserId: string) {
    if (!session || session.aggregate.ownerUserId !== ownerUserId) return undefined;
    return session.aggregate.bindings.find(b => b.controller.kind === 'human' && b.userId === ownerUserId)?.participantId;
  }
  function deliver(id: string, projection: (session: CommittedSession, participantId: string) => TableLiveMessage) {
    const session = committed.get(id);
    const entries = subscribers.get(id);
    if (!session || !entries) return;
    for (const entry of entries) {
      const participantId = observer(session, entry.ownerUserId);
      if (!participantId) { entries.delete(entry); continue; }
      // A delivery failure cannot change a confirmed mutation's outcome.
      try { entry.publish(projection(session, participantId)); } catch { entries.delete(entry); }
    }
    if (entries.size === 0) subscribers.delete(id);
  }
  function publishCommitted(id: string, events: readonly CashGameEvent[] = []) {
    deliver(id, (session, participantId) => projectTableUpdate(session.aggregate, participantId, session.game, events));
  }
  function publishStatus(id: string, status: TableRuntimeStatus['status']) {
    if (stopped) return;
    if (recovering.has(id) && status.phase !== 'recovering') return;
    const failures: Record<JobFailureCode, string> = { capacity: 'The computation queue is full. Retry this Bot decision.', cancelled: 'Bot computation was cancelled. Retry this decision.', timeout: 'Bot computation timed out. Retry or change its Playing Strategy.', failed: 'Bot computation failed. Retry or change its Playing Strategy.', incompatible: 'This Playing Strategy does not support the current decision.', 'invalid-policy': 'The Policy returned an invalid distribution. Retry or change its Playing Strategy.', 'selection-failed': 'The Action Selector could not select a valid Choice.' };
    const code = status.code && Object.hasOwn(failures, status.code) ? status.code : 'failed';
    const safeStatus: TableRuntimeStatus['status'] = { phase: status.phase, ...(status.participantId ? { participantId: status.participantId } : {}),
      ...(status.phase === 'failed' ? { code, message: failures[code] } : status.phase === 'recovering' ? { message: 'This Table Session is paused while its commit outcome is unknown.' } : {}) };
    statuses.set(id, safeStatus);
    deliver(id, () => ({ type: 'table-status', tableSessionId: id, status: safeStatus }));
  }
  async function load(id: string, ownerUserId?: string): Promise<CommittedSession | undefined> {
    const cached = committed.get(id);
    if (cached) return ownerUserId && cached.aggregate.ownerUserId !== ownerUserId ? undefined : cached;
    if (ownerUserId) {
      const owned = await db.select({ id: tableSessions.id }).from(tableSessions).where(and(eq(tableSessions.id, id), eq(tableSessions.ownerUserId, ownerUserId)));
      if (!owned.length) return undefined;
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
  async function restore(id: string): Promise<CommittedSession | undefined> {
    const rows = await db.select().from(tableSessions).where(eq(tableSessions.id, id));
    const aggregate = rows[0]?.aggregate;
    if (!aggregate) return undefined;
    const restored = CashGame.fromRecord(aggregate.pokerRecord);
    if (!restored.ok) throw new TableSessionRestorationError();
    const session = { aggregate, game: restored.game };
    committed.set(id, session);
    if (!stopped) queueMicrotask(() => { void enqueue(id, async () => { const currentSession = committed.get(id); if (currentSession) ensureBot(id, currentSession); }).catch(() => {}); });
    return session;
  }
    async function read(id: string, ownerUserId: string) {
      await load(id, ownerUserId);
      const session = committed.get(id);
      const participantId = observer(session, ownerUserId);
      if (!session || !participantId) return undefined;
      return projectTableSession(session.aggregate, participantId, session.game);
    }
    async function subscribe(id: string, ownerUserId: string, publish: (update: TableLiveMessage) => void) {
      await load(id, ownerUserId);
      const session = committed.get(id);
      const participantId = observer(session, ownerUserId);
      if (!session || !participantId) return undefined;
      const entries = subscribers.get(id) ?? new Set();
      const entry = { ownerUserId, publish };
      entries.add(entry);
      subscribers.set(id, entries);
      // No facade is retained: each projection binds the current committed game.
      try {
        publish(projectTableUpdate(session.aggregate, participantId, session.game));
        const status = statuses.get(id);
        if (status) publish({ type: 'table-status', tableSessionId: id, status });
      } catch (error) {
        entries.delete(entry); if (entries.size === 0) subscribers.delete(id);
        throw error;
      }
      return () => { entries.delete(entry); if (entries.size === 0) subscribers.delete(id); };
    }
    async function accept(id: string, authority: MutationAuthority, kind: PokerMutationKind, request: PokerMutationRequest): Promise<MutationOutcome> {
        const session = await load(id, authority.kind === 'human' ? authority.userId : undefined);
        if (!session || (authority.kind === 'human' && session.aggregate.ownerUserId !== authority.userId)) return { ok: false, rejection: { code: 'not-found', message: 'This Table Session is unavailable to this local identity.' } };
        if (stopped) return reject('server-closing', 'The server is closing.');
        if (recovering.has(id)) return reject('session-recovering', 'This Table Session is paused while a commit outcome is unknown.');
        if (authority.kind === 'bot' && authority.identity && !current(id, authority.identity)) return reject('obsolete-bot-work', 'The Bot decision changed.');
        const { requestId, ...contents } = request;
        const fingerprint = createHash('sha256').update('poker-mutation-v1:' + canonical({ source: authority.kind, kind, contents })).digest('hex');
        let proposed: CommittedSession | undefined;
        let acceptedEvents: readonly CashGameEvent[] = [];
        let commitAttempted = false;
        let newlyProcessed = false;
        const context = { tableSessionId: id, requestId };
        try {
          const outcome = await db.transaction(async (tx): Promise<MutationOutcome> => {
            const rows = await tx.select().from(processedRequests).where(and(eq(processedRequests.tableSessionId, id), eq(processedRequests.requestId, requestId)));
            const known = rows[0];
            if (known) return known.fingerprint === fingerprint ? known.outcome : reject('request-id-conflict', 'This requestId was already used for different mutation contents.');
            let result = applicationRejection(kind, request);
            if (!result && request.expectedPokerRevision !== session.aggregate.pokerRevision) result = reject('stale-poker-revision', 'The table changed. Refresh its committed view before submitting a new attempt.');
            const participantId = 'participantId' in request ? request.participantId : undefined;
            const binding = session.aggregate.bindings.find(binding => binding.participantId === participantId);
            if (!result && kind !== 'start-hand' && kind !== 'set-button' && !binding) result = reject('participant-not-bound', 'Choose a Participant assigned to this Table Session.');
            if (!result && kind === 'act' && (authority.kind === 'human'
              ? binding?.controller.kind !== 'human' || binding.userId !== authority.userId
              : binding?.controller.kind !== 'bot')) result = reject('actor-not-authorized', authority.kind === 'human'
                ? 'This local identity can act only through its bound human Participant.'
                : 'Trusted controller commands can act only through a bound Bot.');
            if (!result) {
              const working = session.game.fork();
              const accepted = (() => {
                switch (kind) {
                  case 'start-hand': return working.startHand();
                  case 'act': return working.act((request as ActRequest).participantId, (request as ActRequest).action);
                  case 'seat-participant': return working.seatParticipant((request as SeatParticipantRequest).participantId, (request as SeatParticipantRequest).seat, (request as SeatParticipantRequest).buyIn);
                  case 'leave-participant': return working.leaveParticipant((request as LeaveParticipantRequest).participantId);
                  case 'move-participant': return working.moveParticipant((request as MoveParticipantRequest).participantId, (request as MoveParticipantRequest).seat);
                  case 'set-sitting-out': return working.setSittingOut((request as SetSittingOutRequest).participantId, (request as SetSittingOutRequest).sittingOut);
                  case 'top-up-to': return working.topUpTo((request as TopUpToRequest).participantId, (request as TopUpToRequest).targetStack);
                  case 'set-button': return working.setButton((request as SetButtonRequest).seat);
                }
              })();
              if (!accepted.ok) result = { ok: false, rejection: accepted.rejection };
              else {
                acceptedEvents = accepted.events;
                const pokerRecord = working.toRecord();
                const provenance = authority.kind === 'bot' && authority.identity ? (() => {
                  const { tableSessionId: _table, pokerRevision: _revision, ...identity } = authority.identity;
                  return { ...identity, commandIndex: pokerRecord.commands.length - 1 };
                })() : undefined;
                const aggregate: PersistedTableSession = { ...session.aggregate, pokerRecord, pokerRevision: session.aggregate.pokerRevision + 1, sessionRevision: session.aggregate.sessionRevision + 1,
                  ...(provenance ? { botProvenance: [...(session.aggregate.botProvenance ?? []), provenance] } : {}) };
                proposed = { aggregate, game: working };
                await tx.update(tableSessions).set({ aggregate }).where(eq(tableSessions.id, id));
                result = { ok: true, tableSessionId: id, pokerRevision: aggregate.pokerRevision, sessionRevision: aggregate.sessionRevision };
              }
            }
            await tx.insert(processedRequests).values({ tableSessionId: id, requestId, fingerprint, outcome: result });
            await faults?.beforeCommit?.(context);
            commitAttempted = true;
            newlyProcessed = true;
            return result;
          });
          if (newlyProcessed) await faults?.afterCommit?.(context);
          if (proposed) { committed.set(id, proposed); publishCommitted(id, acceptedEvents); ensureBot(id, proposed); }
          return outcome;
        } catch (error) {
          if (commitAttempted) {
            recovering.add(id);
            retire(id);
            publishStatus(id, { phase: 'recovering', message: 'This Table Session is paused while its commit outcome is unknown.' });
            throw new CommitOutcomeUnknown('Mutation COMMIT acknowledgement was not confirmed.', { cause: error });
          }
          throw error;
        }
    }
    function submit(id: string, authority: MutationAuthority, kind: PokerMutationKind, request: PokerMutationRequest) {
      return enqueue(id, () => accept(id, authority, kind, request));
    }
    async function configure(id: string, ownerUserId: string, kind: 'set-playing-strategy' | 'retry-bot', request: SetPlayingStrategyRequest | RetryBotRequest): Promise<MutationOutcome> {
      return enqueue(id, async () => {
        const session = await load(id, ownerUserId);
        if (!session || session.aggregate.ownerUserId !== ownerUserId) return reject('not-found', 'This Table Session is unavailable to this local identity.');
        if (stopped || recovering.has(id)) return reject('session-recovering', 'This Table Session is paused.');
        const { requestId, ...contents } = request;
        const fingerprint = createHash('sha256').update('controller-mutation-v1:' + canonical({ ownerUserId, kind, contents })).digest('hex');
        let proposed: CommittedSession | undefined;
        let fresh = false;
        let commitAttempted = false;
        try {
          const outcome = await db.transaction(async tx => {
            const rows = await tx.select().from(processedRequests).where(and(eq(processedRequests.tableSessionId, id), eq(processedRequests.requestId, requestId)));
            if (rows[0]) return rows[0].fingerprint === fingerprint ? rows[0].outcome : reject('request-id-conflict', 'This requestId was already used for different mutation contents.');
            const fields = ['requestId', 'expectedSessionRevision', 'participantId', ...(kind === 'set-playing-strategy' ? ['playingStrategy'] : [])];
            let result: MutationOutcome | undefined;
            if (Object.keys(request).some(key => !fields.includes(key)) || !Number.isSafeInteger(request.expectedSessionRevision) || request.expectedSessionRevision < 0) result = reject('invalid-controller-request', 'Supply supported controller fields and a nonnegative expectedSessionRevision.');
            if (!result && request.expectedSessionRevision !== session.aggregate.sessionRevision) result = reject('stale-session-revision', 'The table changed. Refresh before submitting a new controller request.');
            const binding = session.aggregate.bindings.find(binding => binding.participantId === request.participantId);
            if (!result && binding?.controller.kind !== 'bot') result = reject('participant-not-bot', 'Choose a bound Bot.');
            if (!result && kind === 'set-playing-strategy' && !supportsStrategy((request as SetPlayingStrategyRequest).playingStrategy)) result = reject('unsupported-strategy', 'Choose a supported complete Playing Strategy.');
            if (!result && kind === 'retry-bot' && capture(session, '')?.identity.participantId !== request.participantId) result = reject('bot-not-current', 'Retry is available only for the current Bot decision.');
            if (!result && kind === 'set-playing-strategy') {
              const aggregate: PersistedTableSession = { ...session.aggregate, sessionRevision: session.aggregate.sessionRevision + 1,
                bindings: session.aggregate.bindings.map(item => item.participantId === request.participantId ? { ...item, assignmentId: randomUUID(), controller: { kind: 'bot', playingStrategy: immutableData((request as SetPlayingStrategyRequest).playingStrategy) } } : item) };
              proposed = { aggregate, game: session.game };
              await tx.update(tableSessions).set({ aggregate }).where(eq(tableSessions.id, id));
            }
            result ??= { ok: true, tableSessionId: id, pokerRevision: session.aggregate.pokerRevision, sessionRevision: proposed?.aggregate.sessionRevision ?? session.aggregate.sessionRevision };
            await tx.insert(processedRequests).values({ tableSessionId: id, requestId, fingerprint, outcome: result });
            await faults?.beforeCommit?.({ tableSessionId: id, requestId });
            commitAttempted = true; fresh = true;
            return result;
          });
          if (fresh) await faults?.afterCommit?.({ tableSessionId: id, requestId });
          if (proposed) { committed.set(id, proposed); publishCommitted(id); }
          if (fresh && outcome.ok) ensureBot(id, proposed ?? session, kind === 'retry-bot');
          return outcome;
        } catch (error) {
          if (commitAttempted) { recovering.add(id); retire(id); publishStatus(id, { phase: 'recovering' }); throw new CommitOutcomeUnknown('Controller COMMIT confirmation was lost.', { cause: error }); }
          throw error;
        }
      });
    }
    async function readPersistedSession(id: string) {
      const rows = await db.select().from(tableSessions).where(eq(tableSessions.id, id));
      const aggregate = rows[0]?.aggregate;
      if (!aggregate) return undefined;
      if (!CashGame.fromRecord(aggregate.pokerRecord).ok) throw new TableSessionRestorationError();
      return immutableData(aggregate);
    }
    async function resumeBots() {
      const rows = await db.select({ id: tableSessions.id }).from(tableSessions);
      // A corrupt session remains unavailable at its routes without preventing other sessions from starting.
      await Promise.allSettled(rows.map(row => enqueue(row.id, async () => { const session = await load(row.id); if (session) ensureBot(row.id, session); })));
    }
    async function close() {
      stopped = true;
      for (const id of work.keys()) retire(id);
      await bots?.runner.close();
      await Promise.allSettled([...queue.values()]);
    }
  return {
    read,
    subscribe,
    configure,
    resumeBots,
    close,
    readPersistedSession,
    /** Use only after promoting confirmed durable state, including application-only mutations. */
    publishCommitted,
    publishStatus,
    submit: (id: string, ownerUserId: string, kind: PokerMutationKind, request: PokerMutationRequest) => submit(id, { kind: 'human', userId: ownerUserId }, kind, request),
    submitControllerAction: (id: string, request: ActRequest) => submit(id, { kind: 'bot' }, 'act', request),
  };
}
