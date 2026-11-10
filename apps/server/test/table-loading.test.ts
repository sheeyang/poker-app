import { afterAll, beforeAll, expect, onTestFinished, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import WebSocket from 'ws';
import { baselinePlayingStrategy, type ActionTimeLimitSeconds, type ObservableTableSession, type ServerLiveMessage } from '@poker/contracts';
import { createStrategy } from '@poker/strategies';
import { createServer } from '../src/server.js';
import type { TableSessionControllerCommands } from '../src/mutations.js';
import { nameGuest } from './fixtures/guest.js';
import { ManualClock } from './fixtures/clock.js';
import { connectLive, type LiveConnection } from './fixtures/online.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('Set TEST_DATABASE_URL to a real PostgreSQL test database.');
const schema = 'test_' + randomUUID().replaceAll('-', '');
const administration = new Pool({ connectionString: databaseUrl });
const clock = new ManualClock();
let server: Awaited<ReturnType<typeof createServer>>;
let base: string;
let controllers: TableSessionControllerCommands;
/** While set, every Reference Strategy evaluation waits for it: analysis results arrive when a test releases them. */
let analysisGate: ReturnType<typeof Promise.withResolvers<void>> | undefined;
let evaluationsStarted = 0;
async function startServer() {
  server = await createServer({ clock, automaticBots: false, databaseUrl: databaseUrl!, schema, onControllerCommandsReady: commands => { controllers = commands; },
    strategyFactory: descriptor => {
      const strategy = createStrategy(descriptor);
      return { actionSelector: strategy.actionSelector, policy: {
        checkCompatibility: view => strategy.policy.checkCompatibility(view),
        evaluate: async (view, options) => { evaluationsStarted++; await analysisGate?.promise; return strategy.policy.evaluate(view, options); },
      } };
    } });
  base = await server.listen({ host: '127.0.0.1', port: 0 });
}
beforeAll(async () => { await administration.query('CREATE SCHEMA "' + schema + '"'); await startServer(); });
afterAll(async () => { await server?.close(); await administration.query('DROP SCHEMA "' + schema + '" CASCADE'); await administration.end(); });

const minute = 60_000;
const loaded = (id: string) => controllers.loadedTables().includes(id);

/** Each cookie is a separate Guest. */
async function guest(name = 'You') {
  const cookie = (await fetch(base + '/api/identity')).headers.get('set-cookie')!.split(';')[0]!;
  await nameGuest(base, cookie, name);
  return cookie;
}
const get = (path: string, cookie: string) => fetch(base + path, { headers: { cookie } });
const post = (path: string, cookie: string, body: unknown) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(body) });

type Table = { id: string; cookie: string; human: string; bot: string };
/** A heads-up Practice Table against one Bot. Creating it does not load it. */
async function practiceTable(actionTimeLimitSeconds: ActionTimeLimitSeconds | null = null): Promise<Table> {
  const cookie = await guest();
  const response = await post('/api/table-sessions', cookie, { requestId: randomUUID(), options: { actionTimeLimitSeconds }, bots: [{ name: 'Bot', playingStrategy: baselinePlayingStrategy }] });
  expect(response.status).toBe(201);
  const created = await response.json();
  return { id: created.tableSessionId, cookie, human: created.bindings[0].participantId, bot: created.bindings[1].participantId };
}
const read = async (t: Table): Promise<ObservableTableSession> => (await get('/api/table-sessions/' + t.id, t.cookie)).json();
/** The stored table, read without loading it. */
const stored = async (t: Table) => (await controllers.readPersistedSession(t.id))!;
async function command(t: Table, kind: string, fields: object = {}) {
  const response = await post('/api/table-sessions/' + t.id + '/' + kind, t.cookie, { requestId: randomUUID(), expectedPokerRevision: (await stored(t)).pokerRevision, ...fields });
  expect(response.status).toBe(200);
  return response.json();
}
/** A Hand in progress at a heads-up Practice Table: the human, in seat 1, acts first. */
async function handInProgress(actionTimeLimitSeconds: ActionTimeLimitSeconds | null) {
  const t = await practiceTable(actionTimeLimitSeconds);
  await command(t, 'seat-participant', { participantId: t.human, seat: 1 });
  await command(t, 'seat-participant', { participantId: t.bot, seat: 4 });
  await command(t, 'start-hand');
  return t;
}

