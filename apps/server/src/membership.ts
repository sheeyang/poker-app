import { and, eq, or, sql } from 'drizzle-orm';
import type { SavedTable, TableMode } from '@poker/contracts';
import { findBinding, humanBindings, isBot, legacyTableMode, type PersistedTableSession, type StoredTableSession } from './aggregate.js';
import type { openDatabase } from './db/database.js';
import { tableMemberships, tableSessions } from './db/schema.js';
type Database = Omit<ReturnType<typeof openDatabase>['db'], '$client'>;

/**
 * Whether the committed table has scheduled work that runs with nobody at it (ADR-0035): an Action Deadline, a Bot
 * decision, a Next-Hand Countdown, or After-Hand Requests to apply. In practice that is an Online Table in play, or a
 * timed Practice Table with a Hand in progress. Presentation Phases alone are not: after a restart nobody is
 * connected, so the end of one starts nothing until someone opens the table.
 */
export function hasScheduledWork(aggregate: PersistedTableSession): boolean {
  const { actionWindow, nextHandCountdown } = aggregate.schedule;
  return !!nextHandCountdown || aggregate.pendingChanges.length > 0
    || !!actionWindow && (actionWindow.deadlineAt !== undefined || isBot(findBinding(aggregate, actionWindow.participantId)));
}
/**
 * The only way to write a Persisted Table Session. In the caller's transaction it inserts (no `previous`)
 * or updates the aggregate, with its `loadAtStartup` (`hasScheduledWork`), and writes the membership index rows
 * of every human binding whose membership differs from `previous`. Joining, leaving and Removal therefore only
 * change bindings.
 */
export async function writeTableSession(tx: Database, previous: PersistedTableSession | undefined, next: PersistedTableSession) {
  const loadAtStartup = hasScheduledWork(next);
  if (previous) await tx.update(tableSessions).set({ aggregate: next, loadAtStartup }).where(eq(tableSessions.id, next.tableSessionId));
  else await tx.insert(tableSessions).values({ id: next.tableSessionId, ownerUserId: next.ownerUserId, aggregate: next, loadAtStartup });
  const known = new Map(previous ? humanBindings(previous).map(binding => [binding.participantId, binding.membership]) : []);
  const changed = humanBindings(next).filter(binding => known.get(binding.participantId) !== binding.membership);
  if (changed.length) await tx.insert(tableMemberships)
    .values(changed.map(binding => ({ userId: binding.userId, tableSessionId: next.tableSessionId, participantId: binding.participantId, status: binding.membership })))
    .onConflictDoUpdate({ target: [tableMemberships.userId, tableMemberships.tableSessionId], set: { status: sql`excluded.status` } });
}
/**
 * A Table Session ID as the server issues it: a lowercase UUID. Anything else names no table, so it is never looked up,
 * and is answered as a table that doesn't exist is.
 */
export const tableSessionIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/**
 * The stored aggregate of the Online Table a Join Link names, read without loading the table; undefined for an ID that
 * names no table, or names a Practice Table, which has no Join Link.
 */
export async function storedOnlineTable(db: Database, tableSessionId: string): Promise<StoredTableSession | undefined> {
  if (!tableSessionIdPattern.test(tableSessionId)) return undefined;
  const rows = await db.select({ aggregate: tableSessions.aggregate }).from(tableSessions)
    .where(and(eq(tableSessions.id, tableSessionId), sql`${tableSessions.aggregate}->>'mode' = 'online'`));
  return rows[0]?.aggregate;
}
/**
 * The Guest's Current Table: the one Online Table they are joined at, watching counts, or undefined. Practice Tables
 * never count. Read from the membership index, so it loads nothing.
 */
export async function currentTable(db: Database, userId: string): Promise<string | undefined> {
  const rows = await db.select({ tableSessionId: tableMemberships.tableSessionId })
    .from(tableMemberships).innerJoin(tableSessions, eq(tableSessions.id, tableMemberships.tableSessionId))
    .where(and(eq(tableMemberships.userId, userId), eq(tableMemberships.status, 'joined'), sql`${tableSessions.aggregate}->>'mode' = 'online'`));
  return rows[0]?.tableSessionId;
}
/** The Guest's joined, unremoved Participant at a table, whether the Guest owns it and its mode, without restoring the table. */
export async function membership(db: Database, tableSessionId: string, userId: string): Promise<{ participantId: string; owner: boolean; mode: TableMode } | undefined> {
  const rows = await db.select({ participantId: tableMemberships.participantId, ownerUserId: tableSessions.ownerUserId, mode: sql<TableMode | null>`${tableSessions.aggregate}->>'mode'` })
    .from(tableMemberships).innerJoin(tableSessions, eq(tableSessions.id, tableMemberships.tableSessionId))
    .where(and(eq(tableMemberships.userId, userId), eq(tableMemberships.tableSessionId, tableSessionId), eq(tableMemberships.status, 'joined')));
  return rows[0] && { participantId: rows[0].participantId, owner: rows[0].ownerUserId === userId, mode: rows[0].mode ?? legacyTableMode };
}
/**
 * Every table the Guest has joined, with the Guest's Participant at each, however their membership ended (Leave Table
 * or Removal, which are the same). A table they have left is marked `left`: its Join Link returns them. The index has no
 * seating, so the caller adds each table's public stakes and play state.
 */
export async function savedTableEntries(db: Database, userId: string): Promise<(Pick<SavedTable, 'tableSessionId' | 'mode' | 'left'> & { participantId: string })[]> {
  const rows = await db.select({ tableSessionId: tableMemberships.tableSessionId, participantId: tableMemberships.participantId, status: tableMemberships.status, mode: sql<TableMode | null>`${tableSessions.aggregate}->>'mode'` })
    .from(tableMemberships).innerJoin(tableSessions, eq(tableSessions.id, tableMemberships.tableSessionId))
    .where(eq(tableMemberships.userId, userId));
  return rows.map(row => ({ tableSessionId: row.tableSessionId, participantId: row.participantId, mode: row.mode ?? legacyTableMode, ...(row.status === 'joined' ? {} : { left: true as const }) }));
}
