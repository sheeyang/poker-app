import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { AnalysisUpdate, ClientLiveMessage, InspectionCapabilities, ObservableTableSession, ObservablePresentationEvent, ServerLiveMessage, TableRuntimeStatus } from '@poker/contracts';

// React Query applies this to HTTP reads and WebSocket cache writes.
export function retainNewestTable(previous: unknown, incoming: unknown): ObservableTableSession {
  const current = previous as ObservableTableSession | undefined;
  const next = incoming as ObservableTableSession;
  if (current?.tableSessionId === next.tableSessionId && current.sessionRevision > next.sessionRevision) return current;
  if (current?.tableSessionId === next.tableSessionId && current.sessionRevision === next.sessionRevision)
    return Object.hasOwn(next, 'runtimeStatus') ? { ...current, runtimeStatus: next.runtimeStatus } : current;
  return next;
}

type Connection = 'connecting' | 'connected' | 'reconnecting' | 'disconnected';
export interface UserChannelLifecycle { readonly generation: number; readonly reconnected: boolean }
export interface LiveConsumers {
  readonly onReady?: (lifecycle: UserChannelLifecycle) => void;
  readonly onAnalysisUpdate?: (update: AnalysisUpdate, lifecycle: UserChannelLifecycle) => void;
}
/** One app-lifetime socket; changing the open table only changes its subscription. */
export function useTableSynchronization(id: string | null, enabled: boolean, consumers: LiveConsumers = {}) {
  const queryClient = useQueryClient();
  const [paused, setPaused] = useState(false);
  const generation = useRef(0);
  const selected = useRef(id); selected.current = id;
  const callbacks = useRef(consumers); callbacks.current = consumers;
  const socket = useRef<WebSocket | null>(null);
  const ready = useRef(false);
  const connectedBefore = useRef(false);
  const pendingControls = useRef(new Map<string, ClientLiveMessage>());
  const [connection, setConnection] = useState<{ state: Connection; generation: number }>({ state: 'connecting', generation: 0 });
  const [userChannel, setUserChannel] = useState<UserChannelLifecycle | null>(null);
  const [subscription, setSubscription] = useState<{ id: string; generation: number; accepted: boolean } | null>(null);
  const [inspection, setInspection] = useState<{ id: string; generation: number; capabilities: InspectionCapabilities } | null>(null);
  const [events, setEvents] = useState<{ id: string; count: number; recent: readonly ObservablePresentationEvent[] } | null>(null);
  const [runtime, setRuntime] = useState<{ id: string; status: TableRuntimeStatus['status'] } | null>(null);
  function control(type: ClientLiveMessage['type'], tableSessionId: string) {
    if (!ready.current || socket.current?.readyState !== WebSocket.OPEN) return;
    const message: ClientLiveMessage = { type, requestId: crypto.randomUUID(), tableSessionId };
    pendingControls.current.set(tableSessionId, message);
    socket.current.send(JSON.stringify(message));
  }
  useEffect(() => {
    setEvents(null); setRuntime(null); setInspection(null); setSubscription(null);
    if (enabled && id) control('subscribe-table', id);
    return () => {
      if (enabled && id) control('unsubscribe-table', id);
      if (id) void queryClient.cancelQueries({ queryKey: ['table-session', id] });
    };
  }, [id, enabled, queryClient]);
  useEffect(() => {
    if (!enabled) return;
    if (paused) { setInspection(null); setUserChannel(null); setConnection({ state: 'disconnected', generation: ++generation.current }); return; }
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempts = 0;
    function connect() {
      if (stopped) return;
      const currentGeneration = ++generation.current;
      let inspectionRevision = -1;
      let lifecycle: UserChannelLifecycle | undefined;
      ready.current = false;
      pendingControls.current.clear();
      setInspection(null); setRuntime(null); setSubscription(null); setUserChannel(null);
      setConnection({ state: connectedBefore.current ? 'reconnecting' : 'connecting', generation: currentGeneration });
      const url = new URL('/api/live', location.href);
      url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const currentSocket = new WebSocket(url);
      socket.current = currentSocket;
      const current = () => !stopped && socket.current === currentSocket && generation.current === currentGeneration;
      currentSocket.onmessage = event => {
        if (!current()) return;
        let message: ServerLiveMessage;
        try { message = JSON.parse(event.data); } catch { return; }
        if (message.type === 'user-channel-ready') {
          if (ready.current) return;
          attempts = 0;
          ready.current = true;
          lifecycle = { generation: currentGeneration, reconnected: connectedBefore.current };
          connectedBefore.current = true;
          setUserChannel(lifecycle);
          setConnection({ state: 'connected', generation: currentGeneration });
          if (selected.current) {
            const tableId = selected.current;
            control('subscribe-table', tableId);
            // Cancel old-lifecycle reads before HTTP reconciliation. Query cancellation
            // also stops a delayed equal-revision response from restoring stale status.
            void queryClient.cancelQueries({ queryKey: ['table-session', tableId] }).then(() => {
              if (current() && selected.current === tableId) void queryClient.invalidateQueries({ queryKey: ['table-session', tableId] });
            });
          }
          callbacks.current.onReady?.(lifecycle);
          return;
        }
        if (message.type === 'analysis-update') {
          if (lifecycle) callbacks.current.onAnalysisUpdate?.(message, lifecycle);
          return;
        }
        const tableId = message.tableSessionId;
        const key = ['table-session', tableId];
        if (message.type === 'table-subscription-result') {
          const pending = pendingControls.current.get(tableId);
          if (!pending || pending.requestId !== message.requestId) return;
          pendingControls.current.delete(tableId);
          if (tableId !== selected.current) return;
          if (message.status === 'subscribed') inspectionRevision = -1;
          setSubscription({ id: tableId, generation: currentGeneration, accepted: message.status === 'subscribed' });
          return;
        }
        if (tableId !== selected.current) return;
        if (message.type === 'table-status') {
          setRuntime({ id: tableId, status: message.status });
          queryClient.setQueryData<ObservableTableSession>(key, cached => cached ? { ...cached, runtimeStatus: message.status } : cached);
          return;
        }
        if (message.type !== 'table-update') return;
        // Capabilities are tied to this connection, never taken from HTTP/cache.
        if (message.sessionRevision > inspectionRevision) {
          inspectionRevision = message.sessionRevision;
          setInspection({ id: tableId, generation: currentGeneration, capabilities: message.inspection });
        }
        let accepted = false;
        queryClient.setQueryData<ObservableTableSession>(key, cached => {
          accepted = !cached || message.sessionRevision > cached.sessionRevision;
          return retainNewestTable(cached, message);
        });
        if (accepted) setEvents(previous => ({ id: tableId, count: (previous?.id === tableId ? previous.count : 0) + message.presentationEvents.length, recent: message.presentationEvents }));
      };
      currentSocket.onclose = () => {
        if (!current()) return;
        socket.current = null; ++generation.current;
        ready.current = false;
        setInspection(null); setUserChannel(null); setSubscription(null);
        setConnection({ state: 'reconnecting', generation: currentGeneration });
        if (selected.current) void queryClient.cancelQueries({ queryKey: ['table-session', selected.current] });
        timer = setTimeout(connect, Math.min(500 * 2 ** attempts++, 5000));
      };
      currentSocket.onerror = () => { if (current()) currentSocket.close(); };
    }
    connect();
    return () => {
      stopped = true; ready.current = false; ++generation.current;
      clearTimeout(timer);
      if (selected.current) void queryClient.cancelQueries({ queryKey: ['table-session', selected.current] });
      const retired = socket.current; socket.current = null;
      if (retired) { retired.onmessage = null; retired.onclose = null; retired.onerror = null; retired.close(); }
      pendingControls.current.clear();
    };
  }, [enabled, paused, queryClient]);
  const subscribed = subscription?.id === id && subscription.generation === connection.generation && subscription.accepted;
  return {
    userChannel,
    inspectionCapabilities: inspection?.id === id && inspection.generation === connection.generation ? inspection.capabilities : undefined,
    inspectionGeneration: connection.generation,
    connection: connection.state === 'connected' && id && !subscribed ? 'connecting' : connection.state,
    eventCount: events?.id === id ? events.count : 0,
    recentEvents: events?.id === id ? events.recent : [],
    runtimeStatus: runtime?.id === id ? runtime.status : undefined,
    disconnect: () => setPaused(true),
    reconnect: () => setPaused(false),
  };
}
