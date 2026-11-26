import type { ProgressResource, ProgressUpdate } from '@poker/contracts';

/**
 * Following a transient request on the user channel (ADR-0026, ADR-0041), pure. A request is asked for over HTTP and
 * answers at once; while it is pending, `progress` messages raise the count on show, and its completion or failure
 * notice, or the user channel becoming ready again, has it read once more over HTTP. Nothing reads it on a timer, and
 * `progress` is never kept: what a reconnect needs comes from the next read.
 */

/** How far a request has got: how many of the analyses it needs have succeeded, out of all of them. */
export interface Count { readonly succeeded: number; readonly total: number }
/** How one kind of request is followed: which resource it is, what in it is pending, and where its count is. */
export interface Followed<T> {
  readonly resource: ProgressResource;
  /** Whether its count is followed: a request held as complete or failed takes no `progress`. */
  pending(state: T): boolean;
  /** Whether nothing in it can change without a Retry, so a reconnect has nothing to read. */
  settled(state: T): boolean;
  count(state: T): Count;
  withCount(state: T, count: Count): T;
}
interface Request { readonly requestId: string }

/**
 * The state on show once an HTTP response (a read, or a Retry's answer) arrives: the response, which makes the request
 * pending again when it says so, except that a pending count already shown is never lowered by a response that left the
 * server before the count did.
 */
export function afterResponse<T extends Request>(model: Followed<T>, held: T | undefined, response: T): T {
  if (!held || held.requestId !== response.requestId || !model.pending(held) || !model.pending(response)) return response;
  const shown = model.count(held), read = model.count(response);
  return read.succeeded < shown.succeeded ? model.withCount(response, { ...read, succeeded: shown.succeeded }) : response;
}
/**
 * The state on show once a `progress` message arrives: its count for this request, when the request is held as pending
 * and the count is higher. A request held as complete or failed ignores it, and a stale lower count changes nothing.
 */
export function afterProgress<T extends Request>(model: Followed<T>, held: T | undefined, update: ProgressUpdate): T | undefined {
  if (!held || !model.pending(held)) return held;
  const entry = update.progress.find(each => each.resource === model.resource && each.requestId === held.requestId);
  if (!entry || entry.succeeded <= model.count(held).succeeded) return held;
  return model.withCount(held, { succeeded: entry.succeeded, total: entry.total });
}

/** What the user channel tells everything that follows a request. */
export interface UserChannelListener {
  /** The channel is ready, on its first connection or after a reconnect. */
  ready(): void;
  progress(update: ProgressUpdate): void;
  /** A request's completion or failure notice. */
  notice(update: { readonly resource: string; readonly requestId: string }): void;
}
export interface FollowerSnapshot<T> {
  /** The request's latest state, once it has been answered. */
  readonly data?: T;
  /** The request itself is being asked for. */
  readonly asking: boolean;
  /** Asking for it, reading it or retrying it failed; any state on show stays. */
  readonly error?: Error;
  readonly retrying: boolean;
}
export interface FollowerOptions<T> {
  readonly model: Followed<T>;
  readonly create: () => Promise<T>;
  readonly read: (requestId: string) => Promise<T>;
  readonly retry: (requestId: string) => Promise<T>;
}
const failure = (error: unknown) => error instanceof Error ? error : new Error('The request could not be read. Try again.');

/**
 * One transient request, followed: asked for once `start`ed, then kept current by what the user channel says. Reads are
 * one at a time; a notice or readiness that arrives during one reads again after it, so an earlier pending answer never
 * hides a completion, and a notice that arrives while the request is still being asked for is not lost.
 */
