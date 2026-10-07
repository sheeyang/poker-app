import { and, eq } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { CashGame } from '@poker/engine';
import type { MutationOutcome, SeatParticipantRequest } from '@poker/contracts';
import type { PersistedTableSession } from './aggregate.js';
import type { openDatabase } from './db/database.js';
import { processedRequests, tableSessions } from './db/schema.js';
import { projectTableSession } from './projection.js';
import { CommitOutcomeUnknown } from './creation.js';

type Database = ReturnType<typeof openDatabase>['db'];
type CommittedSession = { aggregate: PersistedTableSession; game: CashGame };
export type PokerMutationKind = 'seat-participant';
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
function applicationRejection(request: SeatParticipantRequest): MutationOutcome | undefined {
  if (Object.keys(request).some(key => !['requestId', 'expectedPokerRevision', 'participantId', 'seat', 'buyIn'].includes(key)) || !Number.isSafeInteger(request.expectedPokerRevision) || request.expectedPokerRevision < 0)
    return reject('invalid-mutation-request', 'Supply supported seating fields and a nonnegative expectedPokerRevision.');
}
export function createTableSessionMutations(db: Database, faults?: MutationTransactionFaults) {
  const committed = new Map<string, CommittedSession>();
  const loading = new Map<string, Promise<CommittedSession | undefined>>();
  const queue = new Map<string, Promise<unknown>>();
  const recovering = new Set<string>();
  async function load(id: string): Promise<CommittedSession | undefined> {
    const cached = committed.get(id);
    if (cached) return cached;
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
    if (!restored.ok) throw new Error('Committed CashGame record could not be restored.');
    const session = { aggregate, game: restored.game };
    committed.set(id, session);
    return session;
  }
  return {
    async read(id: string, ownerUserId: string) {
      const session = await load(id);
      if (!session || session.aggregate.ownerUserId !== ownerUserId) return undefined;
      const participant = session.aggregate.bindings.find(b => b.controller.kind === 'human' && b.userId === ownerUserId);
      if (!participant) throw new Error('Owned session has no bound human Participant.');
      return projectTableSession(session.aggregate, participant.participantId, session.game);
    },
    async submit(id: string, ownerUserId: string, kind: PokerMutationKind, request: SeatParticipantRequest): Promise<MutationOutcome> {
      const previous = queue.get(id) ?? Promise.resolve();
      const operation = previous.catch(() => undefined).then(async (): Promise<MutationOutcome> => {
        const session = await load(id);
        if (!session || session.aggregate.ownerUserId !== ownerUserId) return { ok: false, rejection: { code: 'not-found', message: 'This Table Session is unavailable to this local identity.' } };
        if (recovering.has(id)) return reject('session-recovering', 'This Table Session is paused while a commit outcome is unknown.');
        const { requestId, ...contents } = request;
        const fingerprint = createHash('sha256').update('poker-mutation-v1:' + canonical({ kind, contents })).digest('hex');
        let proposed: CommittedSession | undefined;
        let commitAttempted = false;
        let newlyProcessed = false;
        const context = { tableSessionId: id, requestId };
        try {
          const outcome = await db.transaction(async (tx): Promise<MutationOutcome> => {
            const rows = await tx.select().from(processedRequests).where(and(eq(processedRequests.tableSessionId, id), eq(processedRequests.requestId, requestId)));
            const known = rows[0];
            if (known) return known.fingerprint === fingerprint ? known.outcome : reject('request-id-conflict', 'This requestId was already used for different mutation contents.');
            let result = applicationRejection(request);
            if (!result && request.expectedPokerRevision !== session.aggregate.pokerRevision) result = reject('stale-poker-revision', 'The table changed. Refresh its committed view before submitting a new attempt.');
            if (!result && !session.aggregate.bindings.some(binding => binding.participantId === request.participantId)) result = reject('participant-not-bound', 'Choose a Participant assigned to this Table Session.');
            if (!result) {
              const working = session.game.fork();
              const accepted = working.seatParticipant(request.participantId, request.seat, request.buyIn);
              if (!accepted.ok) result = { ok: false, rejection: accepted.rejection };
              else {
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
          if (proposed) committed.set(id, proposed);
          return outcome;
        } catch (error) {
          if (commitAttempted) {
            recovering.add(id);
            throw new CommitOutcomeUnknown('Mutation COMMIT acknowledgement was not confirmed.', { cause: error });
          }
          throw error;
        }
      });
      queue.set(id, operation);
      try { return await operation; } finally { if (queue.get(id) === operation) queue.delete(id); }
    },
  };
}
