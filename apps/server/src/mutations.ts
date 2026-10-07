import { and, eq } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { CashGame } from '@poker/engine';
import type { ActRequest, MutationOutcome, PokerMutationRequest, SeatParticipantRequest, LeaveParticipantRequest, MoveParticipantRequest, SetSittingOutRequest, TopUpToRequest, SetButtonRequest } from '@poker/contracts';
import type { PersistedTableSession } from './aggregate.js';
import type { openDatabase } from './db/database.js';
import { processedRequests, tableSessions } from './db/schema.js';
import { projectTableSession } from './projection.js';
import { CommitOutcomeUnknown } from './creation.js';

type Database = ReturnType<typeof openDatabase>['db'];
type CommittedSession = { aggregate: PersistedTableSession; game: CashGame };
export type PokerMutationKind = 'seat-participant' | 'start-hand' | 'act' | 'leave-participant' | 'move-participant' | 'set-sitting-out' | 'top-up-to' | 'set-button';
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
    async submit(id: string, ownerUserId: string, kind: PokerMutationKind, request: PokerMutationRequest): Promise<MutationOutcome> {
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
            let result = applicationRejection(kind, request);
            if (!result && request.expectedPokerRevision !== session.aggregate.pokerRevision) result = reject('stale-poker-revision', 'The table changed. Refresh its committed view before submitting a new attempt.');
            const participantId = 'participantId' in request ? request.participantId : undefined;
            const binding = session.aggregate.bindings.find(binding => binding.participantId === participantId);
            if (!result && kind !== 'start-hand' && kind !== 'set-button' && !binding) result = reject('participant-not-bound', 'Choose a Participant assigned to this Table Session.');
            if (!result && kind === 'act' && (binding?.controller.kind !== 'human' || binding.userId !== ownerUserId)) result = reject('actor-not-authorized', 'This local identity can act only through its bound human Participant.');
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
