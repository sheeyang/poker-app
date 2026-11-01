import { and, eq, or, sql } from 'drizzle-orm';
import type { SavedTable, TableMode } from '@poker/contracts';
import { humanBindings, legacyTableMode, type PersistedTableSession } from './aggregate.js';
import type { openDatabase } from './db/database.js';
import { tableMemberships, tableSessions } from './db/schema.js';
type Database = Omit<ReturnType<typeof openDatabase>['db'], '$client'>;

/**
 * The only way to write a Persisted Table Session. In the caller's transaction it inserts (no `previous`)
 * or updates the aggregate, and writes the membership index rows of every human binding whose
 * membership differs from `previous`. Joining, leaving and Removal therefore only change bindings.
 */
export async function writeTableSession(tx: Database, previous: PersistedTableSession | undefined, next: PersistedTableSession) {
  if (previous) await tx.update(tableSessions).set({ aggregate: next }).where(eq(tableSessions.id, next.tableSessionId));
  else await tx.insert(tableSessions).values({ id: next.tableSessionId, ownerUserId: next.ownerUserId, aggregate: next });
  const known = new Map(previous ? humanBindings(previous).map(binding => [binding.participantId, binding.membership]) : []);
  const changed = humanBindings(next).filter(binding => known.get(binding.participantId) !== binding.membership);
  if (changed.length) await tx.insert(tableMemberships)
    .values(changed.map(binding => ({ userId: binding.userId, tableSessionId: next.tableSessionId, participantId: binding.participantId, status: binding.membership })))
    .onConflictDoUpdate({ target: [tableMemberships.userId, tableMemberships.tableSessionId], set: { status: sql`excluded.status` } });
}
/** The Guest's joined, unremoved Participant at a table, and whether the Guest owns it, without restoring the table. */
export async function membership(db: Database, tableSessionId: string, userId: string): Promise<{ participantId: string; owner: boolean } | undefined> {
  const rows = await db.select({ participantId: tableMemberships.participantId, ownerUserId: tableSessions.ownerUserId })
    .from(tableMemberships).innerJoin(tableSessions, eq(tableSessions.id, tableMemberships.tableSessionId))
    .where(and(eq(tableMemberships.userId, userId), eq(tableMemberships.tableSessionId, tableSessionId), eq(tableMemberships.status, 'joined')));
  return rows[0] && { participantId: rows[0].participantId, owner: rows[0].ownerUserId === userId };
}
/** Tables the Guest owns, even after leaving them, plus tables the Guest has joined and not left. */
export async function savedTables(db: Database, userId: string): Promise<SavedTable[]> {
  const rows = await db.select({ tableSessionId: tableMemberships.tableSessionId, mode: sql<TableMode | null>`${tableSessions.aggregate}->>'mode'` })
    .from(tableMemberships).innerJoin(tableSessions, eq(tableSessions.id, tableMemberships.tableSessionId))
    .where(and(eq(tableMemberships.userId, userId), or(eq(tableMemberships.status, 'joined'), eq(tableSessions.ownerUserId, userId))));
  return rows.map(row => ({ tableSessionId: row.tableSessionId, mode: row.mode ?? legacyTableMode }));
}
