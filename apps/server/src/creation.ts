import { isSupportedStrategy } from '@poker/strategies';
import { nameKey, participantName, validateCreationRequest } from './validation.js';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { defaultConfiguration, defaultOnlineActionTimeLimitSeconds, defaultTrainerConfiguration, type CreateTableSessionRequest, type CreationOutcome, type TableOptions } from '@poker/contracts';
import { CashGame } from '@poker/engine';
import type { PersistedTableSession } from './aggregate.js';
import { creationRequests, localUsers } from './db/schema.js';
import type { openDatabase } from './db/database.js';
import { projectBindings } from './projection.js';
import { currentTable, writeTableSession } from './membership.js';
import { createGuestQueue, type GuestQueue } from './guest-queue.js';
import { currentTableElsewhere } from './rejections.js';
import { emptySchedule } from './schedule.js';
import { type AcceptanceTransactions, CommitOutcomeUnknown, type AcceptanceFaults } from './db/acceptance.js';
import { canonical } from './canonical.js';
import { hashTablePassword, tablePasswordProblem } from './table-password.js';
export { CommitOutcomeUnknown } from './db/acceptance.js';
type Database = ReturnType<typeof openDatabase>['db'];
/** Test tooling wraps the real transaction; these hooks are never HTTP endpoints. */
export interface CreationTransactionFaults extends AcceptanceFaults { readonly beforeCommit?: () => Promise<void>; readonly afterCommit?: () => Promise<void> }
/**
 * Creates tables, each in its owner's turn (`guests`), which joining shares: an Online Table becomes its owner's Current
 * Table, so creating one is refused while they are at another.
 */
export function createTableSessionCreator(db: Database, acceptance: AcceptanceTransactions, faults?: CreationTransactionFaults, supportsStrategy: (descriptor: unknown) => boolean = isSupportedStrategy, guests: GuestQueue = createGuestQueue()) {
  return (ownerUserId: string, request: CreateTableSessionRequest): Promise<CreationOutcome> => guests.run(ownerUserId, async (): Promise<CreationOutcome> => {
    // The Table Password never reaches the fingerprint: retrying with another password is the same creation.
    const { requestId, tablePassword, ...contents } = request;
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
    // Hashed before the transaction: it is slow by design.
    const tablePasswordHash = request.mode === 'online' && tablePassword !== undefined && !tablePasswordProblem(tablePassword) ? await hashTablePassword(tablePassword) : undefined;
    try { return await acceptance.run(scope, fingerprint, async (tx): Promise<CreationOutcome> => {
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
      const names = created.ok ? [displayName, ...(request.bots ?? []).map(bot => participantName(bot.name))].map(name => nameKey(String(name))) : [];
      const rejection = mode === 'online' && new Set(names).size !== names.length
        ? { ok: false as const, rejection: { code: 'name-taken', field: 'bots', message: 'Every Participant at an Online Table needs a different name, ignoring case. Rename a Bot.' } } : undefined;
      let outcome: CreationOutcome;
      if (rejection) outcome = rejection;
      else if (!created.ok) outcome = { ok: false, rejection: created.rejection };
      else {
        // Judged once the request is otherwise valid, in the owner's turn, so no join or creation of theirs can pass it
        // meanwhile. It rolls back, so that, like a wrong password, it is not remembered under the request ID: once they
        // leave their Current Table, the same request creates the table.
        const elsewhere = mode === 'online' ? await currentTable(tx, ownerUserId) : undefined;
        if (elsewhere) throw new CurrentTableElsewhere(elsewhere);
        const tableSessionId = randomUUID();
        const ownerParticipantId = randomUUID();
        const bindings: PersistedTableSession['bindings'] = [
          { participantId: ownerParticipantId, name: displayName!, controller: { kind: 'human' }, userId: ownerUserId, membership: 'joined', trainerConfiguration: structuredClone(defaultTrainerConfiguration) },
          ...(request.bots ?? []).map(b => ({ participantId: randomUUID(), name: participantName(b.name)!, controller: { kind: 'bot' as const, playingStrategy: b.playingStrategy }, assignmentId: randomUUID() })),
        ];
        // The Online owner joins unseated, without the Join Link, and observes from creation. A Practice human joins by sitting down.
        const joined = mode === 'online' ? created.game.joinTable(ownerParticipantId) : undefined;
        if (joined && !joined.ok) throw new Error('The Online owner could not join their own table.');
        const options: TableOptions = {
          actionTimeLimitSeconds: request.options?.actionTimeLimitSeconds !== undefined ? request.options.actionTimeLimitSeconds : mode === 'online' ? defaultOnlineActionTimeLimitSeconds : null,
          allowLiveAnalysis: request.options?.allowLiveAnalysis ?? true,
        };
        const aggregate: PersistedTableSession = {
          schemaVersion: 2, tableSessionId, ownerUserId, mode, options,
          pokerRecord: created.game.toRecord(), bindings,
          pokerRevision: joined ? 1 : 0, sessionRevision: 0, adminMode: true, botProvenance: [], schedule: emptySchedule, pendingChanges: [],
          ...(tablePasswordHash ? { tablePasswordHash } : {}),
        };
        await writeTableSession(tx, undefined, aggregate);
        outcome = { ok: true, tableSessionId, bindings: projectBindings(bindings) };
      }
      await tx.insert(creationRequests).values({ userId: ownerUserId, requestId, fingerprint, outcome });
      return outcome;
    }, { ...faults, tableSessionId: result => result.ok ? result.tableSessionId : undefined }); }
    catch (error) { if (error instanceof CurrentTableElsewhere) return currentTableElsewhere(error.currentTableId); throw error; }
  });
}
/** Rolls a creation back: its owner is at another Online Table, their Current Table. */
class CurrentTableElsewhere extends Error {
  constructor(readonly currentTableId: string) { super('The Guest is at another Online Table.'); }
}
