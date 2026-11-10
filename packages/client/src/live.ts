import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { AnalysisUpdate, ClientLiveMessage, InspectionCapabilities, ObservableTableSession, ObservablePresentationEvent, ServerLiveMessage, TableMembershipEnded, TableRuntimeStatus } from '@poker/contracts';

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
  /** A followed table no longer includes this Guest's Participant: they left it (or were removed). */
  readonly onMembershipEnded?: (ended: TableMembershipEnded) => void;
}
/** Per followed table, the latest word of the current connection. */
type PerTable<T> = { readonly generation: number; readonly tables: Readonly<Record<string, T>> };
const none = { generation: 0, tables: {} };
type Setter<T> = (update: (previous: PerTable<T>) => PerTable<T>) => void;
/** Records a connection's latest word about one table; `undefined` forgets it. */
function record<T>(set: Setter<T>, generation: number, tableId: string, value: T | undefined) {
  set(previous => {
    const { [tableId]: _replaced, ...others } = previous.generation === generation ? previous.tables : {};
    return { generation, tables: value === undefined ? others : { ...others, [tableId]: value } };
  });
}

/**
 * One app-lifetime socket; changing the open table only changes its subscriptions. It follows the open table, `id`,
 * and also `following`, the Guest's Current Table, from every page: the server counts a Guest connected to a table
 * while any of their live connections is subscribed to it, so looking at another page never sits them out. Updates
 * to either table reach the query cache, and `onMembershipEnded` hears of either; what this returns is about the open
 * table, so opening the followed table finds its live state already there.
 */
