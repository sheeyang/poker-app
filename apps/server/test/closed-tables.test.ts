import { afterAll, beforeAll, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import WebSocket from 'ws';
import { baselinePlayingStrategy, type ObservableTableSession, type ServerLiveMessage } from '@poker/contracts';
import { createServer } from '../src/server.js';
import type { TableSessionControllerCommands } from '../src/mutations.js';
import { idleTableCloseMs, idleTableSweepMs } from '../src/closing.js';
import { nameGuest } from './fixtures/guest.js';
import { ManualClock } from './fixtures/clock.js';
import { announcedCountdown, connectLive } from './fixtures/online.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('Set TEST_DATABASE_URL to a real PostgreSQL test database.');
const schema = 'test_' + randomUUID().replaceAll('-', '');
const administration = new Pool({ connectionString: databaseUrl });
const clock = new ManualClock();
let server: Awaited<ReturnType<typeof createServer>>;
let base: string;
let controllers: TableSessionControllerCommands;
async function startServer() {
  server = await createServer({ clock, automaticBots: false, databaseUrl: databaseUrl!, schema, onControllerCommandsReady: commands => { controllers = commands; } });
  base = await server.listen({ host: '127.0.0.1', port: 0 });
}
const restart = async () => { await server.close(); await startServer(); };
beforeAll(async () => { await administration.query('CREATE SCHEMA "' + schema + '"'); await startServer(); });
afterAll(async () => { await server?.close(); await administration.query('DROP SCHEMA "' + schema + '" CASCADE'); await administration.end(); });

const minute = 60_000, hour = 60 * minute;
const loaded = (id: string) => controllers.loadedTables().includes(id);
/** Long enough without a committed change for the sweep to have judged the table idle. */
const pastIdleLimit = () => clock.advance(idleTableCloseMs + idleTableSweepMs);

/** Each cookie is a separate Guest. */
async function guest(name: string) {
  const cookie = (await fetch(base + '/api/identity')).headers.get('set-cookie')!.split(';')[0]!;
  await nameGuest(base, cookie, name);
  return cookie;
}
const get = (path: string, cookie: string) => fetch(base + path, { headers: { cookie } });
const post = (path: string, cookie: string, body: unknown) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(body) });
const create = async (cookie: string, body: object = {}) => {
  const response = await post('/api/table-sessions', cookie, { requestId: randomUUID(), ...body });
  expect(response.status).toBe(201);
  return response.json();
};
const createOnline = async (cookie: string) => (await create(cookie, { mode: 'online' })).tableSessionId as string;
const join = (cookie: string, id: string) => post('/api/table-sessions/' + id + '/join-table', cookie, { requestId: randomUUID() });
const preview = (cookie: string, id: string) => get('/api/table-sessions/' + id + '/join-preview', cookie);
const view = async (cookie: string, id: string): Promise<ObservableTableSession> => (await get('/api/table-sessions/' + id, cookie)).json();
const saved = async (cookie: string) => (await (await get('/api/table-sessions', cookie)).json()).tables;
const outcome = async (response: Response) => ({ status: response.status, body: await response.json() });
const closedAnswer = { status: 410, body: { ok: false, rejection: { code: 'table-closed', message: expect.stringContaining('closed') } } };
/** The server's answer to a new live subscription request from `cookie`. */
async function subscription(cookie: string, tableSessionId: string) {
  const socket = new WebSocket(base.replace('http:', 'ws:') + '/api/live', { headers: { cookie } });
  const messages: ServerLiveMessage[] = [];
  socket.on('message', data => messages.push(JSON.parse(data.toString())));
  try {
    await expect.poll(() => messages[0]).toEqual({ type: 'user-channel-ready' });
    socket.send(JSON.stringify({ type: 'subscribe-table', requestId: 'attempt', tableSessionId }));
    let result: ServerLiveMessage | undefined;
    await expect.poll(() => (result = messages.find(message => message.type === 'table-subscription-result'))).toBeDefined();
    return result;
  } finally { socket.terminate(); }
}

test('an Online Table with no committed change for 24 hours closes: nobody can open, join or follow it, and its Guests are free', async () => {
  const ann = await guest('Ann'), ben = await guest('Ben'), cat = await guest('Cat');
  const id = await createOnline(ann);
  expect((await join(ben, id)).status).toBe(200);
  // Nothing needs the table, so it leaves memory; closing it later does not load it.
  clock.advance(minute);
  await expect.poll(() => loaded(id)).toBe(false);

  // Short of 24 hours since the last committed change (Ben's join), it stays open.
  clock.advance(idleTableCloseMs - 2 * minute);
  expect((await preview(cat, id)).status).toBe(200);

  clock.advance(minute + idleTableSweepMs);
  await expect.poll(async () => (await preview(cat, id)).status).toBe(410);
  expect(loaded(id)).toBe(false);
  for (const cookie of [ann, ben, cat]) {
    expect(await outcome(await preview(cookie, id))).toEqual(closedAnswer);
    expect(await outcome(await join(cookie, id))).toEqual(closedAnswer);
  }
  // Its memberships have ended: to the people who were at it, it is as unavailable as to anyone.
  for (const cookie of [ann, ben]) {
    expect((await get('/api/table-sessions/' + id, cookie)).status).toBe(404);
    expect(await subscription(cookie, id)).toMatchObject({ status: 'rejected', code: 'not-found' });
  }
  expect(loaded(id)).toBe(false);
  // It stays in their lists, marked closed, until replay arrives.
  for (const cookie of [ann, ben]) expect(await saved(cookie)).toEqual([{ tableSessionId: id, mode: 'online', left: true, closed: true, seatCount: 6, stakes: { smallBlind: 10, bigBlind: 20, ante: 0 } }]);

  // It was their Current Table; it no longer holds them.
  const anns = await createOnline(ann);
  expect((await join(ben, anns)).status).toBe(200);
});

