import { afterAll, beforeAll, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { baselinePlayingStrategy, type ObservableTableSession } from '@poker/contracts';
import { createServer } from '../src/server.js';
import { nameGuest } from './fixtures/guest.js';
import { ManualClock } from './fixtures/clock.js';
import { announcedCountdown, connectLive } from './fixtures/online.js';

// Ownership of an Online Table passes when its owner leaves (ADR-0034). Online Tables always have Action Deadlines,
// so time moves only when a test moves it.
const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('Set TEST_DATABASE_URL to a real PostgreSQL test database.');
const schema = 'test_' + randomUUID().replaceAll('-', '');
const administration = new Pool({ connectionString: databaseUrl });
const clock = new ManualClock();
let server: Awaited<ReturnType<typeof createServer>>;
let base: string;
async function startServer() {
  server = await createServer({ clock, automaticBots: false, databaseUrl: databaseUrl!, schema });
  base = await server.listen({ host: '127.0.0.1', port: 0 });
}
beforeAll(async () => { await administration.query('CREATE SCHEMA "' + schema + '"'); await startServer(); });
afterAll(async () => { await server?.close(); await administration.query('DROP SCHEMA "' + schema + '" CASCADE'); await administration.end(); });

/** Each cookie is a separate Guest. */
async function guest(name: string) {
  const cookie = (await fetch(base + '/api/identity')).headers.get('set-cookie')!.split(';')[0]!;
  await nameGuest(base, cookie, name);
  return cookie;
}
const get = (path: string, cookie: string) => fetch(base + path, { headers: { cookie } });
const post = (path: string, cookie: string, body: unknown) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(body) });
const refusal = async (response: Response) => ({ status: response.status, code: (await response.json()).rejection?.code });

/** An Online Table created by `owner`, with the given Bots. */
async function online(owner: string, bots: string[] = []) {
  const response = await post('/api/table-sessions', owner, { requestId: randomUUID(), mode: 'online', bots: bots.map(name => ({ name, playingStrategy: baselinePlayingStrategy })) });
  expect(response.status).toBe(201);
  const created = await response.json();
  const id = created.tableSessionId as string;
  const view = async (cookie: string): Promise<ObservableTableSession> => (await get('/api/table-sessions/' + id, cookie)).json();
  const joinWith = (cookie: string, tablePassword?: string) => post('/api/table-sessions/' + id + '/join-table', cookie, { requestId: randomUUID(), ...(tablePassword ? { tablePassword } : {}) });
  /** Joins and returns the Guest's Participant. */
  const join = async (cookie: string) => {
    const joined = await joinWith(cookie);
    expect(joined.status).toBe(200);
    return (await joined.json()).participantId as string;
  };
  const as = async (cookie: string, kind: string, fields: object = {}) => post('/api/table-sessions/' + id + '/' + kind, cookie, { requestId: randomUUID(), expectedPokerRevision: (await view(cookie)).pokerRevision, ...fields });
  const leave = async (cookie: string, participantId: string) => as(cookie, 'leave-table', { participantId });
  const botIds = (created.bindings as { participantId: string }[]).slice(1).map(binding => binding.participantId);
  return { id, ownerId: created.bindings[0].participantId as string, botIds, view, join, joinWith, as, leave };
}

test('when the owner leaves, the earliest-joined human still at the table becomes owner, a watcher included, and everyone sees it', async () => {
  const ann = await guest('Ann'), ben = await guest('Ben'), cat = await guest('Cat');
  const table = await online(ann, ['Rex']);
  // Ben joined first and only watches; Cat joined after him and sits down.
  const benId = await table.join(ben), catId = await table.join(cat);
  expect((await table.as(cat, 'seat-participant', { participantId: catId, seat: 2 })).status).toBe(200);
  const cats = await connectLive(base, cat, table.id);

  expect((await table.leave(ann, table.ownerId)).status).toBe(200);
  // Ownership passed in the same transition as her Leave Table: Ben, never the Bot.
  for (const cookie of [ben, cat]) expect((await table.view(cookie)).ownerParticipantId).toBe(benId);
  // Everyone following the table is shown the change live.
  await expect.poll(() => cats.messages.findLast(message => message.type === 'table-update')).toMatchObject({ ownerParticipantId: benId });
  expect((await get('/api/table-sessions/' + table.id, ann)).status).toBe(404);
});

