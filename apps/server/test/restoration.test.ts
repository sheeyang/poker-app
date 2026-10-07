import { afterAll, beforeAll, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import WebSocket from 'ws';
import { baselinePlayingStrategy, type ObservableTableSession, type ObservableTableUpdate } from '@poker/contracts';
import { createServer } from '../src/server.js';
import type { TableSessionControllerCommands } from '../src/mutations.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('Set TEST_DATABASE_URL to a real PostgreSQL test database.');
const schema = 'test_' + randomUUID().replaceAll('-', '');
const administration = new Pool({ connectionString: databaseUrl });
let server: Awaited<ReturnType<typeof createServer>>;
let base: string;
let controllers: TableSessionControllerCommands;
async function startServer() {
  server = await createServer({ databaseUrl: databaseUrl!, schema, onControllerCommandsReady: commands => { controllers = commands; } });
  base = await server.listen({ host: '127.0.0.1', port: 0 });
}
beforeAll(async () => { await administration.query('CREATE SCHEMA "' + schema + '"'); await startServer(); });
afterAll(async () => { await server?.close(); await administration.query('DROP SCHEMA "' + schema + '" CASCADE'); await administration.end(); });
type Table = { id: string; cookie: string; human: string; bot: string; observer: string };
async function table(): Promise<Table> {
  const identity = await fetch(base + '/api/identity'); const cookie = identity.headers.get('set-cookie')!.split(';')[0]!;
  const response = await fetch(base + '/api/table-sessions', { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ requestId: randomUUID(), configuration: { minimumBuyIn: 100, maximumBuyIn: 2000 }, bots: [{ name: 'Bot', playingStrategy: baselinePlayingStrategy }, { name: 'Observer', playingStrategy: baselinePlayingStrategy }] }) });
  const created = await response.json();
  return { id: created.tableSessionId, cookie, human: created.bindings[0].participantId, bot: created.bindings[1].participantId, observer: created.bindings[2].participantId };
}
const response = (t: Table, cookie = t.cookie) => fetch(base + '/api/table-sessions/' + t.id, { headers: { cookie } });
const read = async (t: Table): Promise<ObservableTableSession> => (await (await response(t)).json());
const submit = (t: Table, kind: string, body: unknown) => fetch(base + '/api/table-sessions/' + t.id + '/' + kind, { method: 'POST', headers: { 'content-type': 'application/json', cookie: t.cookie }, body: JSON.stringify(body) });
async function command(t: Table, kind: string, contents: Record<string, unknown> = {}) {
  const before = await read(t);
  const result = await submit(t, kind, { requestId: randomUUID(), expectedPokerRevision: before.pokerRevision, ...contents });
  expect(result.status).toBe(200);
  return result.json();
}
async function liveView(t: Table): Promise<ObservableTableUpdate> {
  const socket = new WebSocket(base.replace('http:', 'ws:') + '/api/table-sessions/' + t.id + '/live', { headers: { cookie: t.cookie } });
  try {
    return await new Promise<ObservableTableUpdate>((resolve, reject) => { socket.once('message', data => resolve(JSON.parse(data.toString()))); socket.once('error', reject); });
  } finally { socket.terminate(); }
}
async function deniedUpgrade(t: Table, cookie = t.cookie) {
  const socket = new WebSocket(base.replace('http:', 'ws:') + '/api/table-sessions/' + t.id + '/live', { headers: { cookie } });
  socket.on('error', () => {});
  try {
    return await new Promise<{ status: number; body: unknown }>((resolve, reject) => {
      socket.once('open', () => reject(new Error('Expected denied upgrade.')));
      socket.once('unexpected-response', (_request, response) => {
        let body = ''; response.on('data', chunk => { body += chunk; });
        response.once('end', () => resolve({ status: response.statusCode!, body: JSON.parse(body) }));
      });
    });
  } finally { socket.terminate(); }
}

