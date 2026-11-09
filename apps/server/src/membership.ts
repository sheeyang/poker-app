import { randomBytes } from 'node:crypto';
import { and, eq, or, sql } from 'drizzle-orm';
import type { SavedTable, TableMode } from '@poker/contracts';
import { findBinding, humanBindings, isBot, legacyTableMode, type PersistedTableSession } from './aggregate.js';
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
/** A Join Link token is 32 random bytes in base64url. Anything else cannot be a link, so is never looked up. */
export const joinTokenPattern = /^[A-Za-z0-9_-]{43}$/;
/** A fresh, unguessable Join Link token. */
export const newJoinToken = () => randomBytes(32).toString('base64url');
/** The Online Table a Join Link currently opens. A replaced token no longer matches anything. */
export async function tableOfJoinLink(db: Database, token: string): Promise<string | undefined> {
  if (!joinTokenPattern.test(token)) return undefined;
  const rows = await db.select({ id: tableSessions.id }).from(tableSessions).where(sql`${tableSessions.aggregate}->>'joinToken' = ${token}`);
  return rows[0]?.id;
}
/** The Guest's joined, unremoved Participant at a table, whether the Guest owns it and its mode, without restoring the table. */
export async function membership(db: Database, tableSessionId: string, userId: string): Promise<{ participantId: string; owner: boolean; mode: TableMode } | undefined> {
  const rows = await db.select({ participantId: tableMemberships.participantId, ownerUserId: tableSessions.ownerUserId, mode: sql<TableMode | null>`${tableSessions.aggregate}->>'mode'` })
    .from(tableMemberships).innerJoin(tableSessions, eq(tableSessions.id, tableMemberships.tableSessionId))
    .where(and(eq(tableMemberships.userId, userId), eq(tableMemberships.tableSessionId, tableSessionId), eq(tableMemberships.status, 'joined')));
  return rows[0] && { participantId: rows[0].participantId, owner: rows[0].ownerUserId === userId, mode: rows[0].mode ?? legacyTableMode };
}
/** Whether the Guest owns the table, without restoring it. Ownership is kept after leaving and never transfers. */
export async function ownsTable(db: Database, tableSessionId: string, userId: string): Promise<boolean> {
  const rows = await db.select({ id: tableSessions.id }).from(tableSessions).where(and(eq(tableSessions.id, tableSessionId), eq(tableSessions.ownerUserId, userId)));
  return rows.length > 0;
}
/**
 * Tables the Guest owns, even after leaving them, plus tables the Guest has joined and not left, with the Guest's
 * Participant at each. An owned table the Guest has left is marked `left`: opening it rejoins them. The index has no
 * seating, so the caller adds each table's public stakes and play state.
 */
export async function savedTableEntries(db: Database, userId: string): Promise<(Pick<SavedTable, 'tableSessionId' | 'mode' | 'left'> & { participantId: string })[]> {
  const rows = await db.select({ tableSessionId: tableMemberships.tableSessionId, participantId: tableMemberships.participantId, status: tableMemberships.status, mode: sql<TableMode | null>`${tableSessions.aggregate}->>'mode'` })
    .from(tableMemberships).innerJoin(tableSessions, eq(tableSessions.id, tableMemberships.tableSessionId))
    .where(and(eq(tableMemberships.userId, userId), or(eq(tableMemberships.status, 'joined'), eq(tableSessions.ownerUserId, userId))));
  return rows.map(row => ({ tableSessionId: row.tableSessionId, participantId: row.participantId, mode: row.mode ?? legacyTableMode, ...(row.status === 'joined' ? {} : { left: true as const }) }));
}
