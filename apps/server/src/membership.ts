import { and, eq, or, sql } from 'drizzle-orm';
import type { SavedTable, TableMode } from '@poker/contracts';
import { findBinding, humanBindings, isBot, legacyTableMode, type PersistedTableSession, type StoredTableSession } from './aggregate.js';
import type { openDatabase } from './db/database.js';
import { tableMemberships, tableSessions } from './db/schema.js';
type Database = Omit<ReturnType<typeof openDatabase>['db'], '$client'>;

/**
 * Whether the committed table has scheduled work that runs with nobody at it (ADR-0035): an Action Deadline, a Bot
 * decision, a Next-Hand Countdown, or After-Hand Requests to apply (`afterHandRequestsScheduled`). In practice that is
 * an Online Table in play, or a timed Practice Table with a Hand in progress. Presentation Phases alone are not: after
 * a restart nobody is connected, so the end of one starts nothing until someone opens the table.
 */
export function hasScheduledWork(aggregate: PersistedTableSession): boolean {
  // A Closed Table is never loaded again, so nothing it had scheduled runs.
  if (aggregate.closed) return false;
  const { actionWindow, nextHandCountdown } = aggregate.schedule;
  return !!nextHandCountdown || afterHandRequestsScheduled(aggregate)
    || !!actionWindow && (actionWindow.deadlineAt !== undefined || isBot(findBinding(aggregate, actionWindow.participantId)));
}
/**
 * Whether pending After-Hand Requests are scheduled work: only where something advances the Hand without the human,
 * at an Online Table or a timed Practice Table. At an untimed Practice Table they wait in the record for the human to
 * finish the Hand.
 */
export function afterHandRequestsScheduled(aggregate: PersistedTableSession): boolean {
  return aggregate.pendingChanges.length > 0 && (aggregate.mode === 'online' || aggregate.options.actionTimeLimitSeconds !== null);
}
/**
 * The only way to write a Persisted Table Session. In the caller's transaction it inserts (no `previous`)
 * or updates the aggregate, with its owner, its `loadAtStartup` (`hasScheduledWork`), whether it is closed, and `committedAt`
 * (server time) as its last committed change, and writes the membership index rows of every human binding whose
 * membership differs from `previous`. Joining, leaving, Removal and closing therefore only change bindings.
 */
export async function writeTableSession(tx: Database, previous: PersistedTableSession | undefined, next: PersistedTableSession, committedAt: number) {
  // Ownership can pass when the owner leaves (`ownership.ts`), so the owner column follows the aggregate's.
  const row = { aggregate: next, ownerUserId: next.ownerUserId, loadAtStartup: hasScheduledWork(next), closed: !!next.closed, lastCommittedAt: committedAt };
  if (previous) await tx.update(tableSessions).set(row).where(eq(tableSessions.id, next.tableSessionId));
  else await tx.insert(tableSessions).values({ id: next.tableSessionId, ...row });
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
/** A request ID as the server issues it: a lowercase UUID, as a Table Session ID is. */
export const requestIdPattern = tableSessionIdPattern;
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
 * The Guest's Participant at a table they have ever joined, however their membership ended (Leave Table, Removal or
 * the table closing), from the index alone: it loads nothing. Having been a Participant is what reading Table History
 * and studying one's own decisions require (ADR-0041); play requires `membership`.
 */
export async function participation(db: Database, tableSessionId: string, userId: string): Promise<{ participantId: string } | undefined> {
  const rows = await db.select({ participantId: tableMemberships.participantId }).from(tableMemberships)
    .where(and(eq(tableMemberships.userId, userId), eq(tableMemberships.tableSessionId, tableSessionId)));
  return rows[0] && { participantId: rows[0].participantId };
}
/** The Guest who was ever the human Participant `participantId` at a table, from the index alone. */
export async function participantGuest(db: Database, tableSessionId: string, participantId: string): Promise<string | undefined> {
  const rows = await db.select({ userId: tableMemberships.userId }).from(tableMemberships)
    .where(and(eq(tableMemberships.tableSessionId, tableSessionId), eq(tableMemberships.participantId, participantId)));
  return rows[0]?.userId;
}
/**
 * Every table the Guest has joined, with the Guest's Participant at each, however their membership ended (Leave Table
 * or Removal, which are the same, or the table closing). A table they have left is marked `left`: its Join Link
 * returns them. A Closed Table is marked `closed` as well, its memberships all ended. Each carries its stored aggregate,
 * so the caller can read the format and blinds from stored rows alone, loading nothing.
 */
export async function savedTableEntries(db: Database, userId: string): Promise<(Pick<SavedTable, 'tableSessionId' | 'mode' | 'left' | 'closed' | 'openedAt'> & { stored: StoredTableSession })[]> {
  const rows = await db.select({ tableSessionId: tableMemberships.tableSessionId, stored: tableSessions.aggregate, status: tableMemberships.status, closed: tableSessions.closed, openedAt: tableMemberships.openedAt, mode: sql<TableMode | null>`${tableSessions.aggregate}->>'mode'` })
    .from(tableMemberships).innerJoin(tableSessions, eq(tableSessions.id, tableMemberships.tableSessionId))
    .where(eq(tableMemberships.userId, userId));
  return rows.map(row => ({ tableSessionId: row.tableSessionId, stored: row.stored, mode: row.mode ?? legacyTableMode,
    ...(row.status === 'joined' ? {} : { left: true as const }), ...(row.closed ? { closed: true as const } : {}), ...(row.openedAt !== null ? { openedAt: row.openedAt } : {}) }));
}
/** Notes that the Guest opened a table they have a membership at: its time is the server's `at`. False when they have none. */
export async function recordOpened(db: Database, userId: string, tableSessionId: string, at: number): Promise<boolean> {
  if (!tableSessionIdPattern.test(tableSessionId)) return false;
  const rows = await db.update(tableMemberships).set({ openedAt: at })
    .where(and(eq(tableMemberships.userId, userId), eq(tableMemberships.tableSessionId, tableSessionId))).returning({ id: tableMemberships.tableSessionId });
  return rows.length > 0;
}
/**
 * Every table the Guest has ever been a Participant at, with that Participant, however their membership ended and
 * Closed Tables included: the tables whose history they may read (ADR-0041). From the index alone, so it loads nothing.
 */
export async function participations(db: Database, userId: string): Promise<{ tableSessionId: string; participantId: string }[]> {
  return db.select({ tableSessionId: tableMemberships.tableSessionId, participantId: tableMemberships.participantId }).from(tableMemberships)
    .where(eq(tableMemberships.userId, userId));
}
