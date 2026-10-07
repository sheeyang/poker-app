import { and, eq } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { CashGame, type CashGameEvent } from '@poker/engine';
import type { ActRequest, MutationOutcome, TableLiveMessage, TableRuntimeStatus, PokerMutationRequest, SeatParticipantRequest, LeaveParticipantRequest, MoveParticipantRequest, SetSittingOutRequest, TopUpToRequest, SetButtonRequest } from '@poker/contracts';
import type { PersistedTableSession } from './aggregate.js';
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
}
type MutationAuthority = { kind: 'human'; userId: string } | { kind: 'bot' };
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
export function createTableSessionMutations(db: Database, faults?: MutationTransactionFaults) {
  const committed = new Map<string, CommittedSession>();
  const loading = new Map<string, Promise<CommittedSession | undefined>>();
  const queue = new Map<string, Promise<unknown>>();
  const recovering = new Set<string>();
  const subscribers = new Map<string, Set<{ ownerUserId: string; publish: (update: TableLiveMessage) => void }>>();
  const statuses = new Map<string, TableRuntimeStatus['status']>();
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
    const safeStatus = { phase: status.phase, ...(status.participantId ? { participantId: status.participantId } : {}), ...(status.message ? { message: status.message } : {}) };
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
    async function submit(id: string, authority: MutationAuthority, kind: PokerMutationKind, request: PokerMutationRequest): Promise<MutationOutcome> {
      const previous = queue.get(id) ?? Promise.resolve();
      const operation = previous.catch(() => undefined).then(async (): Promise<MutationOutcome> => {
        const session = await load(id, authority.kind === 'human' ? authority.userId : undefined);
        if (!session || (authority.kind === 'human' && session.aggregate.ownerUserId !== authority.userId)) return { ok: false, rejection: { code: 'not-found', message: 'This Table Session is unavailable to this local identity.' } };
        if (recovering.has(id)) return reject('session-recovering', 'This Table Session is paused while a commit outcome is unknown.');
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
                const aggregate: PersistedTableSession = { ...session.aggregate, pokerRecord: working.toRecord(), pokerRevision: session.aggregate.pokerRevision + 1, sessionRevision: session.aggregate.sessionRevision + 1 };
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
          if (proposed) { committed.set(id, proposed); publishCommitted(id, acceptedEvents); }
          return outcome;
        } catch (error) {
          if (commitAttempted) {
            recovering.add(id);
            publishStatus(id, { phase: 'recovering', message: 'This Table Session is paused while its commit outcome is unknown.' });
            throw new CommitOutcomeUnknown('Mutation COMMIT acknowledgement was not confirmed.', { cause: error });
          }
          throw error;
        }
      });
      queue.set(id, operation);
      try { return await operation; } finally { if (queue.get(id) === operation) queue.delete(id); }
    }
  return {
    read,
    subscribe,
    /** Use only after promoting confirmed durable state, including application-only mutations. */
    publishCommitted,
    publishStatus,
    submit: (id: string, ownerUserId: string, kind: PokerMutationKind, request: PokerMutationRequest) => submit(id, { kind: 'human', userId: ownerUserId }, kind, request),
    submitControllerAction: (id: string, request: ActRequest) => submit(id, { kind: 'bot' }, 'act', request),
  };
}