test('restart resumes an exact human decision and between-Hand state across management, retaining ownership and safe full history', async () => {
  const t = await table(); const stranger = await table();
  await command(t, 'seat-participant', { participantId: t.human, seat: 1 });
  await command(t, 'seat-participant', { participantId: t.bot, seat: 4 });
  await command(t, 'seat-participant', { participantId: t.observer, seat: 3 });
  await command(t, 'set-sitting-out', { participantId: t.observer, sittingOut: true });
  await command(t, 'start-hand');
  await command(t, 'act', { participantId: t.human, action: { type: 'fold' } });
  await command(t, 'top-up-to', { participantId: t.human, targetStack: 1200 });
  await command(t, 'move-participant', { participantId: t.human, seat: 2 });
  await command(t, 'leave-participant', { participantId: t.bot });
  await command(t, 'seat-participant', { participantId: t.bot, seat: 6, buyIn: 1000 });
  await command(t, 'set-button', { seat: 2 });
  await command(t, 'start-hand');
  await command(t, 'act', { participantId: t.human, action: { type: 'fold' } });
  const completed = await read(t);
  expect(completed).toMatchObject({ pokerRevision: 13, sessionRevision: 13, view: { state: { status: 'completed-hand', handId: 'hand-2', decisionId: null, actorId: null } } });
  expect(completed.view.history.map(h => h.handId)).toEqual(['hand-1', 'hand-2']);
  expect(completed.view.history[0].decisions[0]).toMatchObject({ decisionId: 'hand-1/decision-1', state: { participants: [{ seat: 1, stack: 990 }, { seat: 4, stack: 980 }, { seat: 3, sittingOut: true }], actorId: t.human }, action: { participantId: t.human, action: { type: 'fold' } } });
  expect(completed.view.history[0].decisions[0].state.participants[1]).not.toHaveProperty('holeCards');
  await server.close(); await startServer();
  expect(await read(t)).toEqual(completed);
  expect(await liveView(t)).toEqual({ type: 'table-update', ...completed, presentationEvents: [] });
  expect((await response(t, stranger.cookie)).status).toBe(404);
  expect((await fetch(base + '/api/table-sessions/' + t.id)).status).toBe(401);
  const list = await (await fetch(base + '/api/table-sessions', { headers: { cookie: t.cookie } })).json();
  expect(list.tableSessionIds).toContain(t.id);
  await command(t, 'top-up-to', { participantId: t.human, targetStack: 1500 });
  await command(t, 'set-button', { seat: 2 }); await command(t, 'start-hand');
  const decision = await read(t);
  expect(decision).toMatchObject({ pokerRevision: 16, sessionRevision: 16, view: { state: { handId: 'hand-3', decisionId: 'hand-3/decision-1', actorId: t.human, legalActions: [{ type: 'fold' }, { type: 'call' }] } } });
  expect(JSON.stringify(decision)).not.toMatch(/"(?:seed|deck|burns|commands|events|ownerUserId|userId|schemaVersion|engineVersion)"\s*:/);
  await server.close(); await startServer(); expect(await read(t)).toEqual(decision);
  expect(await liveView(t)).toEqual({ type: 'table-update', ...decision, presentationEvents: [] });
  await command(t, 'act', { participantId: t.human, action: { type: 'call' } });
  const botDecision = await read(t);
  expect(await controllers.submitAction(t.id, { requestId: 'resumed-bot', expectedPokerRevision: botDecision.pokerRevision, participantId: t.bot, action: { type: 'check' } })).toMatchObject({ ok: true, pokerRevision: 18, sessionRevision: 18 });
  expect(await read(t)).toMatchObject({ bindings: decision.bindings, view: { state: { street: 'flop', actorId: t.bot } } });
});

test('a malformed committed suffix is rejected after restart without serving a prefix or exposing diagnostics to another owner', async () => {
  const t = await table(); const stranger = await table();
  await command(t, 'seat-participant', { participantId: t.human, seat: 1 });
  await command(t, 'seat-participant', { participantId: t.bot, seat: 4 }); await command(t, 'start-hand');
  await server.close();
  // External corruption fixture at the persistence boundary, not a verification side channel.
  await administration.query('UPDATE "' + schema + '".table_sessions SET aggregate = jsonb_set(aggregate, \'{pokerRecord,commands}\', (aggregate #> \'{pokerRecord,commands}\') || $1::jsonb) WHERE id = $2', [JSON.stringify([{ type: 'act', participantId: t.bot, action: { type: 'fold' } }]), t.id]);
  await startServer();
  expect((await response(t, stranger.cookie)).status).toBe(404);
  expect((await deniedUpgrade(t, stranger.cookie)).status).toBe(404);
  const failure = await response(t);
  expect(failure.status).toBe(503);
  expect(await failure.json()).toEqual({ ok: false, rejection: { code: 'record-restoration-failed', message: 'The complete committed Table Session could not be restored.' } });
  expect(await deniedUpgrade(t)).toEqual({ status: 503, body: { ok: false, rejection: { code: 'record-restoration-failed', message: 'The complete committed Table Session could not be restored.' } } });
  const mutation = await submit(t, 'act', { requestId: 'no-prefix-action', expectedPokerRevision: 3, participantId: t.human, action: { type: 'fold' } });
  expect(mutation.status).toBe(503);
  expect(await mutation.json()).toMatchObject({ ok: false, rejection: { code: 'record-restoration-failed' } });
  expect((await response(stranger)).status).toBe(200);
});
