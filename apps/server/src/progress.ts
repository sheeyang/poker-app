import type { ProgressResource, ProgressUpdate, RequestProgress } from '@poker/contracts';
import type { ServerClock } from './clock.js';

/** The least time between two `progress` messages to one Guest. */
export const progressIntervalMs = 1000;

/** One pending request a Guest hears progress of, and where its latest count is read. */
export interface ProgressSource {
  readonly resource: ProgressResource;
  readonly requestId: string;
  /** The request's latest count: its running total, read when a message is sent, never recounted. */
  count(): { readonly succeeded: number; readonly total: number };
}
interface GuestProgress {
  readonly requests: Map<string, ProgressSource>;
  /** A followed request's count changed since the last message. */
  changed: boolean;
  /** When the last message went, by the server clock. */
  sentAt?: number;
  /** Cancels the wake-up that sends the next message, while one is set. */
  cancel?: () => void;
}

/**
 * The user channel's `progress` messages (ADR-0026, ADR-0041). Each Guest hears, at most once a second, the latest
 * count of every pending request of theirs, and only while some count has changed: the first change goes out at once,
 * and changes within the next second are coalesced into one message at its end. A message carries counts only. A
 * request is followed from when it is pending until its completion or failure notice is sent (`settled`); the notices
 * themselves travel separately, at once.
 */
export function createProgressChannel(clock: ServerClock, deliver: (guestId: string, message: ProgressUpdate) => void, intervalMs = progressIntervalMs) {
  const guests = new Map<string, GuestProgress>();
  let stopped = false;
  function send(guestId: string) {
    const guest = guests.get(guestId);
    if (!guest) return;
    guest.cancel = undefined;
    if (stopped) return;
    // Nothing pending, and the interval since the last message is over: nothing to keep.
    if (!guest.requests.size) { guests.delete(guestId); return; }
    if (!guest.changed) return;
    guest.changed = false;
    guest.sentAt = clock.now();
    const progress: RequestProgress[] = [...guest.requests.values()].map(source => ({ resource: source.resource, requestId: source.requestId, ...source.count() }));
    try { deliver(guestId, { type: 'progress', progress }); } catch { /* HTTP state remains readable. */ }
  }
  return {
    /** Follows a pending request of the Guest's: its count goes in each of their messages until it is `settled`. */
    follow(guestId: string, source: ProgressSource) {
      if (stopped) return;
      const guest = guests.get(guestId) ?? { requests: new Map(), changed: false };
      guest.requests.set(source.requestId, source);
      guests.set(guestId, guest);
    },
    /** A followed request's count changed: the Guest hears every latest count within a second. */
    changed(guestId: string, requestId: string) {
      const guest = guests.get(guestId);
      if (stopped || !guest?.requests.has(requestId)) return;
      guest.changed = true;
      if (guest.cancel) return;
      const at = guest.sentAt === undefined ? clock.now() : Math.max(clock.now(), guest.sentAt + intervalMs);
      // Due now: send once this turn's other changes are in. Otherwise wake at the end of the interval.
      if (at <= clock.now()) {
        let cancelled = false;
        guest.cancel = () => { cancelled = true; };
        queueMicrotask(() => { if (!cancelled) send(guestId); });
      } else guest.cancel = clock.setTimer(at, () => send(guestId), 'housekeeping');
    },
    /** The request is pending no longer: its notice is sent, so it leaves the Guest's messages. */
    settled(guestId: string, requestId: string) {
      const guest = guests.get(guestId);
      if (!guest) return;
      guest.requests.delete(requestId);
      // Kept while a message may still be due, or a new one would come too soon after the last.
      if (!guest.requests.size && !guest.cancel && (guest.sentAt === undefined || clock.now() >= guest.sentAt + intervalMs)) guests.delete(guestId);
    },
    stop() {
      stopped = true;
      for (const guest of guests.values()) guest.cancel?.();
      guests.clear();
    },
  };
}
export type ProgressChannel = ReturnType<typeof createProgressChannel>;