export function createRequestFollower<T extends Request>({ model, create, read, retry }: FollowerOptions<T>) {
  let snapshot: FollowerSnapshot<T> = { asking: false, retrying: false };
  const listeners = new Set<() => void>();
  let started = false, active = false, reading = false;
  /** Something said the request may have changed since it was last read. */
  let dirty = false;
  /** A notice or readiness came while the request was still being asked for. */
  let missed = false;
  /** Which request is followed: a new one each time it is asked for. */
  let generation = 0;
  /** Moves on with each Retry, so a read that left before it never replaces what it answered. */
  let version = 0;
  function show(next: Partial<FollowerSnapshot<T>>) {
    snapshot = { ...snapshot, ...next };
    for (const listener of listeners) listener();
  }
  /** There is a request to read, and nothing else is answering for it: not while it is asked for or retried. */
  const readable = () => !!snapshot.data && !snapshot.asking && !snapshot.retrying;
  async function ask() {
    const current = ++generation;
    missed = false; dirty = false;
    show({ asking: true, error: undefined });
    try {
      const answered = await create();
      if (current !== generation) return;
      show({ data: answered, asking: false });
      if (missed && !model.settled(answered)) refresh();
    } catch (error) { if (current === generation) show({ asking: false, error: failure(error) }); }
  }
  async function readAgain() {
    reading = true;
    const current = generation;
    try {
      while (dirty && active && current === generation && readable()) {
        dirty = false;
        const before = version, requestId = snapshot.data!.requestId;
        try {
          const response = await read(requestId);
          if (current !== generation || snapshot.data?.requestId !== requestId) break;
          if (before !== version) { dirty = true; continue; }
          show({ data: afterResponse(model, snapshot.data, response), error: undefined });
        } catch (error) {
          if (current !== generation) break;
          if (before !== version) { dirty = true; continue; }
          show({ error: failure(error) });
        }
      }
    } finally { reading = false; }
    if (dirty && active && readable()) void readAgain();
  }
  /** Reads the request again once, after any read already on its way. */
  function refresh() {
    if (snapshot.asking) { missed = true; return; }
    if (!snapshot.data) return;
    dirty = true;
    if (!reading && active && !snapshot.retrying) void readAgain();
  }
  const listener: UserChannelListener = {
    ready() { if (snapshot.asking || snapshot.data && !model.settled(snapshot.data)) refresh(); },
    progress(update) {
      if (snapshot.asking) return;
      const next = afterProgress(model, snapshot.data, update);
      if (next !== snapshot.data) show({ data: next });
    },
    notice(update) {
      if (update.resource !== model.resource) return;
      // The request being asked for has no ID yet: whatever this names, read it once it answers.
      if (snapshot.asking) { missed = true; return; }
      if (update.requestId === snapshot.data?.requestId) refresh();
    },
  };
  return {
    ...listener,
    snapshot: () => snapshot,
    subscribe(next: () => void) { listeners.add(next); return () => { listeners.delete(next); }; },
    /** Follows the request, asking for it the first time. */
    start() {
      active = true;
      if (!started) { started = true; void ask(); }
      else if (dirty && !reading && readable()) void readAgain();
    },
    /** Stops reading it: nothing on show needs it now. */
    stop() { active = false; },
    /** Reads it again once, as with other read parameters (a longer page). */
    reread() { if (snapshot.data && !snapshot.asking) refresh(); },
    /** Retries the request's failed analyses; its answer, pending again, has its progress followed. */
    async retry() {
      const held = snapshot.data;
      if (!held || snapshot.retrying) return;
      const current = generation;
      version++;
      show({ retrying: true, error: undefined });
      try {
        const response = await retry(held.requestId);
        if (current === generation) show({ data: afterResponse(model, snapshot.data, response) });
      } catch (error) { if (current === generation) show({ error: failure(error) }); }
      finally {
        show({ retrying: false });
        if (dirty && active && !reading && readable()) void readAgain();
      }
    },
    /** Asks for a new request in place of this one: after the request itself failed, or a read could not find it. */
    again() { void ask(); },
  };
}
export type RequestFollower<T extends Request> = ReturnType<typeof createRequestFollower<T>>;
