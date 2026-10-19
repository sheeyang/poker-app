/** Local browser test fixture: alter transport delivery while retaining real HTTP/WS/PostgreSQL. */
import http from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';

const upstream = new URL(process.env.POKER_API_UPSTREAM ?? 'http://127.0.0.1:4011');
const frames = new Map<string, unknown[]>();
const dropped = new Map<string, Set<number>>();
const sockets = new Map<WebSocket, { id: number; tables: Set<string> }>();
let opened = 0;
const holds = new Set<string>();
const held: { key: string; send: () => void }[] = [];
const keyFor = (id: string, kind: string) => id + ':' + kind;
const websocket = new WebSocketServer({ noServer: true });
const relay = http.createServer(async (request, response) => {
  const url = new URL(request.url!, 'http://localhost');
  if (url.pathname === '/api/__transport') {
    if (request.method === 'POST') {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const control = JSON.parse(Buffer.concat(chunks).toString());
      const id = control.tableSessionId as string;
      if (control.kind === 'hold') holds.add(keyFor(id, control.responseKind));
      if (control.kind === 'release') {
        const key = keyFor(id, control.responseKind);
        holds.delete(key);
        for (let index = held.length - 1; index >= 0; index--) if (held[index]!.key === key) held.splice(index, 1)[0]!.send();
      }
      if (control.kind === 'drop') {
        const revisions = dropped.get(id) ?? new Set<number>();
        revisions.add(control.revision);
        dropped.set(id, revisions);
      }
      if (control.kind === 'replay') {
        const frame = frames.get(id)?.find(value => (value as { sessionRevision: number }).sessionRevision === control.revision);
        if (!frame) { response.writeHead(404).end('Frame not captured'); return; }
        for (const [socket, tableId] of sockets) if (tableId.tables.has(id) && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame));
      }
      if (control.kind === 'disconnect') for (const [socket, connection] of sockets) if (!id || connection.tables.has(id)) socket.close();
      if (control.kind === 'status') for (const [socket, tableId] of sockets) if (tableId.tables.has(id) && socket.readyState === WebSocket.OPEN)
        socket.send(JSON.stringify({ type: 'table-status', tableSessionId: id, status: control.status }));
    }
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ held: held.map(entry => entry.key), sockets: [...sockets.values()].flatMap(connection => [...connection.tables]), connections: [...sockets.values()].map(connection => ({ id: connection.id, tableSessionIds: [...connection.tables] })), opened }));
    return;
  }
  const outgoing = http.request(new URL(request.url!, upstream), { method: request.method, headers: request.headers }, incoming => {
    const chunks: Buffer[] = [];
    incoming.on('data', chunk => chunks.push(chunk));
    incoming.on('end', () => {
      const send = () => { response.writeHead(incoming.statusCode!, incoming.headers); response.end(Buffer.concat(chunks)); };
      const match = /^\/api\/table-sessions\/([^/]+)(?:\/([^/]+))?$/.exec(url.pathname);
      const key = match ? keyFor(match[1]!, match[2] ?? 'read') : '';
      if (holds.delete(key)) held.push({ key, send }); else send();
    });
  });
  outgoing.on('error', () => response.writeHead(502).end('Upstream unavailable'));
  request.pipe(outgoing);
});
relay.on('upgrade', (request, socket, head) => {
  websocket.handleUpgrade(request, socket, head, client => {
    const id = /\/table-sessions\/([^/]+)\/live/.exec(request.url!)?.[1] ?? '';
    const connection = { id: ++opened, tables: new Set(id ? [id] : []) };
    sockets.set(client, connection);
    const server = new WebSocket(new URL(request.url!, upstream.href.replace('http:', 'ws:')), { headers: { cookie: request.headers.cookie ?? '' } });
    const pending: string[] = [];
    server.on('open', () => { for (const message of pending) server.send(message); pending.length = 0; });
    client.on('message', data => { if (server.readyState === WebSocket.OPEN) server.send(data.toString()); else if (server.readyState === WebSocket.CONNECTING) pending.push(data.toString()); });
    server.on('message', data => {
      const frame = JSON.parse(data.toString());
      if (frame.type === 'table-subscription-result') {
        if (frame.status === 'subscribed') connection.tables.add(frame.tableSessionId);
        if (frame.status === 'unsubscribed' || frame.status === 'rejected') connection.tables.delete(frame.tableSessionId);
      }
      const id = frame.tableSessionId ?? '';
      const captured = frames.get(id) ?? [];
      captured.push(frame); frames.set(id, captured);
      const send = () => { if (!dropped.get(id)?.has(frame.sessionRevision) && client.readyState === WebSocket.OPEN) client.send(data.toString()); };
      if (holds.has(keyFor(id, 'live'))) held.push({ key: keyFor(id, 'live'), send }); else send();
    });
    server.on('close', () => client.close());
    server.on('error', () => client.close());
    client.on('close', () => { sockets.delete(client); server.close(); });
    client.on('error', () => server.close());
  });
});
relay.listen(Number(process.env.POKER_TRANSPORT_PORT ?? 4012), '127.0.0.1', () => console.log('Browser transport fixture listening on ' + (process.env.POKER_TRANSPORT_PORT ?? 4012)));
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => {
  for (const socket of sockets.keys()) socket.terminate();
  websocket.close(); relay.close();
});
