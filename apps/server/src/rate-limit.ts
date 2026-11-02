import type { ServerClock } from './clock.js';

/** At most `limit` requests from one address in any window of `windowMs`. */
export interface RateLimit { readonly limit: number; readonly windowMs: number }
/** What the public server protects itself from: floods of creation, joining and Join Link replacement. */
export type RateLimitKind = 'creation' | 'joining' | 'join-link-replacement';
export type RateLimits = Readonly<Record<RateLimitKind, RateLimit>>;

const tenMinutes = 10 * 60_000;
/**
 * The limits of the hosted product. Several people may share one address (a home, a school), so they are
 * roomy for a group of friends and still bound what any one address can create: a Table Session is a stored
 * aggregate, and a join is a commit to a table.
 */
export const defaultRateLimits: RateLimits = Object.freeze({
  creation: { limit: 10, windowMs: tenMinutes },
  joining: { limit: 30, windowMs: tenMinutes },
  'join-link-replacement': { limit: 10, windowMs: tenMinutes },
});

export type RateLimitDecision = { readonly allowed: true } | { readonly allowed: false; readonly retryAfterSeconds: number };

/**
 * A sliding-window limiter per kind and client address, in memory (one server owns the product). Every
 * request counts, whatever its outcome: a flood of rejected requests is still a flood. A refused request
 * is not recorded, so waiting out `retryAfterSeconds` is always enough. A kind with no limit is unlimited.
 */
export function createRateLimiter(limits: Partial<RateLimits>, clock: ServerClock) {
  const hits = new Map<string, number[]>();
  let sweptAt = clock.now();
  const longest = Math.max(0, ...Object.values(limits).map(limit => limit.windowMs));
  function sweep(now: number) {
    if (now - sweptAt < longest) return;
    sweptAt = now;
    for (const [key, times] of hits) if (times.at(-1)! <= now - longest) hits.delete(key);
  }
  return {
    take(kind: RateLimitKind, address: string): RateLimitDecision {
      const limit = limits[kind];
      if (!limit) return { allowed: true };
      const now = clock.now();
      sweep(now);
      const key = kind + '\0' + address;
      const recent = (hits.get(key) ?? []).filter(time => time > now - limit.windowMs);
      if (recent.length >= limit.limit) {
        hits.set(key, recent);
        return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((recent[0]! + limit.windowMs - now) / 1000)) };
      }
      recent.push(now);
      hits.set(key, recent);
      return { allowed: true };
    },
  };
}

/** How long to wait, in words a person can use. */
export function waitText(seconds: number): string {
  if (seconds < 90) return seconds === 1 ? '1 second' : `${seconds} seconds`;
  return `${Math.ceil(seconds / 60)} minutes`;
}