test('the new owner has every owner capability, and the former owner returns like any other Guest, through the Join Link and its Table Password', async () => {
  const ann = await guest('Ann'), ben = await guest('Ben');
  const table = await online(ann, ['Rex']);
  const benId = await table.join(ben);
  expect((await table.leave(ann, table.ownerId)).status).toBe(200);
  // Ben manages the Bots and the table's rules, and sets a Table Password of his own.
  expect((await table.as(ben, 'add-bot', { name: 'Tim', playingStrategy: baselinePlayingStrategy })).status).toBe(200);
  expect((await table.as(ben, 'remove-bot', { participantId: table.botIds[0] })).status).toBe(200);
  const options = await post('/api/table-sessions/' + table.id + '/set-table-options', ben, { requestId: randomUUID(), expectedSessionRevision: (await table.view(ben)).sessionRevision, options: { actionTimeLimitSeconds: 60 } });
  expect(options.status).toBe(200);
  expect((await post('/api/table-sessions/' + table.id + '/set-table-password', ben, { requestId: randomUUID(), tablePassword: 'river' })).status).toBe(200);
  expect((await table.view(ben)).options).toMatchObject({ actionTimeLimitSeconds: 60, hasTablePassword: true });

  // Ann holds no place and no way back of her own: she needs the password like anyone not at the table.
  expect(await refusal(await table.joinWith(ann))).toEqual({ status: 403, code: 'table-password-required' });
  expect((await table.joinWith(ann, 'river')).status).toBe(200);
  const back = await table.view(ann);
  expect(back).toMatchObject({ viewerParticipantId: table.ownerId, ownerParticipantId: benId });
  expect(await refusal(await table.as(ann, 'add-bot', { name: 'Zed', playingStrategy: baselinePlayingStrategy }))).toEqual({ status: 403, code: 'table-owner-required' });
  // Ben can remove her now, as any Guest; she cannot remove him.
  expect(await refusal(await table.as(ann, 'remove-participant', { participantId: benId }))).toEqual({ status: 403, code: 'table-owner-required' });
  expect((await table.as(ben, 'remove-participant', { participantId: table.ownerId })).status).toBe(200);
});

test('no place is held for an owner who left: their place is free for anyone', async () => {
  const ann = await guest('Ann'), ben = await guest('Ben'), cy = await guest('Cy');
  const table = await online(ann, ['Rex']);
  await table.join(ben);
  const placesTaken = async () => (await (await get('/api/table-sessions/' + table.id + '/join-preview', cy)).json()).placesTaken;
  expect(await placesTaken()).toBe(3);
  expect((await table.leave(ann, table.ownerId)).status).toBe(200);
  expect(await placesTaken()).toBe(2);
});

/**
 * Seats each Guest given at the table, keeps them connected so Automatic Dealing deals to them, and deals the first
 * Hand. Returns a way to play it out: each human folds when it is their turn, and a Bot's Action Deadline runs out.
 */
async function dealt(table: Awaited<ReturnType<typeof online>>, seated: (readonly [string, string])[], bots: string[] = []) {
  const live = [];
  for (const [index, [cookie, participantId]] of seated.entries()) {
    expect((await table.as(cookie, 'seat-participant', { participantId, seat: index + 1 })).status).toBe(200);
    live.push(await connectLive(base, cookie, table.id));
  }
  const owner = seated[0]![0];
  for (const [index, participantId] of bots.entries()) expect((await table.as(owner, 'seat-participant', { participantId, seat: seated.length + index + 1 })).status).toBe(200);
  clock.advanceTo((await announcedCountdown(() => table.view(owner))).endsAt);
  await expect.poll(async () => (await table.view(owner)).view.state.handId).toBe('hand-1');
  clock.advance(1500);
  const cookieOf = new Map(seated.map(([cookie, participantId]) => [participantId, cookie]));
  /** Plays the Hand to its end and past its payout phase, as seen by `watcher`. */
  async function finish(watcher: string) {
    for (let step = 0; step < 40; step++) {
      const state = (await table.view(watcher)).view.state;
      if (state.status !== 'active-hand') break;
      const human = cookieOf.get(state.actorId!);
      if (human) expect((await table.as(human, 'act', { participantId: state.actorId, action: { type: 'fold' } })).status).toBe(200);
      else { clock.advance(31_000); await expect.poll(async () => (await table.view(watcher)).view.state.actorId).not.toBe(state.actorId); }
    }
    clock.advance(5000);
  }
  return { live, finish };
}