export function useTableSynchronization(id: string | null, enabled: boolean, consumers: LiveConsumers = {}, following: string | null = null) {
  const queryClient = useQueryClient();
  const [paused, setPaused] = useState(false);
  const generation = useRef(0);
  const selected = useRef(id); selected.current = id;
  const wanted = [...new Set([id, following].filter((table): table is string => !!table))];
  const followed = useRef(wanted); followed.current = wanted;
  // The tables subscribed to, or asked for, on the current connection.
  const asked = useRef(new Set<string>());
  const callbacks = useRef(consumers); callbacks.current = consumers;
  const socket = useRef<WebSocket | null>(null);
  const ready = useRef(false);
  const connectedBefore = useRef(false);
  const pendingControls = useRef(new Map<string, ClientLiveMessage>());
  const [connection, setConnection] = useState<{ state: Connection; generation: number }>({ state: 'connecting', generation: 0 });
  const [userChannel, setUserChannel] = useState<UserChannelLifecycle | null>(null);
  const [subscriptions, setSubscriptions] = useState<PerTable<boolean>>(none);
  const [inspection, setInspection] = useState<PerTable<InspectionCapabilities>>(none);
  const [events, setEvents] = useState<{ id: string; count: number; recent: readonly ObservablePresentationEvent[] } | null>(null);
  const [runtime, setRuntime] = useState<PerTable<TableRuntimeStatus['status']>>(none);
  // Who is connected changes without a revision, so the latest live message, not the cached view, says it.
  const [presence, setPresence] = useState<PerTable<readonly string[]>>(none);
  function control(type: ClientLiveMessage['type'], tableSessionId: string) {
    if (!ready.current || socket.current?.readyState !== WebSocket.OPEN) return false;
    const message: ClientLiveMessage = { type, requestId: crypto.randomUUID(), tableSessionId };
    pendingControls.current.set(tableSessionId, message);
    socket.current.send(JSON.stringify(message));
    return true;
  }
  /** Subscribes to each followed table not yet asked for on this connection, and drops those no longer followed. */
  function follow() {
    for (const table of followed.current) if (!asked.current.has(table) && control('subscribe-table', table)) asked.current.add(table);
    for (const table of asked.current) if (!followed.current.includes(table) && control('unsubscribe-table', table)) asked.current.delete(table);
  }
  const wantedKey = wanted.join(' ');
  useEffect(() => { if (enabled) follow(); }, [wantedKey, enabled]);
  useEffect(() => {
    setEvents(null);
    // A table no longer followed stops reading; one still followed, such as the Current Table, keeps its reads.
    return () => { if (id && !followed.current.includes(id)) void queryClient.cancelQueries({ queryKey: ['table-session', id] }); };
  }, [id, queryClient]);
  useEffect(() => {
    if (!enabled) return;
    if (paused) { setInspection(none); setUserChannel(null); setConnection({ state: 'disconnected', generation: ++generation.current }); return; }
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempts = 0;
    function connect() {
      if (stopped) return;
      const currentGeneration = ++generation.current;
      const inspectionRevisions = new Map<string, number>();
      let lifecycle: UserChannelLifecycle | undefined;
      ready.current = false;
      pendingControls.current.clear(); asked.current.clear();
      const fresh = { generation: currentGeneration, tables: {} };
      setInspection(fresh); setRuntime(fresh); setPresence(fresh); setSubscriptions(fresh); setUserChannel(null);
      setConnection({ state: connectedBefore.current ? 'reconnecting' : 'connecting', generation: currentGeneration });
      const url = new URL('/api/live', location.href);
      url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const currentSocket = new WebSocket(url);
      socket.current = currentSocket;
      const current = () => !stopped && socket.current === currentSocket && generation.current === currentGeneration;
      const remember = <T,>(set: Setter<T>, tableId: string, value: T | undefined) => record(set, currentGeneration, tableId, value);
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
          follow();
          for (const tableId of followed.current) {
            // Cancel old-lifecycle reads before HTTP reconciliation. Query cancellation
            // also stops a delayed equal-revision response from restoring stale status.
            void queryClient.cancelQueries({ queryKey: ['table-session', tableId] }).then(() => {
              if (current() && followed.current.includes(tableId)) void queryClient.invalidateQueries({ queryKey: ['table-session', tableId] });
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
          inspectionRevisions.delete(tableId);
          if (message.status === 'unsubscribed') {
            // A table no longer followed keeps nothing of this connection's word about it.
            remember(setSubscriptions, tableId, undefined); remember(setPresence, tableId, undefined);
            remember(setInspection, tableId, undefined); remember(setRuntime, tableId, undefined);
          } else remember(setSubscriptions, tableId, message.status === 'subscribed');
          return;
        }
        if (!followed.current.includes(tableId)) return;
        if (message.type === 'table-membership-ended') { callbacks.current.onMembershipEnded?.(message); return; }
        if (message.type === 'table-presence') { remember(setPresence, tableId, message.connectedParticipantIds); return; }
        if (message.type === 'table-status') {
          remember(setRuntime, tableId, message.status);
          queryClient.setQueryData<ObservableTableSession>(key, cached => cached ? { ...cached, runtimeStatus: message.status } : cached);
          return;
        }
        if (message.type !== 'table-update') return;
        // Every complete update says who is connected as it was sent, even one older than the cached revision.
        const connected = message.connectedParticipantIds;
        if (connected) remember(setPresence, tableId, connected);
        // Capabilities are tied to this connection, never taken from HTTP/cache.
        if (message.sessionRevision > (inspectionRevisions.get(tableId) ?? -1)) {
          inspectionRevisions.set(tableId, message.sessionRevision);
          remember(setInspection, tableId, message.inspection);
        }
        let accepted = false;
        queryClient.setQueryData<ObservableTableSession>(key, cached => {
          accepted = !cached || message.sessionRevision > cached.sessionRevision;
          return retainNewestTable(cached, message);
        });
        // Presentation events animate the open table only.
        if (accepted && tableId === selected.current) setEvents(previous => ({ id: tableId, count: (previous?.id === tableId ? previous.count : 0) + message.presentationEvents.length, recent: message.presentationEvents }));
      };
      currentSocket.onclose = () => {
        if (!current()) return;
        socket.current = null; ++generation.current;
        ready.current = false;
        setInspection(none); setUserChannel(null); setSubscriptions(none); setPresence(none);
        setConnection({ state: 'reconnecting', generation: currentGeneration });
        for (const tableId of followed.current) void queryClient.cancelQueries({ queryKey: ['table-session', tableId] });
        timer = setTimeout(connect, Math.min(500 * 2 ** attempts++, 5000));
      };
      currentSocket.onerror = () => { if (current()) currentSocket.close(); };
    }
    connect();
    return () => {
      stopped = true; ready.current = false; ++generation.current;
      clearTimeout(timer);
      for (const tableId of followed.current) void queryClient.cancelQueries({ queryKey: ['table-session', tableId] });
      const retired = socket.current; socket.current = null;
      if (retired) { retired.onmessage = null; retired.onclose = null; retired.onerror = null; retired.close(); }
      pendingControls.current.clear(); asked.current.clear();
    };
  }, [enabled, paused, queryClient]);
  /** This connection's latest word about the open table. */
  const latest = <T,>(state: PerTable<T>) => id && state.generation === connection.generation ? state.tables[id] : undefined;
  const subscribed = latest(subscriptions) === true;
  return {
    userChannel,
    inspectionCapabilities: latest(inspection),
    inspectionGeneration: connection.generation,
    connection: connection.state === 'connected' && id && !subscribed ? 'connecting' : connection.state,
    eventCount: events?.id === id ? events.count : 0,
    recentEvents: events?.id === id ? events.recent : [],
    runtimeStatus: latest(runtime),
    /** At an Online Table, the Participants connected now, from this connection's latest message. */
    connectedParticipantIds: latest(presence),
    /**
     * Asks again for the open table, whose subscription the server refused while this Guest was not at it: after
     * joining through its Join Link, the same address becomes their table.
     */
    resubscribe: () => { if (enabled && selected.current && control('subscribe-table', selected.current)) asked.current.add(selected.current); },
    disconnect: () => setPaused(true),
    reconnect: () => setPaused(false),
  };
}