test('a loaded Online Table closes through its own turn: everyone following it is told, and it leaves memory', async () => {
  const ann = await guest('Ann'), ben = await guest('Ben');
  const id = await createOnline(ann);
  expect((await join(ben, id)).status).toBe(200);
  // Both watch, unseated: their connections hold the table in memory, and nothing is dealt or committed.
  const anns = await connectLive(base, ann, id), bens = await connectLive(base, ben, id);
  clock.advance(idleTableCloseMs - minute);
  expect(loaded(id)).toBe(true);
  expect((await view(ann, id)).tableSessionId).toBe(id);

  clock.advance(minute + idleTableSweepMs);
  for (const live of [anns, bens]) await expect.poll(() => live.messages.at(-1)).toEqual({ type: 'table-membership-ended', tableSessionId: id, closed: true });
  await expect.poll(() => loaded(id)).toBe(false);
  expect((await get('/api/table-sessions/' + id, ann)).status).toBe(404);
  expect(await outcome(await join(ann, id))).toEqual(closedAnswer);
  expect(loaded(id)).toBe(false);
  // Closed for good: a restart does not reopen or load it.
  await restart();
  expect(loaded(id)).toBe(false);
  expect(await outcome(await preview(ben, id))).toEqual(closedAnswer);
});

test('every committed change starts the 24 hours again', async () => {
  const ann = await guest('Ann'), ben = await guest('Ben');
  const id = await createOnline(ann);
  clock.advance(idleTableCloseMs - hour);
  expect((await post('/api/table-sessions/' + id + '/set-table-password', ann, { requestId: randomUUID(), tablePassword: 'secret' })).status).toBe(200);
  clock.advance(2 * hour + idleTableSweepMs);
  await fetch(base + '/api/identity');
  expect(await outcome(await preview(ben, id))).toEqual({ status: 200, body: expect.objectContaining({ ok: true, passwordRequired: true }) });
  clock.advance(idleTableCloseMs);
  await expect.poll(async () => (await preview(ben, id)).status).toBe(410);
});

test('a Practice Table never closes, however long it sits idle', async () => {
  const sam = await guest('Sam');
  const { tableSessionId: id } = await create(sam);
  pastIdleLimit(); pastIdleLimit();
  await fetch(base + '/api/identity');
  expect((await view(sam, id)).tableSessionId).toBe(id);
  expect(await saved(sam)).toEqual([expect.not.objectContaining({ closed: true })]);
  pastIdleLimit();
  expect((await view(sam, id)).tableSessionId).toBe(id);
});

test('closing clears load at startup: an Online Table left waiting on its Bot no longer loads after a restart', async () => {
  const ann = await guest('Ann');
  const created = await create(ann, { mode: 'online', bots: [{ name: 'Bot', playingStrategy: baselinePlayingStrategy }] });
  const id = created.tableSessionId as string, human = created.bindings[0].participantId as string, bot = created.bindings[1].participantId as string;
  const stored = async () => (await controllers.readPersistedSession(id))!;
  const command = async (kind: string, fields: object) => expect((await post('/api/table-sessions/' + id + '/' + kind, ann, { requestId: randomUUID(), expectedPokerRevision: (await stored()).pokerRevision, ...fields })).status).toBe(200);
  const live = await connectLive(base, ann, id);
  await command('seat-participant', { participantId: human, seat: 1 });
  await command('seat-participant', { participantId: bot, seat: 2 });
  clock.advanceTo((await announcedCountdown(() => view(ann, id))).endsAt);
  await expect.poll(async () => (await view(ann, id)).view.state.handId).toBe('hand-1');
  clock.advance(1500);
  // Ann calls from the button; the Bot, whose decisions this server does not make, is to act, and nothing else happens.
  await command('act', { participantId: human, action: { type: 'call' } });
  await live.close();
  expect((await view(ann, id)).view.state.actorId).toBe(bot);
  await restart();
  expect(loaded(id)).toBe(true);
  clock.advance(minute);
  await expect.poll(() => loaded(id)).toBe(false);

  pastIdleLimit();
  await expect.poll(async () => (await preview(ann, id)).status).toBe(410);
  await restart();
  expect(loaded(id)).toBe(false);
});
