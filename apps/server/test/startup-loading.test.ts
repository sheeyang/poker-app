import { afterAll, beforeAll, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { baselinePlayingStrategy, type ActionTimeLimitSeconds, type ObservableTableSession } from '@poker/contracts';
import { createServer } from '../src/server.js';
import type { TableSessionControllerCommands } from '../src/mutations.js';
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

const minute = 60_000;
const loaded = () => [...controllers.loadedTables()].sort();

/** Each cookie is a separate Guest. */
async function guest(name = 'You') {
  const cookie = (await fetch(base + '/api/identity')).headers.get('set-cookie')!.split(';')[0]!;
  await nameGuest(base, cookie, name);
  return cookie;
}
const get = (path: string, cookie: string) => fetch(base + path, { headers: { cookie } });
const post = (path: string, cookie: string, body: unknown) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(body) });

type Table = { id: string; cookie: string; human: string; bot: string };
/** A table of a new Guest against one Bot: a Practice Table unless `mode` says otherwise. */
async function table(options: { actionTimeLimitSeconds?: ActionTimeLimitSeconds | null; mode?: 'online' } = {}): Promise<Table> {
  const cookie = await guest();
  const response = await post('/api/table-sessions', cookie, { requestId: randomUUID(), ...(options.mode ? { mode: options.mode } : {}),
    ...(options.actionTimeLimitSeconds !== undefined ? { options: { actionTimeLimitSeconds: options.actionTimeLimitSeconds } } : {}), bots: [{ name: 'Bot', playingStrategy: baselinePlayingStrategy }] });
  expect(response.status).toBe(201);
  const created = await response.json();
  return { id: created.tableSessionId, cookie, human: created.bindings[0].participantId, bot: created.bindings[1].participantId };
}
const read = async (t: Table): Promise<ObservableTableSession> => (await get('/api/table-sessions/' + t.id, t.cookie)).json();
/** The stored table. */
const stored = async (t: Table) => (await controllers.readPersistedSession(t.id))!;
async function command(t: Table, kind: string, fields: object = {}) {
  const response = await post('/api/table-sessions/' + t.id + '/' + kind, t.cookie, { requestId: randomUUID(), expectedPokerRevision: (await stored(t)).pokerRevision, ...fields });
  expect(response.status).toBe(200);
  return response.json();
}
/** A Hand in progress at a heads-up Practice Table, past its deal: the human, in seat 1, is to act. */
async function practiceHand(actionTimeLimitSeconds: ActionTimeLimitSeconds | null) {
  const t = await table({ actionTimeLimitSeconds });
  await command(t, 'seat-participant', { participantId: t.human, seat: 1 });
  await command(t, 'seat-participant', { participantId: t.bot, seat: 4 });
  await command(t, 'start-hand');
  clock.advance(1500);
  return t;
}
/** An Online Table in play: its owner, connected, and the Bot are dealt a Hand, and the owner is to act. Then everyone disconnects. */
async function onlineHand() {
  const t = await table({ mode: 'online' });
  const live = await connectLive(base, t.cookie, t.id);
  await command(t, 'seat-participant', { participantId: t.human, seat: 1 });
  await command(t, 'seat-participant', { participantId: t.bot, seat: 2 });
  clock.advanceTo((await announcedCountdown(() => read(t))).endsAt);
  await expect.poll(async () => (await read(t)).view.state.handId).toBe('hand-1');
  clock.advance(1500);
  await live.close();
  return t;
}

test('startup loads only the tables with scheduled work: timed Practice Hands in progress and Online Tables in play', async () => {
  const idle = await table();
  const seated = await table({ mode: 'online' });
  await command(seated, 'seat-participant', { participantId: seated.human, seat: 1 });
  const untimed = await practiceHand(null);
  const timed = await practiceHand(60);
  const online = await onlineHand();
  expect((await read(online)).view.state).toMatchObject({ status: 'active-hand', actorId: online.human });
  await restart();
  expect(loaded()).toEqual([timed.id, online.id].sort());
  // Every other table loads the first time a request needs it.
  for (const t of [idle, seated, untimed]) expect((await read(t)).tableSessionId).toBe(t.id);
  expect(loaded()).toEqual([idle.id, seated.id, untimed.id, timed.id, online.id].sort());
});

