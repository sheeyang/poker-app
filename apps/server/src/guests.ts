import { and, eq, isNull, lt, notExists, sql } from 'drizzle-orm';
import type { ServerClock } from './clock.js';
import type { openDatabase } from './db/database.js';
import { creationRequests, localUsers, tableMemberships, tableSessions } from './db/schema.js';
type Database = Omit<ReturnType<typeof openDatabase>['db'], '$client'>;

/** How long a Guest's cookie lasts from each time it is set: a year. */
export const guestCookieSeconds = 365 * 24 * 60 * 60;
/** How often at most a Guest's last-seen time is written, and their cookie set again (ADR-0037). */
export const guestSeenIntervalMs = 24 * 60 * 60_000;
/** How long a Guest with no name and no tables may go unseen before they are purged. */
export const guestIdleMs = 90 * 24 * 60 * 60_000;
/** How often the server looks for such Guests. */
export const guestSweepMs = 24 * 60 * 60_000;

/**
 * Deletes every Guest last seen before `cutoff` who has no display name and no place at any table: nobody owns, joined or
 * created anything under them. A Guest with a name or a table is never purged, however long they are away (ADR-0037).
 */
export async function purgeIdleGuests(db: Database, cutoff: number): Promise<void> {
  const exists = sql`1`;
  await db.delete(localUsers).where(and(isNull(localUsers.displayName), lt(localUsers.lastSeenAt, cutoff),
    notExists(db.select({ exists }).from(tableSessions).where(eq(tableSessions.ownerUserId, localUsers.id))),
    notExists(db.select({ exists }).from(tableMemberships).where(eq(tableMemberships.userId, localUsers.id))),
    notExists(db.select({ exists }).from(creationRequests).where(eq(creationRequests.userId, localUsers.id)))));
}

/**
 * Purges idle Guests once now and then daily, judged against the server clock. Sweeps never overlap: they run one after
 * another, and one that fails is tried again at the next. `stop` ends the schedule and waits for a sweep under way.
 */
export function startGuestSweep(db: Database, clock: ServerClock): { stop(): Promise<void> } {
  let running: Promise<void> = Promise.resolve();
  let cancel: (() => void) | undefined;
  let stopped = false;
  const sweep = (at: number) => { running = running.then(() => purgeIdleGuests(db, at - guestIdleMs)).catch(() => {}); };
  const arm = (at: number) => {
    cancel = clock.setTimer(at, () => { if (stopped) return; sweep(at); arm(at + guestSweepMs); }, 'housekeeping');
  };
  sweep(clock.now());
  arm(clock.now() + guestSweepMs);
  return { stop: async () => { stopped = true; cancel?.(); await running; } };
}