/** Ends a live subscription and waits until the server confirms it has ended. */
async function unsubscribe(live: LiveConnection, tableSessionId: string) {
  const requestId = randomUUID();
  live.socket.send(JSON.stringify({ type: 'unsubscribe-table', requestId, tableSessionId }));
  await expect.poll(() => live.messages.find(message => message.type === 'table-subscription-result' && message.requestId === requestId)).toMatchObject({ status: 'unsubscribed' });
}
/** The server's answer to a live subscription request from `cookie`. The connection ends with the test. */
async function subscription(cookie: string, tableSessionId: string) {
  const socket = new WebSocket(base.replace('http:', 'ws:') + '/api/live', { headers: { cookie } });
  onTestFinished(() => { socket.terminate(); });
  const messages: ServerLiveMessage[] = [];
  socket.on('message', data => messages.push(JSON.parse(data.toString())));
  await expect.poll(() => messages[0]).toEqual({ type: 'user-channel-ready' });
  socket.send(JSON.stringify({ type: 'subscribe-table', requestId: 'attempt', tableSessionId }));
  let result: ServerLiveMessage | undefined;
  await expect.poll(() => (result = messages.find(message => message.type === 'table-subscription-result'))).toBeDefined();
  return result;
}
/** Holds every analysis result until the returned function releases them, and at the latest when the test ends. */
function holdAnalysis() {
  const gate = Promise.withResolvers<void>();
  analysisGate = gate;
  const release = () => { gate.resolve(); if (analysisGate === gate) analysisGate = undefined; };
  onTestFinished(release);
  return release;
}
/** The decision scores stored for the table's analysis, read without loading it. */
const storedScores = async (t: Table) => Number((await administration.query('SELECT count(*) FROM "' + schema + '".analysis_scores WHERE table_session_id = $1', [t.id])).rows[0].count);
/** Gives the server a full round trip to finish anything already under way, such as an unload that is due. */
const roundTrip = async () => { await fetch(base + '/api/identity'); };

test('an idle Practice Table is not in memory until its owner opens it', async () => {
  const t = await practiceTable();
  expect(loaded(t.id)).toBe(false);
  expect((await read(t)).tableSessionId).toBe(t.id);
  expect(loaded(t.id)).toBe(true);
});

test('the saved-tables list is built from stored rows: it loads no table', async () => {
  const t = await practiceTable();
  const ann = await guest('Ann');
  const online = (await (await post('/api/table-sessions', ann, { requestId: randomUUID(), mode: 'online' })).json()).tableSessionId as string;
  clock.advance(minute);
  await expect.poll(() => loaded(online)).toBe(false);
  expect(loaded(t.id)).toBe(false);
  const listed = await (await get('/api/table-sessions', t.cookie)).json();
  expect(listed.tables).toEqual([{ tableSessionId: t.id, mode: 'practice', seatCount: 6, stakes: { smallBlind: 10, bigBlind: 20, ante: 0 } }]);
  expect((await (await get('/api/table-sessions', ann)).json()).tables).toEqual([{ tableSessionId: online, mode: 'online', seatCount: 6, stakes: { smallBlind: 10, bigBlind: 20, ante: 0 } }]);
  expect(loaded(t.id)).toBe(false);
  expect(loaded(online)).toBe(false);
});

test('a table unloads one minute after its last subscriber leaves, and reloads as it was', async () => {
  const t = await practiceTable();
  const tab = await connectLive(base, t.cookie, t.id), other = await connectLive(base, t.cookie, t.id);
  const before = await read(t);
  // A subscription holds the table however long it lasts.
  clock.advance(10 * minute); await roundTrip();
  expect(loaded(t.id)).toBe(true);
  await unsubscribe(tab, t.id);
  clock.advance(10 * minute); await roundTrip();
  expect(loaded(t.id)).toBe(true);
  // Once the last one has gone, the table stays for one more minute.
  await unsubscribe(other, t.id);
  clock.advance(minute - 1); await roundTrip();
  expect(loaded(t.id)).toBe(true);
  clock.advance(1);
  await expect.poll(() => loaded(t.id)).toBe(false);
  // Opening it again loads it from its record, exactly as it was left.
  const after = await read(t);
  expect(loaded(t.id)).toBe(true);
  expect(after).toEqual({ ...before, serverTime: clock.now() });
});

