import { afterAll, beforeAll, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import WebSocket from 'ws';
import { baselinePlayingStrategy, type ServerLiveMessage } from '@poker/contracts';
import { createServer } from '../src/server.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('Set TEST_DATABASE_URL to a real PostgreSQL test database.');
const schema = 'test_' + randomUUID().replaceAll('-', '');
const administration = new Pool({ connectionString: databaseUrl });
let server: Awaited<ReturnType<typeof createServer>>;
let base: string;
beforeAll(async () => {
  await administration.query('CREATE SCHEMA "' + schema + '"');
  server = await createServer({ automaticBots: false, databaseUrl, schema });
  base = await server.listen({ host: '127.0.0.1', port: 0 });
});
afterAll(async () => { await server?.close(); await administration.query('DROP SCHEMA "' + schema + '" CASCADE'); await administration.end(); });
async function identity() { return (await fetch(base + '/api/identity')).headers.get('set-cookie')!.split(';')[0]!; }
function connect(cookie: string) {
  const socket = new WebSocket(base.replace('http:', 'ws:') + '/api/live', { headers: { cookie } });
  const messages: ServerLiveMessage[] = [];
  socket.on('message', data => messages.push(JSON.parse(data.toString())));
  socket.on('error', () => {});
  return { socket, messages };
}

test('the shared socket authenticates its cookie and readies the user channel without a table subscription', async () => {
  for (const cookie of ['', 'poker_local=unknown']) {
    const live = connect(cookie);
    const status = await new Promise<number>(resolve => live.socket.once('unexpected-response', (_request, response) => { response.resume(); resolve(response.statusCode!); }));
    expect(status).toBe(401);
    expect(live.messages).toEqual([]);
    live.socket.terminate();
  }
  const live = connect(await identity());
  try {
    await expect.poll(() => live.messages).toEqual([{ type: 'user-channel-ready' }]);
    expect(live.socket.readyState).toBe(WebSocket.OPEN);
  } finally { live.socket.terminate(); }
});

async function table(cookie: string) {
  const response = await fetch(base + '/api/table-sessions', { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ requestId: randomUUID(), bots: [{ name: 'Bot', playingStrategy: baselinePlayingStrategy }] }) });
  const created = await response.json();
  return { id: created.tableSessionId as string, human: created.bindings[0].participantId as string };
}
async function seat(cookie: string, target: Awaited<ReturnType<typeof table>>) {
  return fetch(base + '/api/table-sessions/' + target.id + '/seat-participant', { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ requestId: randomUUID(), expectedPokerRevision: 0, participantId: target.human, seat: 1 }) });
}

test('one socket authorizes multiple subscriptions, isolates removal and restores the latest complete safe view', async () => {
  const cookie = await identity();
  const first = await table(cookie);
  const second = await table(cookie);
  const inaccessible = await table(await identity());
  const live = connect(cookie);
  async function command(type: 'subscribe-table' | 'unsubscribe-table', id: string) {
    const requestId = randomUUID();
    live.socket.send(JSON.stringify({ type, tableSessionId: id, requestId }));
    await expect.poll(() => live.messages.find(message => message.type === 'table-subscription-result' && message.requestId === requestId)).toBeDefined();
    return live.messages.find(message => message.type === 'table-subscription-result' && message.requestId === requestId)!;
  }
  try {
    await expect.poll(() => live.messages[0]).toEqual({ type: 'user-channel-ready' });
    expect(await command('subscribe-table', first.id)).toMatchObject({ tableSessionId: first.id, status: 'subscribed' });
    expect(await command('subscribe-table', second.id)).toMatchObject({ tableSessionId: second.id, status: 'subscribed' });
    expect(await command('subscribe-table', inaccessible.id)).toMatchObject({ tableSessionId: inaccessible.id, status: 'rejected', code: 'not-found' });
    await expect.poll(() => live.messages.filter(message => message.type === 'table-update').length).toBe(2);
    expect(live.messages.filter(message => message.type === 'table-update')).toEqual(expect.arrayContaining([
      expect.objectContaining({ tableSessionId: first.id, sessionRevision: 0, presentationEvents: [], runtimeStatus: { phase: 'idle' } }),
      expect.objectContaining({ tableSessionId: second.id, sessionRevision: 0, presentationEvents: [] }),
    ]));
    expect(await command('unsubscribe-table', first.id)).toMatchObject({ tableSessionId: first.id, status: 'unsubscribed' });
    expect((await seat(cookie, first)).status).toBe(200);
    expect((await seat(cookie, second)).status).toBe(200);
    await expect.poll(() => live.messages.find(message => message.type === 'table-update' && message.tableSessionId === second.id && message.sessionRevision === 1)).toBeDefined();
    expect(live.messages.filter(message => message.type === 'table-update' && message.tableSessionId === first.id)).toHaveLength(1);
    expect(live.messages.some(message => 'tableSessionId' in message && message.tableSessionId === inaccessible.id && message.type !== 'table-subscription-result')).toBe(false);
    expect(await command('subscribe-table', first.id)).toMatchObject({ status: 'subscribed' });
    await expect.poll(() => live.messages.find(message => message.type === 'table-update' && message.tableSessionId === first.id && message.sessionRevision === 1)).toMatchObject({ pokerRevision: 1, presentationEvents: [], view: { state: { participants: [{ participantId: first.human, seat: 1, stack: 1000 }] } } });
    expect(live.socket.readyState).toBe(WebSocket.OPEN);
  } finally { live.socket.close(); await new Promise<void>(resolve => live.socket.once('close', () => resolve())); }
  const reconnected = connect(cookie);
  try {
    await expect.poll(() => reconnected.messages).toEqual([{ type: 'user-channel-ready' }]);
    reconnected.socket.send(JSON.stringify({ type: 'subscribe-table', requestId: 'restored', tableSessionId: first.id }));
    await expect.poll(() => reconnected.messages.find(message => message.type === 'table-update')).toMatchObject({ tableSessionId: first.id, sessionRevision: 1, presentationEvents: [] });
    expect(reconnected.messages.filter(message => message.type === 'table-update')).toHaveLength(1);
  } finally { reconnected.socket.terminate(); }
});
