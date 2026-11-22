import { afterAll, beforeAll, expect, test } from 'vitest';
import { nameGuest } from './fixtures/guest.js';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { baselinePlayingStrategy, type ConcreteAction, type ObservableTableSession, type TableHistory } from '@poker/contracts';
import { createServer } from '../src/server.js';
import type { TableSessionControllerCommands } from '../src/mutations.js';
import { ManualClock } from './fixtures/clock.js';
import { announcedCountdown, connectLive } from './fixtures/online.js';
import { presentedFor } from './fixtures/phases.js';

// Time stands still until a test moves it, so a completion time is exactly the clock's time at the commit.
const clock = new ManualClock();

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('Set TEST_DATABASE_URL to a real PostgreSQL test database.');
const schema = 'test_' + randomUUID().replaceAll('-', '');
const administration = new Pool({ connectionString: databaseUrl });
let server: Awaited<ReturnType<typeof createServer>>;
let base: string;
let controller: TableSessionControllerCommands;
async function start() {
  server = await createServer({ clock, automaticBots: false, databaseUrl: databaseUrl!, schema, onControllerCommandsReady: commands => { controller = commands; } });
  base = await server.listen({ host: '127.0.0.1', port: 0 });
}
beforeAll(async () => { await administration.query('CREATE SCHEMA "' + schema + '"'); await start(); });
afterAll(async () => { await server?.close(); await administration.query('DROP SCHEMA "' + schema + '" CASCADE'); await administration.end(); });

/** Each cookie is a separate Guest. */
async function guest(name?: string) {
  const cookie = (await fetch(base + '/api/identity')).headers.get('set-cookie')!.split(';')[0]!;
  if (name) await nameGuest(base, cookie, name);
  return cookie;
}
const get = (path: string, cookie: string) => fetch(base + path, { headers: { cookie } });
const post = (path: string, cookie: string, body: unknown) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(body) });
type Table = { id: string; owner: string; human: string; bot: string };
async function create(cookie: string, contents: object): Promise<Table> {
  const response = await post('/api/table-sessions', cookie, { requestId: randomUUID(), bots: [{ name: 'Rex', playingStrategy: baselinePlayingStrategy }], ...contents });
  expect(response.status).toBe(201);
  const created = await response.json();
  return { id: created.tableSessionId, owner: cookie, human: created.bindings[0].participantId, bot: created.bindings[1].participantId };
}
const read = async (t: Table, cookie = t.owner): Promise<ObservableTableSession> => (await get('/api/table-sessions/' + t.id, cookie)).json();
const history = (t: Table, cookie = t.owner) => get('/api/table-sessions/' + t.id + '/history', cookie);
const listed = async (t: Table, cookie = t.owner): Promise<TableHistory> => { const response = await history(t, cookie); expect(response.status).toBe(200); return response.json(); };
async function command(t: Table, cookie: string, kind: string, contents: object = {}) {
  const response = await post('/api/table-sessions/' + t.id + '/' + kind, cookie, { requestId: randomUUID(), expectedPokerRevision: (await read(t, cookie)).pokerRevision, ...contents });
  expect(response.status).toBe(200);
}
const botAct = async (t: Table, action: ConcreteAction) => expect(await controller.submitAction(t.id, { requestId: randomUUID(), expectedPokerRevision: (await read(t)).pokerRevision, participantId: t.bot, action })).toMatchObject({ ok: true });
/** A Practice Table with the human on the button and the Bot in the big blind. */
async function practice(): Promise<Table> {
  const t = await create(await guest('Ann'), {});
  await command(t, t.owner, 'seat-participant', { participantId: t.human, seat: 1 });
  await command(t, t.owner, 'seat-participant', { participantId: t.bot, seat: 4 });
  return t;
}
/** Deals and plays the Hand: the human calls, then both check down to a showdown. */
async function showdown(t: Table) {
  clock.settle(); await command(t, t.owner, 'start-hand'); clock.settle();
  await command(t, t.owner, 'act', { participantId: t.human, action: { type: 'call' } }); clock.settle();
  await botAct(t, { type: 'check' }); clock.settle();
  for (let street = 0; street < 3; street++) {
    await botAct(t, { type: 'check' }); clock.settle();
    await command(t, t.owner, 'act', { participantId: t.human, action: { type: 'check' } }); clock.settle();
  }
}
/** Deals and plays the Hand: the first to act folds. */
async function folded(t: Table) {
  clock.settle(); await command(t, t.owner, 'start-hand'); clock.settle();
  const actor = (await read(t)).view.state.actorId!;
  if (actor === t.human) await command(t, t.owner, 'act', { participantId: t.human, action: { type: 'fold' } });
  else await botAct(t, { type: 'fold' });
}