test('an owner who leaves during a Hand keeps ownership until it ends; then it passes in the after-Hand transition, past anyone leaving with them', async () => {
  const ann = await guest('Ann'), ben = await guest('Ben'), cat = await guest('Cat'), dee = await guest('Dee');
  const table = await online(ann);
  const benId = await table.join(ben), catId = await table.join(cat);
  await table.join(dee);
  const hand = await dealt(table, [[ann, table.ownerId], [ben, benId]]);
  // Cat and Dee watch. Ben, the earliest-joined, leaves after this Hand too.
  expect(await (await table.leave(ben, benId)).json()).toMatchObject({ ok: true, afterHand: true });
  expect(await (await table.leave(ann, table.ownerId)).json()).toMatchObject({ ok: true, afterHand: true });
  expect((await table.view(cat)).ownerParticipantId).toBe(table.ownerId);

  await hand.finish(cat);
  await expect.poll(async () => (await table.view(cat)).ownerParticipantId).toBe(catId);
  expect((await table.view(dee)).ownerParticipantId).toBe(catId);
  for (const cookie of [ann, ben]) expect((await get('/api/table-sessions/' + table.id, cookie)).status).toBe(404);
  expect((await table.view(dee)).departedParticipantIds).toEqual(expect.arrayContaining([table.ownerId, benId]));
});

test('join order is when each Guest last joined: one who left and returned joined after everyone still there', async () => {
  const ann = await guest('Ann'), ben = await guest('Ben'), cat = await guest('Cat');
  const table = await online(ann);
  const benId = await table.join(ben), catId = await table.join(cat);
  expect((await table.leave(ben, benId)).status).toBe(200);
  expect(await table.join(ben)).toBe(benId);
  expect((await table.leave(ann, table.ownerId)).status).toBe(200);
  expect((await table.view(ben)).ownerParticipantId).toBe(catId);
});

test('an owner who leaves with no other human at the table closes it in the same transition, at once or after the Hand', async () => {
  // At once: Ann watches her own table with a Bot, and leaves.
  const ann = await guest('Ann');
  const quiet = await online(ann, ['Rex']);
  const anns = await connectLive(base, ann, quiet.id);
  expect((await quiet.leave(ann, quiet.ownerId)).status).toBe(200);
  await expect.poll(() => anns.messages.at(-1)).toEqual({ type: 'table-membership-ended', tableSessionId: quiet.id, closed: true });
  expect((await get('/api/table-sessions/' + quiet.id + '/join-preview', await guest('Cy'))).status).toBe(410);
  expect((await (await get('/api/table-sessions', ann)).json()).tables).toContainEqual(expect.objectContaining({ tableSessionId: quiet.id, left: true, closed: true }));

  // After the Hand: Bea plays a Hand against a Bot, and leaves during it. Someone who left before does not count.
  const bea = await guest('Bea'), cal = await guest('Cal');
  const table = await online(bea, ['Tex']);
  const calId = await table.join(cal);
  expect((await table.leave(cal, calId)).status).toBe(200);
  const hand = await dealt(table, [[bea, table.ownerId]], table.botIds);
  expect(await (await table.leave(bea, table.ownerId)).json()).toMatchObject({ ok: true, afterHand: true });
  const [beas] = hand.live;
  await hand.finish(bea);
  await expect.poll(() => beas!.messages.at(-1)).toEqual({ type: 'table-membership-ended', tableSessionId: table.id, closed: true });
  expect((await table.joinWith(cal)).status).toBe(410);
});

test('only the owner’s view says who would become owner if they left, or that the table would close', async () => {
  const ann = await guest('Ann'), ben = await guest('Ben'), cat = await guest('Cat');
  const table = await online(ann, ['Rex']);
  // A Bot never takes over: alone with one, Ann's table would close.
  expect((await table.view(ann)).ownerSuccession).toEqual({ closes: true });
  const benId = await table.join(ben), catId = await table.join(cat);
  expect((await table.view(ann)).ownerSuccession).toEqual({ successorParticipantId: benId });
  for (const cookie of [ben, cat]) expect(await table.view(cookie)).not.toHaveProperty('ownerSuccession');

  // During a Hand, Ann's leave waits for its end, and Ben's pending leave takes him away in the same transition.
  const hand = await dealt(table, [[ann, table.ownerId], [ben, benId]]);
  expect((await table.view(ann)).ownerSuccession).toEqual({ successorParticipantId: benId });
  expect((await table.leave(ben, benId)).status).toBe(200);
  expect((await table.view(ann)).ownerSuccession).toEqual({ successorParticipantId: catId });
  await hand.finish(ann);
  await expect.poll(async () => (await table.view(ann)).pendingChanges).toEqual([]);
  expect((await table.view(ann)).ownerSuccession).toEqual({ successorParticipantId: catId });
  expect((await table.leave(cat, catId)).status).toBe(200);
  expect((await table.view(ann)).ownerSuccession).toEqual({ closes: true });

  // A Practice Table is never left, so it has none.
  const practice = await (await post('/api/table-sessions', ann, { requestId: randomUUID() })).json();
  expect(await (await get('/api/table-sessions/' + practice.tableSessionId, ann)).json()).not.toHaveProperty('ownerSuccession');
});