test('a request within that minute keeps the table loaded for another minute from when it was handled', async () => {
  const t = await practiceTable();
  const tab = await connectLive(base, t.cookie, t.id);
  await unsubscribe(tab, t.id);
  clock.advance(minute / 2);
  expect((await read(t)).tableSessionId).toBe(t.id);
  // The minute after the subscriber left has passed, but not the minute after the read.
  clock.advance(minute / 2); await roundTrip();
  expect(loaded(t.id)).toBe(true);
  clock.advance(minute / 2 - 1); await roundTrip();
  expect(loaded(t.id)).toBe(true);
  clock.advance(1);
  await expect.poll(() => loaded(t.id)).toBe(false);
});

test('a request that fails still releases the table, which unloads a minute later', async () => {
  const t = await practiceTable();
  const refused = await post('/api/table-sessions/' + t.id + '/seat-participant', t.cookie, { requestId: randomUUID(), expectedPokerRevision: 7, participantId: t.human, seat: 1 });
  expect(refused.status).toBe(409);
  expect(loaded(t.id)).toBe(true);
  clock.advance(minute);
  await expect.poll(() => loaded(t.id)).toBe(false);
});

test('a request from anyone not at a table never loads it; a join to an Online Table does', async () => {
  const t = await practiceTable();
  const stranger = await guest('Stranger');
  const at = (path: string) => '/api/table-sessions/' + t.id + path;
  expect((await get(at(''), stranger)).status).toBe(404);
  expect((await post(at('/seat-participant'), stranger, { requestId: randomUUID(), expectedPokerRevision: 0, participantId: t.human, seat: 1 })).status).toBe(404);
  expect((await post(at('/set-trainer-configuration'), stranger, { requestId: randomUUID(), expectedSessionRevision: 0, trainerConfiguration: {} })).status).toBe(404);
  expect((await post(at('/analysis'), stranger, { decisionId: 'hand-1/decision-1' })).status).toBe(404);
  expect((await post(at('/session-summaries'), stranger, {})).status).toBe(404);
  expect(await subscription(stranger, t.id)).toMatchObject({ status: 'rejected', code: 'not-found' });
  expect(loaded(t.id)).toBe(false);

  // The Join Link at a Practice Table's ID is not found, and loads nothing, for a stranger as for anyone.
  expect((await get(at('/join-preview'), stranger)).status).toBe(404);
  expect((await post(at('/join-table'), stranger, { requestId: randomUUID() })).status).toBe(404);
  expect(loaded(t.id)).toBe(false);

  // A Join Link's preview is read without loading the table; joining loads it.
  const ann = await guest('Ann');
  const created = await (await post('/api/table-sessions', ann, { requestId: randomUUID(), mode: 'online' })).json();
  const online = created.tableSessionId as string;
  clock.advance(minute);
  await expect.poll(() => loaded(online)).toBe(false);
  const ben = await guest('Ben');
  const preview = await get('/api/table-sessions/' + online + '/join-preview', ben);
  expect(await preview.json()).toMatchObject({ ok: true, ownerName: 'Ann', configuration: { seatCount: 6 }, placesTaken: 1, alreadyJoined: false });
  expect((await get('/api/table-sessions/' + online, ben)).status).toBe(404);
  expect(loaded(online)).toBe(false);
  expect((await post('/api/table-sessions/' + online + '/join-table', ben, { requestId: randomUUID() })).status).toBe(200);
  expect(loaded(online)).toBe(true);
});

test('an untimed Practice Hand holds nothing while it waits for its human: the table unloads, and reloads mid-Hand as it was', async () => {
  const t = await handInProgress(null);
  // Its Action Window opens as the deal is presented; after that nothing is scheduled.
  clock.advance(1500); await roundTrip();
  const waiting = await read(t);
  expect(waiting.view.state).toMatchObject({ status: 'active-hand', actorId: t.human });
  clock.advance(minute);
  await expect.poll(() => loaded(t.id)).toBe(false);
  expect(await read(t)).toEqual({ ...waiting, serverTime: clock.now() });
});