test('a Participant reads every completed Hand of a Practice Table with its number, completion time, who was dealt in, the final board and the result, and sees only the cards the table showed them', async () => {
  const t = await practice();
  expect((await listed(t)).hands).toEqual([]);
  const first = clock.now();
  await showdown(t);
  const afterFirst = clock.now();
  await folded(t);
  const { hands } = await listed(t);
  expect(hands.map(hand => [hand.handId, hand.handNumber])).toEqual([['hand-1', 1], ['hand-2', 2]]);
  const [one, two] = hands as [TableHistory['hands'][number], TableHistory['hands'][number]];
  // A completion time is the server time of the commit that completed the Hand.
  expect(one.completedAt).toBeGreaterThanOrEqual(first);
  expect(one.completedAt).toBeLessThanOrEqual(afterFirst);
  expect(two.completedAt).toBeGreaterThanOrEqual(one.completedAt!);
  // Hand 1 went to a showdown: both players are dealt in, their cards revealed, the board complete.
  expect(one).toMatchObject({ viewerDealtIn: true, showdown: true, dealtIn: [{ participantId: t.human, name: 'Ann', holeCards: [expect.any(String), expect.any(String)] }, { participantId: t.bot, name: 'Rex', holeCards: [expect.any(String), expect.any(String)] }] });
  expect(one.board).toHaveLength(5);
  expect(one.payouts.reduce((total, payout) => total + payout.amount, 0)).toBe(40);
  // Hand 2 ended with a Fold: the viewer sees only their own cards, and no board was dealt.
  const view = await read(t);
  expect(two).toMatchObject({ viewerDealtIn: true, showdown: false, board: [] });
  expect(two.dealtIn.map(player => [player.participantId, !!player.holeCards])).toEqual([[t.human, true], [t.bot, false]]);
  expect(two.dealtIn[0]!.holeCards).toEqual(view.view.history[1]!.result!.participants.find(p => p.participantId === t.human)!.holeCards);
  expect(JSON.stringify(await listed(t))).not.toMatch(/"(?:seed|deck|burns|commands|userId|ownerUserId)"\s*:/);
});

test('Hands completed before completion times were recorded carry none, and Hands completed after carry one', async () => {
  const t = await practice();
  await showdown(t);
  await server.close();
  await administration.query('UPDATE "' + schema + '".table_sessions SET aggregate = aggregate - \'handCompletedAt\' WHERE id = $1', [t.id]);
  await start();
  clock.advance(1000);
  expect((await listed(t)).hands.map(hand => 'completedAt' in hand)).toEqual([false]);
  await folded(t);
  const { hands } = await listed(t);
  expect(hands.map(hand => hand.handNumber)).toEqual([1, 2]);
  expect(hands[0]).not.toHaveProperty('completedAt');
  expect(hands[1]!.completedAt).toBe(clock.now());
});

test('at an Online Table every Participant reads the same table-wide Hand numbers, a late joiner included, and a Guest who was never a Participant is refused', async () => {
  const ann = await guest('Ann');
  const t = await create(ann, { mode: 'online', configuration: { seatCount: 3, smallBlind: 10, bigBlind: 20, minimumBuyIn: 200, defaultBuyIn: 500, maximumBuyIn: 1000 } });
  await command(t, ann, 'seat-participant', { participantId: t.bot, seat: 1 });
  await command(t, ann, 'seat-participant', { participantId: t.human, seat: 2, buyIn: 300 });
  await connectLive(base, ann, t.id);
  clock.advanceTo((await announcedCountdown(() => read(t))).endsAt);
  await expect.poll(async () => (await read(t)).view.state.handId).toBe('hand-1');
  clock.advance(presentedFor('deal', 'online'));
  const actor = (await read(t)).view.state.actorId!;
  expect(actor).toBe(t.bot);
  await botAct(t, { type: 'fold' });
  const completed = clock.now();
  const ben = await guest('Ben');
  const joined = await (await post('/api/table-sessions/' + t.id + '/join-table', ben, { requestId: randomUUID() })).json();
  const owners = await listed(t), late = await listed(t, ben);
  expect(owners.hands).toMatchObject([{ handId: 'hand-1', handNumber: 1, completedAt: completed, viewerDealtIn: true }]);
  // Ben joined after the Hand: he reads it, was not dealt in, and sees nobody's cards.
  expect(late.hands).toMatchObject([{ handId: 'hand-1', handNumber: 1, completedAt: completed, viewerDealtIn: false }]);
  expect(late.viewerParticipantId).toBe(joined.participantId);
  expect(late.hands.some(hand => hand.dealtIn.some(player => player.holeCards))).toBe(false);
  // A Guest who never joined learns nothing, not even that the table exists; nor does a stranger to the service.
  const cy = await guest('Cy');
  for (const response of [await history(t, cy), await get('/api/table-sessions/' + randomUUID() + '/history', cy), await get('/api/table-sessions/nonsense/history', cy)]) {
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ ok: false, rejection: { code: 'not-found' } });
  }
  expect((await get('/api/table-sessions/' + t.id + '/history', '')).status).toBe(401);
});

test('reading a table\'s history does not load the table', async () => {
  const t = await practice();
  await folded(t);
  await server.close(); await start();
  expect(controller.loadedTables()).not.toContain(t.id);
  expect((await listed(t)).hands).toHaveLength(1);
  expect(controller.loadedTables()).not.toContain(t.id);
});
