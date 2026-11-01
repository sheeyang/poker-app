import { isSupportedStrategy } from '@poker/strategies';
import { nameKey, validateCreationRequest } from './validation.js';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { defaultConfiguration, defaultOnlineActionTimeLimitSeconds, defaultTrainerConfiguration, type CreateTableSessionRequest, type CreationOutcome, type TableOptions } from '@poker/contracts';
import { CashGame } from '@poker/engine';
import type { PersistedTableSession } from './aggregate.js';
import { creationRequests, localUsers } from './db/schema.js';
import type { openDatabase } from './db/database.js';
import { projectBindings } from './projection.js';
import { writeTableSession } from './membership.js';
import { AcceptanceTransactions, CommitOutcomeUnknown, type AcceptanceFaults } from './db/acceptance.js';
import { canonical } from './canonical.js';
export { CommitOutcomeUnknown } from './db/acceptance.js';
type Database = ReturnType<typeof openDatabase>['db'];
/** Test tooling wraps the real transaction; these hooks are never HTTP endpoints. */
export interface CreationTransactionFaults extends AcceptanceFaults { readonly beforeCommit?: () => Promise<void>; readonly afterCommit?: () => Promise<void> }
export function createTableSessionCreator(db: Database, acceptance: AcceptanceTransactions, faults?: CreationTransactionFaults, supportsStrategy: (descriptor: unknown) => boolean = isSupportedStrategy) {
  const queue = new Map<string, Promise<unknown>>();
  return async (ownerUserId: string, request: CreateTableSessionRequest): Promise<CreationOutcome> => {
    const prior = queue.get(ownerUserId) ?? Promise.resolve();
    const operation = prior.catch(() => undefined).then(async (): Promise<CreationOutcome> => {
      const { requestId, ...contents } = request;
      const fingerprint = createHash('sha256').update('create-table-v1:' + canonical(contents)).digest('hex');
      const scope = { kind: 'creation' as const, id: ownerUserId, requestId };
      const attempt = await acceptance.find(scope);
      if (attempt && attempt.fingerprint !== fingerprint) return { ok: false, rejection: { code: 'request-id-conflict', message: 'This requestId was already used for different creation contents.' } };
      if (attempt) {
        const status = await acceptance.status(attempt);
        if (status === 'pending') throw new CommitOutcomeUnknown('The earlier creation transaction remains unresolved.');
        if (status === 'noncommit') return { ok: false, rejection: { code: 'commit-not-applied', message: 'The creation did not commit. Submit a new requestId to deliberately create a Table Session.' } };
      }
      const priorRows = await db.select().from(creationRequests).where(and(eq(creationRequests.userId, ownerUserId), eq(creationRequests.requestId, requestId)));
      if (priorRows[0]) {
        if (attempt) await acceptance.forget(scope).catch(() => {});
        return priorRows[0].fingerprint === fingerprint ? priorRows[0].outcome : { ok: false, rejection: { code: 'request-id-conflict', message: 'This requestId was already used for different creation contents.' } };
      }
      if (attempt) throw new CommitOutcomeUnknown('The committed creation outcome is unavailable.');
      for (const pending of (await acceptance.attempts()).filter(entry => entry.kind === 'creation' && entry.id === ownerUserId && entry.state === 'pending')) {
        const status = await acceptance.status(pending);
        if (status === 'noncommit') continue;
        if (status === 'committed') {
          const known = await db.select().from(creationRequests).where(and(eq(creationRequests.userId, ownerUserId), eq(creationRequests.requestId, pending.requestId)));
          if (known[0]?.fingerprint === pending.fingerprint) { await acceptance.forget(pending).catch(() => {}); continue; }
        }
        throw new CommitOutcomeUnknown('An earlier creation transaction remains unresolved.');
      }
      return acceptance.run(scope, fingerprint, async (tx): Promise<CreationOutcome> => {
        const rows = await tx.select().from(creationRequests).where(and(eq(creationRequests.userId, ownerUserId), eq(creationRequests.requestId, requestId)));
        const existing = rows[0];
        if (existing) return existing.fingerprint === fingerprint ? existing.outcome : {
          ok: false, rejection: { code: 'request-id-conflict', message: 'This requestId was already used for different creation contents.' },
        };
        const guest = await tx.select({ displayName: localUsers.displayName }).from(localUsers).where(eq(localUsers.id, ownerUserId));
        const displayName = guest[0]?.displayName;
        const mode = request.mode ?? 'practice';
        const created = !displayName ? { ok: false as const, rejection: { code: 'display-name-required', message: 'Choose a display name before creating a table.' } } : validateCreationRequest(request, supportsStrategy) ?? CashGame.create({ ...defaultConfiguration, ...request.configuration, seed: randomBytes(32).toString('hex') });
        // At an Online Table everyone is told apart by name, ignoring case, so the owner's name cannot be a Bot's.
        const names = created.ok ? [displayName, ...(request.bots ?? []).map(bot => bot.name)].map(name => nameKey(String(name))) : [];
        const rejection = mode === 'online' && new Set(names).size !== names.length
          ? { ok: false as const, rejection: { code: 'name-taken', field: 'bots', message: 'Every Participant at an Online Table needs a different name, ignoring case. Rename a Bot.' } } : undefined;
        let outcome: CreationOutcome;
        if (rejection) outcome = rejection;
        else if (!created.ok) outcome = { ok: false, rejection: created.rejection };
        else {
          const tableSessionId = randomUUID();
          const ownerParticipantId = randomUUID();
          const bindings: PersistedTableSession['bindings'] = [
            { participantId: ownerParticipantId, name: displayName!, controller: { kind: 'human' }, userId: ownerUserId, membership: 'joined', trainerConfiguration: structuredClone(defaultTrainerConfiguration) },
            ...(request.bots ?? []).map(b => ({ participantId: randomUUID(), name: b.name, controller: { kind: 'bot' as const, playingStrategy: b.playingStrategy }, assignmentId: randomUUID() })),
          ];
          // The Online owner joins unseated, without the Join Link, and observes from creation. A Practice human joins by sitting down.
          const joined = mode === 'online' ? created.game.joinTable(ownerParticipantId) : undefined;
          if (joined && !joined.ok) throw new Error('The Online owner could not join their own table.');
          const options: TableOptions = {
            actionTimeLimitSeconds: request.options?.actionTimeLimitSeconds !== undefined ? request.options.actionTimeLimitSeconds : mode === 'online' ? defaultOnlineActionTimeLimitSeconds : null,
            allowLiveAnalysis: request.options?.allowLiveAnalysis ?? true,
          };
          const aggregate: PersistedTableSession = {
            schemaVersion: 2, tableSessionId, ownerUserId, mode, options, ...(mode === 'online' ? { joinToken: randomBytes(32).toString('base64url') } : {}),
            pokerRecord: created.game.toRecord(), bindings,
            pokerRevision: joined ? 1 : 0, sessionRevision: 0, adminMode: true, botProvenance: [],
          };
          await writeTableSession(tx, undefined, aggregate);
          outcome = { ok: true, tableSessionId, bindings: projectBindings(bindings) };
        }
        await tx.insert(creationRequests).values({ userId: ownerUserId, requestId, fingerprint, outcome });
        return outcome;
      }, { ...faults, tableSessionId: result => result.ok ? result.tableSessionId : undefined });
    });
    queue.set(ownerUserId, operation);
    try { return await operation; } finally { if (queue.get(ownerUserId) === operation) queue.delete(ownerUserId); }
  };
}
