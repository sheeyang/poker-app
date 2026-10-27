import { useCallback, useEffect, useRef, useState } from 'react';
import type { LiveConsumers } from './live.js';
import { RequestFailure } from './api.js';
interface ResourceState { readonly tableSessionId: string; readonly requestId: string; readonly attemptId: string; readonly status: string }
interface ResourceOptions<T> {
  readonly key: string; readonly tableId: string; readonly resource: 'analysis' | 'summary';
  readonly create: () => Promise<T>; readonly read: (requestId: string) => Promise<T>; readonly retry: (requestId: string) => Promise<T>;
  readonly accepts: (data: T) => boolean; readonly recoverMissing: boolean; readonly wanted: boolean;
}
interface Target<T> extends Omit<ResourceOptions<T>, 'wanted'> {
  wanted: boolean; dirty: number; signals: number; version: number; retrying: boolean; obsoleteAttempts: Set<string>; fetching: boolean; retired: boolean; blocked: boolean; data?: T;
}
export function createAnalysisTarget<T>(options: ResourceOptions<T>): Target<T> {
  return { ...options, dirty: 0, signals: 0, version: 0, retrying: false, obsoleteAttempts: new Set(), fetching: false, retired: false, blocked: false };
}
/** Shared HTTP reconciliation for decision and summary resources, driven only by explicit actions and live readiness/notifications. */
export function useAnalysisResource<T extends ResourceState>(target: Target<T> | null) {
  const current = useRef(target); current.current = target;
  const connection = useRef<number | null>(null);
  const [display, setDisplay] = useState<{ key: string; loading: boolean; retrying?: boolean; data?: T; error?: string; errorCode?: string }>();
  useEffect(() => { if (target) target.retired = false; return () => { if (target) target.retired = true; }; }, [target]);
  const reconcile = useCallback(async (active: Target<T>): Promise<void> => {
    if (active.fetching || active.retrying || active.retired || current.current !== active || !active.wanted || active.blocked && !active.data) return;
    active.fetching = true;
    const initialConnection = connection.current;
    try {
      do {
        active.dirty = 0;
        const generation = connection.current, version = active.version, signals = active.signals;
        setDisplay({ key: active.key, loading: true, data: active.data });
        try {
          const creating = !active.data;
          const data = active.data ? await active.read(active.data.requestId) : await active.create();
          if (active.retired || current.current !== active) return;
          // Summary creation is a snapshot operation. Retain its returned identity even when a signal or reconnect raced the response.
          if (creating && !active.recoverMissing && version === active.version && active.accepts(data)) active.data = data;
          if (connection.current !== generation) { active.dirty++; continue; }
          if (version !== active.version || signals !== active.signals) { active.dirty++; continue; }
          if (!active.accepts(data)) { setDisplay({ key: active.key, loading: false, error: 'The analysis target changed. Refresh the Table Session and request again.' }); return; }
          if (active.data && data.requestId !== active.data.requestId || active.obsoleteAttempts.has(data.attemptId)) continue;
          if (active.data && data.attemptId !== active.data.attemptId) active.obsoleteAttempts.add(active.data.attemptId);
          active.data = data;
          setDisplay({ key: active.key, loading: false, data });
        } catch (error) {
          if (active.retired || current.current !== active) return;
          if (connection.current !== generation) { active.dirty++; continue; }
          if (version !== active.version || signals !== active.signals) { active.dirty++; continue; }
          if (error instanceof RequestFailure && error.code === 'not-found' && active.data && active.recoverMissing) { active.data = undefined; active.dirty++; continue; }
          if (!active.recoverMissing && !active.data) active.blocked = true;
          setDisplay({ key: active.key, loading: false, ...(active.recoverMissing ? { data: active.data } : {}), errorCode: error instanceof RequestFailure ? error.code : undefined, error: error instanceof Error ? error.message : 'The analysis could not be read. Try requesting it again.' });
        }
      } while (active.dirty > 0 && (connection.current !== null || initialConnection === null) && !active.retrying && !active.retired && current.current === active);
    } finally {
      active.fetching = false;
      if (active.dirty > 0 && !active.retrying && !active.retired && current.current === active && (connection.current !== null || initialConnection === null)) void reconcile(active);
    }
  }, []);
  useEffect(() => { if (target?.wanted) void reconcile(target); }, [target, reconcile]);
  const refresh = useCallback(() => {
    const active = current.current;
    if (!active?.wanted) return;
    active.dirty++; active.signals++; void reconcile(active);
  }, [reconcile]);
  const consumers: LiveConsumers = {
    onReady: lifecycle => { connection.current = lifecycle.generation; refresh(); },
    onAnalysisUpdate: (update, lifecycle) => {
      const active = current.current;
      if (!active?.wanted || update.resource !== active.resource || update.tableSessionId !== active.tableId || lifecycle.generation !== connection.current) return;
      if (active.data && update.requestId !== active.data.requestId || active.obsoleteAttempts.has(update.attemptId)) return;
      refresh();
    },
  };
  const connectionChanged = useCallback((generation: number | null) => {
    if (connection.current === generation) return;
    connection.current = generation;
    if (generation !== null) refresh(); else if (current.current?.wanted) current.current.dirty++;
  }, [refresh]);
  return {
    consumers, connectionChanged,
    display: target?.wanted && display?.key === target.key ? display : undefined,
    request: (fresh = false) => {
      if (!target) return;
      if (fresh) { target.version++; target.data = undefined; target.blocked = false; }
      target.wanted = true; target.dirty++; void reconcile(target);
    },
    retry: async () => {
      const active = current.current;
      if (!active?.data || active.data.status !== 'error' || active.retrying || active.retired) return;
      const requestId = active.data.requestId, version = ++active.version, signals = active.signals, generation = connection.current;
      active.retrying = true;
      setDisplay({ key: active.key, loading: false, retrying: true, data: active.data });
      try {
        const data = await active.retry(requestId);
        if (active.retired || current.current !== active || version !== active.version) return;
        if (connection.current !== generation || signals !== active.signals) { active.dirty++; return; }
        if (data.requestId !== requestId || active.obsoleteAttempts.has(data.attemptId)) return;
        if (active.data.attemptId !== data.attemptId) active.obsoleteAttempts.add(active.data.attemptId);
        active.data = data; setDisplay({ key: active.key, loading: false, data });
      } catch (error) {
        if (active.retired || current.current !== active || version !== active.version) return;
        if (connection.current !== generation || signals !== active.signals) { active.dirty++; return; }
        setDisplay({ key: active.key, loading: false, data: active.data, error: error instanceof Error ? error.message : 'The analysis could not be retried. Read it before trying again.' });
      } finally {
        active.retrying = false;
        if (!active.retired && current.current === active) {
          setDisplay(previous => previous?.key === active.key ? { ...previous, retrying: false } : previous);
          if (active.dirty > 0) void reconcile(active);
        }
      }
    },
  };
}
