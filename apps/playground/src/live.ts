import { useEffect, useRef, useState } from 'react';
import type { InspectionCapabilities } from '@poker/contracts';
import { useQueryClient } from '@tanstack/react-query';
import type { ObservableTableSession, ObservablePresentationEvent, TableLiveMessage, TableRuntimeStatus } from '@poker/contracts';

// React Query applies this to both completed HTTP reads and WebSocket cache writes.
// A complete newer snapshot is sufficient even when intermediate revisions were missed.
export function retainNewestTable(previous: unknown, incoming: unknown): ObservableTableSession {
  const current = previous as ObservableTableSession | undefined;
  const next = incoming as ObservableTableSession;
  return current?.tableSessionId === next.tableSessionId && current.sessionRevision >= next.sessionRevision ? current : next;
}
type Connection = 'connecting' | 'connected' | 'reconnecting' | 'disconnected';
export function useTableSynchronization(id: string | null, enabled: boolean) {
  const queryClient = useQueryClient();
  const [pausedId, setPausedId] = useState<string | null>(null);
  const generation = useRef(0);
  const [connection, setConnection] = useState<{ id: string; state: Connection; generation: number } | null>(null);
  const [inspection, setInspection] = useState<{ id: string; generation: number; capabilities: InspectionCapabilities } | null>(null);
  const [events, setEvents] = useState<{ id: string; count: number; recent: readonly ObservablePresentationEvent[] } | null>(null);
  const [runtime, setRuntime] = useState<{ id: string; status: TableRuntimeStatus['status'] } | null>(null);
  useEffect(() => { setEvents(null); setRuntime(null); setInspection(null); }, [id]);
  useEffect(() => {
    if (!enabled || !id) return;
    if (pausedId === id) { setInspection(null); setConnection({ id, state: 'disconnected', generation: ++generation.current }); return; }
    let stopped = false;
    let socket: WebSocket | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempts = 0;
    const key = ['table-session', id];
    function connect() {
      if (stopped) return;
      const currentGeneration = ++generation.current;
      let inspectionRevision = -1;
      setInspection(null);
      setRuntime(null);
      setConnection({ id: id!, state: attempts === 0 ? 'connecting' : 'reconnecting', generation: currentGeneration });
      const url = new URL('/api/table-sessions/' + encodeURIComponent(id!) + '/live', location.href);
      url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      socket = new WebSocket(url);
      const connectingSocket = socket;
      socket.onmessage = event => {
        if (stopped || socket !== connectingSocket) return;
        let message: TableLiveMessage;
        try { message = JSON.parse(event.data); } catch { return; }
        if (message.tableSessionId !== id) return;
        if (message.type === 'table-status') {
          // Thinking/failure/recovery may change without a durable session revision.
          setRuntime({ id: id!, status: message.status });
          return;
        }
        if (message.type !== 'table-update') return;
        attempts = 0;
        setConnection({ id: id!, state: 'connected', generation: currentGeneration });
        // Capabilities come only from this connection, never a delayed HTTP/cache read.
        // Its first full frame applies even if gameplay retained the same revision from a prior server.
        if (message.sessionRevision > inspectionRevision) {
          inspectionRevision = message.sessionRevision;
          setInspection({ id: id!, generation: currentGeneration, capabilities: message.inspection });
        }
        let accepted = false;
        queryClient.setQueryData<ObservableTableSession>(key, current => {
          accepted = !current || message.sessionRevision > current.sessionRevision;
          return retainNewestTable(current, message);
        });
        if (accepted) setEvents(current => ({ id: id!, count: (current?.id === id ? current.count : 0) + message.presentationEvents.length, recent: message.presentationEvents }));
      };
      socket.onclose = () => {
        if (stopped || socket !== connectingSocket) return;
        setInspection(null);
        setConnection({ id: id!, state: 'reconnecting', generation: currentGeneration });
        void queryClient.invalidateQueries({ queryKey: key });
        timer = setTimeout(connect, Math.min(500 * 2 ** attempts++, 5000));
      };
      socket.onerror = () => connectingSocket.close();
    }
    connect();
    return () => { stopped = true; clearTimeout(timer); socket?.close(); };
  }, [id, enabled, pausedId, queryClient]);
  return {
    inspectionCapabilities: inspection?.id === id && inspection.generation === connection?.generation ? inspection.capabilities : undefined,
    inspectionGeneration: connection?.generation,
    connection: connection?.id === id ? connection.state : 'connecting',
    eventCount: events?.id === id ? events.count : 0,
    recentEvents: events?.id === id ? events.recent : [],
    runtimeStatus: runtime?.id === id ? runtime.status : undefined,
    disconnect: () => setPausedId(id),
    reconnect: () => setPausedId(null),
  };
}
