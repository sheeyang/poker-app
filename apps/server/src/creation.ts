import { isBaselineStrategy } from '@poker/strategies';
import { validateCreationRequest } from './validation.js';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { defaultConfiguration, type CreateTableSessionRequest, type CreationOutcome } from '@poker/contracts';
import { CashGame } from '@poker/engine';
import type { PersistedTableSession } from './aggregate.js';
import { creationRequests, tableSessions } from './db/schema.js';
import type { openDatabase } from './db/database.js';
import { projectBindings } from './projection.js';
type Database = ReturnType<typeof openDatabase>['db'];
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical((value as Record<string, unknown>)[key])).join(',') + '}';
  return JSON.stringify(value);
}
export class CommitOutcomeUnknown extends Error {}
/** Test tooling wraps the real transaction; these hooks are never HTTP endpoints. */
export interface CreationTransactionFaults { readonly beforeCommit?: () => Promise<void>; readonly afterCommit?: () => Promise<void> }
export function createTableSessionCreator(db: Database, faults?: CreationTransactionFaults, supportsStrategy: (descriptor: unknown) => boolean = isBaselineStrategy) {
  const queue = new Map<string, Promise<unknown>>();
  const pending = new Set<string>();
  return async (ownerUserId: string, request: CreateTableSessionRequest): Promise<CreationOutcome> => {
    const prior = queue.get(ownerUserId) ?? Promise.resolve();
    const operation = prior.catch(() => undefined).then(async (): Promise<CreationOutcome> => {
      const { requestId, ...contents } = request;
      const fingerprint = createHash('sha256').update('create-table-v1:' + canonical(contents)).digest('hex');
      const pendingKey = ownerUserId + ':' + requestId;
      if (pending.has(pendingKey)) {
        const rows = await db.select().from(creationRequests).where(and(eq(creationRequests.userId, ownerUserId), eq(creationRequests.requestId, requestId)));
        const known = rows[0];
        if (!known) throw new CommitOutcomeUnknown('The earlier creation transaction remains unresolved.');
        pending.delete(pendingKey);
        return known.fingerprint === fingerprint ? known.outcome : { ok: false, rejection: { code: 'request-id-conflict', message: 'This requestId was already used for different creation contents.' } };
      }
      let commitAttempted = false;
      let newlyProcessed = false;
      try {
      const outcome = await db.transaction(async (tx): Promise<CreationOutcome> => {
        const rows = await tx.select().from(creationRequests).where(and(eq(creationRequests.userId, ownerUserId), eq(creationRequests.requestId, requestId)));
        const existing = rows[0];
        if (existing) return existing.fingerprint === fingerprint ? existing.outcome : {
          ok: false, rejection: { code: 'request-id-conflict', message: 'This requestId was already used for different creation contents.' },
        };
        const created = validateCreationRequest(request, supportsStrategy) ?? CashGame.create({ ...defaultConfiguration, ...request.configuration, seed: randomBytes(32).toString('hex') });
        let outcome: CreationOutcome;
        if (!created.ok) outcome = { ok: false, rejection: created.rejection };
        else {
          const tableSessionId = randomUUID();
          const bindings: PersistedTableSession['bindings'] = [
            { participantId: randomUUID(), name: 'You', controller: { kind: 'human' }, userId: ownerUserId },
            ...(request.bots ?? []).map(b => ({ participantId: randomUUID(), name: b.name, controller: { kind: 'bot' as const, playingStrategy: b.playingStrategy }, assignmentId: randomUUID() })),
          ];
          const aggregate: PersistedTableSession = {
            schemaVersion: 1, tableSessionId, ownerUserId, pokerRecord: created.game.toRecord(), bindings,
            pokerRevision: 0, sessionRevision: 0, adminMode: true, botProvenance: [],
          };
          await tx.insert(tableSessions).values({ id: tableSessionId, ownerUserId, aggregate });
          outcome = { ok: true, tableSessionId, bindings: projectBindings(bindings) };
        }
        await tx.insert(creationRequests).values({ userId: ownerUserId, requestId, fingerprint, outcome });
        await faults?.beforeCommit?.();
        commitAttempted = true;
        newlyProcessed = true;
        return outcome;
      });
      if (newlyProcessed) await faults?.afterCommit?.();
      return outcome;
      } catch (error) {
        if (commitAttempted) {
          pending.add(pendingKey);
          throw new CommitOutcomeUnknown('Creation COMMIT acknowledgement was not confirmed.', { cause: error });
        }
        throw error;
      }
    });
    queue.set(ownerUserId, operation);
    try { return await operation; } finally { if (queue.get(ownerUserId) === operation) queue.delete(ownerUserId); }
  };
}
