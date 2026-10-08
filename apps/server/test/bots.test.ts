import { afterAll, beforeAll, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import WebSocket from 'ws';
import { baselinePlayingStrategy, type ObservableTableSession, type TableLiveMessage } from '@poker/contracts';
import { createServer } from '../src/server.js';

const databaseUrl = process.env.TEST_DATABASE_URL!;
const schema = 'test_' + randomUUID().replaceAll('-', '');
const administration = new Pool({ connectionString: databaseUrl });
let server: Awaited<ReturnType<typeof createServer>>;
let base: string;
beforeAll(async () => { await administration.query('CREATE SCHEMA "' + schema + '"'); server = await createServer({ databaseUrl, schema }); base = await server.listen({ host: '127.0.0.1', port: 0 }); });
afterAll(async () => { await server?.close(); await administration.query('DROP SCHEMA "' + schema + '" CASCADE'); await administration.end(); });
async function table() {
  const identity = await fetch(base + '/api/identity');
  const cookie = identity.headers.get('set-cookie')!.split(';')[0]!;
  const creation = await fetch(base + '/api/table-sessions', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ requestId: randomUUID(), bots: [{ name: 'Bot', playingStrategy: { ...baselinePlayingStrategy, selector: { id: 'highest-probability', version: 'v1', configuration: {} } } }] }) });
  expect(creation.status).toBe(201);
  const value = await creation.json();
  return { id: value.tableSessionId as string, cookie, human: value.bindings[0].participantId as string, bot: value.bindings[1].participantId as string };
}
type Table = Awaited<ReturnType<typeof table>>;
async function read(t: Table): Promise<ObservableTableSession> { return (await fetch(base + '/api/table-sessions/' + t.id, { headers: { cookie: t.cookie } })).json(); }
async function command(t: Table, kind: string, contents: object = {}) {
  const current = await read(t);
  const result = await fetch(base + '/api/table-sessions/' + t.id + '/' + kind, { method: 'POST', headers: { cookie: t.cookie, 'content-type': 'application/json' }, body: JSON.stringify({ requestId: randomUUID(), expectedPokerRevision: current.pokerRevision, ...contents }) });
  expect(result.status).toBe(200);
  return result.json();
}
test('server evaluates the bound Bot after a human action, publishes safe thinking and confirmed play, and waits after settlement', async () => {
  const t = await table();
  await command(t, 'seat-participant', { participantId: t.human, seat: 1 });
  await command(t, 'seat-participant', { participantId: t.bot, seat: 2 });
  const socket = new WebSocket(base.replace('http:', 'ws:') + '/api/table-sessions/' + t.id + '/live', { headers: { cookie: t.cookie } });
  const messages: TableLiveMessage[] = [];
  socket.on('message', data => messages.push(JSON.parse(data.toString())));
  try {
    await expect.poll(() => messages.length).toBe(1);
    await command(t, 'start-hand');
    await command(t, 'act', { participantId: t.human, action: { type: 'call' } });
    await expect.poll(async () => (await read(t)).view.state.status).toBe('completed-hand');
    expect(await read(t)).toMatchObject({ pokerRevision: 5, sessionRevision: 5 });
    expect(messages).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'table-status', status: { phase: 'thinking', participantId: t.bot } })]));
    expect(JSON.stringify(messages)).not.toMatch(/"(?:seed|evaluationSeed|selectionSeed|botProvenance|assignmentId|diagnostics|deck|burns)"\s*:/);
    expect((await read(t)).view.state.handId).toBe('hand-1');
  } finally { socket.terminate(); }
});