test('scheduled work holds a table with nobody connected: a timed Practice Hand plays out by its Action Deadline, then the table unloads', async () => {
  const t = await handInProgress(60);
  clock.advance(1500); await roundTrip();
  const waiting = await stored(t);
  // A minute after the last request, the Action Deadline, a moment away, keeps the table in memory.
  clock.advance(minute); await roundTrip();
  expect(loaded(t.id)).toBe(true);
  clock.advanceTo(waiting.schedule.actionWindow!.deadlineAt! + 1);
  await expect.poll(async () => (await stored(t)).pokerRevision).toBe(waiting.pokerRevision + 1);
  expect((await stored(t)).pokerRecord.commands.at(-1)).toEqual({ type: 'act', participantId: t.human, action: { type: 'fold' } });
  // Once the payout has been shown nothing more is scheduled, and the table unloads a minute later.
  clock.advance(2000); await roundTrip();
  clock.advance(minute);
  await expect.poll(() => loaded(t.id)).toBe(false);
});

test('After-Hand Requests at an untimed Practice Table hold nothing: only its human advances the Hand, so the table unloads and they wait in its record', async () => {
  const t = await handInProgress(null);
  clock.advance(1500); await roundTrip();
  expect(await command(t, 'stand-up-participant', { participantId: t.human })).toMatchObject({ ok: true, afterHand: true });
  clock.advance(minute);
  await expect.poll(() => loaded(t.id)).toBe(false);
  expect((await stored(t)).pendingChanges).toHaveLength(1);
  await command(t, 'act', { participantId: t.human, action: { type: 'fold' } });
  // The payout is shown, then the Stand Up is applied, and nothing holds the table any longer.
  clock.advance(2000);
  await expect.poll(async () => (await stored(t)).pendingChanges).toEqual([]);
  await roundTrip();
  clock.advance(minute);
  await expect.poll(() => loaded(t.id)).toBe(false);
});

test('after a restart, an idle table is not loaded, and loads when its owner opens it', async () => {
  const t = await practiceTable();
  await command(t, 'seat-participant', { participantId: t.human, seat: 1 });
  await server.close(); await startServer();
  expect(loaded(t.id)).toBe(false);
  expect((await read(t)).view.state.participants.find(p => p.participantId === t.human)).toMatchObject({ seat: 1 });
  expect(loaded(t.id)).toBe(true);
});

test('automatic analysis results that arrive after the last subscriber leaves do not keep the table loaded any longer', async () => {
  const release = holdAnalysis();
  const t = await handInProgress(null);
  const live = await connectLive(base, t.cookie, t.id);
  clock.advance(1500); await roundTrip();
  const started = evaluationsStarted;
  await command(t, 'act', { participantId: t.human, action: { type: 'fold' } });
  await expect.poll(() => evaluationsStarted).toBeGreaterThan(started);
  // The payout is shown; after it nothing is scheduled.
  clock.advance(2000); await roundTrip();
  await unsubscribe(live, t.id);
  clock.advance(minute / 2); await roundTrip();
  // The results arrive, and are delivered to the loaded table's human, without restarting its minute.
  release();
  await expect.poll(() => live.messages.filter(message => message.type === 'analysis-update' && message.status === 'complete').length).toBe(2);
  expect(await storedScores(t)).toBe(1);
  clock.advance(minute / 2);
  await expect.poll(() => loaded(t.id)).toBe(false);
});

test('automatic analysis results that arrive after the table has unloaded are kept without loading it again', async () => {
  const release = holdAnalysis();
  const t = await handInProgress(null);
  clock.advance(1500); await roundTrip();
  const started = evaluationsStarted;
  await command(t, 'act', { participantId: t.human, action: { type: 'fold' } });
  await expect.poll(() => evaluationsStarted).toBeGreaterThan(started);
  clock.advance(2000); await roundTrip();
  clock.advance(minute);
  await expect.poll(() => loaded(t.id)).toBe(false);
  release();
  await expect.poll(() => storedScores(t)).toBe(1);
  await roundTrip();
  expect(loaded(t.id)).toBe(false);
  // Opening the table again finds the analysis where it was kept.
  const analysis = await (await post('/api/table-sessions/' + t.id + '/analysis', t.cookie, { decisionId: 'hand-1/decision-1' })).json();
  expect(analysis).toMatchObject({ status: 'complete', scoredDecision: { acceptedAction: { type: 'fold' } } });
});
