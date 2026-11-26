import type { ProgressResource, ProgressUpdate, RequestProgress } from '@poker/contracts';
import type { ServerClock } from './clock.js';

/** The least time between two `progress` messages to one User. */
export const progressIntervalMs = 1000;

/** One pending request a User hears progress of, and where its latest count is read. */
export interface ProgressSource {
  readonly resource: ProgressResource;
  readonly requestId: string;
  /** The request's latest count: its running total, read when a message is sent, never recounted. */
  count(): { readonly succeeded: number; readonly total: number };
}
interface UserProgress {
  readonly requests: Map<string, ProgressSource>;
  /** A followed request's count changed since the last message. */
  changed: boolean;
  /** When the last message went, by the server clock. */
  sentAt?: number;
  /** Cancels the wake-up that sends the next message, while one is set. */
  cancel?: () => void;
}

/**
 * The user channel's `progress` messages (ADR-0026, ADR-0041). Each User hears, at most once a second, the latest
 * count of every pending request of theirs, and only while some count has changed: the first change goes out at once,
 * and changes within the next second are coalesced into one message at its end. A message carries counts only. A
 * request is followed from when it is pending until its completion or failure notice is sent (`settled`); the notices
 * themselves travel separately, at once.
 */
export function createProgressChannel(clock: ServerClock, deliver: (userId: string, message: ProgressUpdate) => void, intervalMs = progressIntervalMs) {
  const users = new Map<string, UserProgress>();
  let stopped = false;
  function send(userId: string) {
    const user = users.get(userId);
    if (!user) return;
    user.cancel = undefined;
    if (stopped) return;
    // Nothing pending, and the interval since the last message is over: nothing to keep.
    if (!user.requests.size) { users.delete(userId); return; }
    if (!user.changed) return;
    user.changed = false;
    user.sentAt = clock.now();
    const progress: RequestProgress[] = [...user.requests.values()].map(source => ({ resource: source.resource, requestId: source.requestId, ...source.count() }));
    try { deliver(userId, { type: 'progress', progress }); } catch { /* HTTP state remains readable. */ }
  }
  return {
    /** Follows a pending request of the User's: its count goes in each of their messages until it is `settled`. */
    follow(userId: string, source: ProgressSource) {
      if (stopped) return;
      const user = users.get(userId) ?? { requests: new Map(), changed: false };
      user.requests.set(source.requestId, source);
      users.set(userId, user);
    },
    /** A followed request's count changed: the User hears every latest count within a second. */
    changed(userId: string, requestId: string) {
      const user = users.get(userId);
      if (stopped || !user?.requests.has(requestId)) return;
      user.changed = true;
      if (user.cancel) return;
      const at = user.sentAt === undefined ? clock.now() : Math.max(clock.now(), user.sentAt + intervalMs);
      // Due now: send once this turn's other changes are in. Otherwise wake at the end of the interval.
      if (at <= clock.now()) {
        let cancelled = false;
        user.cancel = () => { cancelled = true; };
        queueMicrotask(() => { if (!cancelled) send(userId); });
      } else user.cancel = clock.setTimer(at, () => send(userId), 'housekeeping');
    },
    /** The request is pending no longer: its notice is sent, so it leaves the User's messages. */
    settled(userId: string, requestId: string) {
      const user = users.get(userId);
      if (!user) return;
      user.requests.delete(requestId);
      // Kept while a message may still be due, or a new one would come too soon after the last.
      if (!user.requests.size && !user.cancel && (user.sentAt === undefined || clock.now() >= user.sentAt + intervalMs)) users.delete(userId);
    },
    stop() {
      stopped = true;
      for (const user of users.values()) user.cancel?.();
      users.clear();
    },
  };
}
export type ProgressChannel = ReturnType<typeof createProgressChannel>;