test('a Bot decision is scheduled work: an untimed Practice Hand loads at startup while its Bot is to act, and not once its human is', async () => {
  const t = await practiceHand(null);
  await command(t, 'act', { participantId: t.human, action: { type: 'call' } });
  await restart();
  expect(loaded()).toContain(t.id);
  expect(await controllers.submitAction(t.id, { requestId: randomUUID(), expectedPokerRevision: (await stored(t)).pokerRevision, participantId: t.bot, action: { type: 'check' } })).toMatchObject({ ok: true });
  // Heads-up, the Bot in the big blind acts first after the flop too.
  expect((await read(t)).view.state).toMatchObject({ street: 'flop', actorId: t.bot });
  clock.advance(1000);
  await restart();
  expect(loaded()).toContain(t.id);
  expect(await controllers.submitAction(t.id, { requestId: randomUUID(), expectedPokerRevision: (await stored(t)).pokerRevision, participantId: t.bot, action: { type: 'check' } })).toMatchObject({ ok: true });
  expect((await read(t)).view.state).toMatchObject({ street: 'flop', actorId: t.human });
  await restart();
  expect(loaded()).not.toContain(t.id);
});

test('after a restart, a timed Practice Hand in progress plays out by its Action Deadline without its human, and is then no longer loaded at startup', async () => {
  const t = await practiceHand(60);
  const waiting = await stored(t);
  await restart();
  expect(loaded()).toContain(t.id);
  clock.advanceTo(waiting.schedule.actionWindow!.deadlineAt! + 1);
  // Preflop the human, on the button, faces the big blind: the Timeout Action folds and the Hand is over.
  await expect.poll(async () => (await stored(t)).pokerRevision).toBe(waiting.pokerRevision + 1);
  expect((await stored(t)).pokerRecord.commands.at(-1)).toEqual({ type: 'act', participantId: t.human, action: { type: 'fold' } });
  await restart();
  expect(loaded()).not.toContain(t.id);
  expect((await read(t)).view.state).toMatchObject({ status: 'completed-hand', handId: 'hand-1' });
});

test('after a restart, an Online Table in play continues: its Action Deadline plays the Timeout Action, the sit-out applies after the Hand, and nothing more is dealt', async () => {
  const t = await onlineHand();
  const waiting = await stored(t);
  await restart();
  expect(loaded()).toContain(t.id);
  clock.advanceTo(waiting.schedule.actionWindow!.deadlineAt! + 1);
  await expect.poll(async () => (await stored(t)).pokerRecord.commands.at(-1)).toEqual({ type: 'act', participantId: t.human, action: { type: 'fold' } });
  clock.advance(10_000);
  await expect.poll(async () => (await stored(t)).pendingChanges).toEqual([]);
  const settled = await read(t);
  expect(settled.view.state).toMatchObject({ status: 'completed-hand', handId: 'hand-1' });
  expect(settled.view.state.participants.find(p => p.participantId === t.human)).toMatchObject({ sittingOut: true });
  expect(settled.schedule.nextHandCountdown).toBeUndefined();
  await restart();
  expect(loaded()).not.toContain(t.id);
});

test('an Action Deadline that expired while the table was unloaded resolves exactly once when it is next loaded', async () => {
  const t = await practiceHand(15);
  const waiting = await stored(t);
  await server.close();
  clock.advanceTo(waiting.schedule.actionWindow!.deadlineAt! + minute);
  await startServer();
  // The restarted server has already settled the expired deadline when it serves its first request.
  expect((await read(t)).pokerRevision).toBe(waiting.pokerRevision + 1);
  for (let again = 0; again < 2; again++) { await restart(); clock.advance(minute); }
  expect((await read(t)).pokerRevision).toBe(waiting.pokerRevision + 1);
  expect((await stored(t)).pokerRecord.commands.filter(command => command.type === 'act')).toEqual([{ type: 'act', participantId: t.human, action: { type: 'fold' } }]);
});
