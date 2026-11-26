import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useShell } from './app-shell.js';
import { afterProgress, afterResponse, createRequestFollower, type Followed, type FollowerSnapshot } from './request-progress.js';

export interface FollowedRequestOptions<T> {
  /** The request's own key: a new key asks for a new request. */
  readonly key: string;
  readonly enabled: boolean;
  readonly model: Followed<T>;
  readonly create: () => Promise<T>;
  readonly read: (requestId: string) => Promise<T>;
  readonly retry: (requestId: string) => Promise<T>;
  /** While a new key's request is asked for, the previous request's state stays on show, marked `stale`. */
  readonly keepPrevious?: boolean;
  /** Read parameters beyond the request itself (a longer page): a change reads the request again, once. */
  readonly readKey?: string | number;
}
const idle: FollowerSnapshot<never> = { asking: false, retrying: false };

/**
 * A transient request the server answers at once and finishes in the background, followed on the Guest's user channel
 * (`request-progress`): asked for once `enabled`, its count raised by `progress`, and read again over HTTP only on its
 * notices and when the channel is ready again. Nothing reads it on a timer. Retry retries it, and `again` asks anew.
 */
export function useFollowedRequest<T extends { readonly requestId: string }>(options: FollowedRequestOptions<T>) {
  const { followRequests } = useShell();
  const latest = useRef(options); latest.current = options;
  const { key, enabled, model, keepPrevious, readKey } = options;
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new key is a new request, so it needs a new follower.
  const follower = useMemo(() => enabled ? createRequestFollower<T>({
    model, create: () => latest.current.create(), read: requestId => latest.current.read(requestId), retry: requestId => latest.current.retry(requestId),
  }) : undefined, [key, enabled, model]);
  const subscribe = useCallback((listener: () => void) => follower?.subscribe(listener) ?? (() => {}), [follower]);
  const snapshot: FollowerSnapshot<T> = useSyncExternalStore(subscribe, () => follower?.snapshot() ?? idle);
  useEffect(() => {
    if (!follower) return;
    const leave = followRequests(follower);
    follower.start();
    return () => { leave(); follower.stop(); };
  }, [follower, followRequests]);
  const readWith = useRef(readKey);
  useEffect(() => { if (readWith.current !== readKey) { readWith.current = readKey; follower?.reread(); } }, [readKey, follower]);
  // The last state on show, for a new request's wait when `keepPrevious` asks for it.
  const previous = useRef<T | undefined>(undefined);
  useEffect(() => { if (snapshot.data) previous.current = snapshot.data; }, [snapshot.data]);
  const stale = !snapshot.data && !!keepPrevious && snapshot.asking && previous.current !== undefined;
  return {
    data: snapshot.data ?? (stale ? previous.current : undefined),
    /** The data on show is an earlier request's, while the new one is asked for. */
    stale,
    /** The request itself is being asked for. */
    asking: snapshot.asking,
    error: snapshot.error,
    retrying: snapshot.retrying,
    retry: () => { void follower?.retry(); },
    again: () => follower?.again(),
  };
}

/**
 * The count of a request another hook reads over HTTP, kept current by `progress` messages (ADR-0026): the same client
 * rules as a followed request. `data` is the request as last read; the state returned is that read with the latest
 * count the Guest was told of, which only rises while the request is pending, and which a request held as complete or
 * failed never takes. It reads nothing itself: the reads still come on the request's notices and reconnects.
 */
export function useFollowedCount<T extends { readonly requestId: string }>(model: Followed<T>, data: T | undefined): T | undefined {
  const { followRequests } = useShell();
  const [state, setState] = useState<{ readonly source: T | undefined; readonly shown: T | undefined }>({ source: data, shown: data });
  let current = state;
  // A new read (or a Retry's answer) is taken as the state on show, except that it never lowers a pending count.
  if (state.source !== data) { current = { source: data, shown: data ? afterResponse(model, state.shown, data) : undefined }; setState(current); }
  useEffect(() => followRequests({
    ready() {},
    notice() {},
    progress: update => setState(held => { const shown = afterProgress(model, held.shown, update); return shown === held.shown ? held : { source: held.source, shown }; }),
  }), [followRequests, model]);
  return current.shown;
}
