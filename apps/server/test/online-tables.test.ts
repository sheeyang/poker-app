import { afterAll, beforeAll, expect, test } from 'vitest';
import { nameGuest } from './fixtures/guest.js';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { baselinePlayingStrategy, type ObservableTableSession } from '@poker/contracts';
import WebSocket from 'ws';
import { connectLive, announcedCountdown } from './fixtures/online.js';
import { createServer } from '../src/server.js';
import type { TableSessionControllerCommands } from '../src/mutations.js';
import { ManualClock } from './fixtures/clock.js';

// Online Tables always have Action Deadlines, so time moves only when a test moves it (see fixtures/clock.ts).
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
async function online(cookie: string, contents: object = {}) {
  const response = await post('/api/table-sessions', cookie, { requestId: randomUUID(), mode: 'online', ...contents });
  expect(response.status).toBe(201);
  const created = await response.json();
  return { id: created.tableSessionId as string, owner: cookie, ownerParticipant: created.bindings[0].participantId as string, bindings: created.bindings as { participantId: string; name: string }[] };
}
type Table = Awaited<ReturnType<typeof online>>;
const read = async (t: Table, cookie = t.owner): Promise<ObservableTableSession & { joinToken?: string; viewerParticipantId: string }> => (await get('/api/table-sessions/' + t.id, cookie)).json();
const refusal = async (response: Response) => ({ status: response.status, code: (await response.json()).rejection?.code });

test('an Online Table is created with its fixed mode and options, the owner joined and unseated, and a Join Link only the owner can read', async () => {
  const cookie = await guest('Ann');
  const table = await online(cookie, { configuration: { seatCount: 4, smallBlind: 5, bigBlind: 10, ante: 1, minimumBuyIn: 200, defaultBuyIn: 500, maximumBuyIn: 1000, allowSeatChanges: false }, options: { actionTimeLimitSeconds: 15, allowLiveAnalysis: false }, bots: [{ name: 'Rex', playingStrategy: baselinePlayingStrategy }] });
  expect(table.bindings).toEqual([{ participantId: expect.any(String), name: 'Ann', controller: { kind: 'human' } }, { participantId: expect.any(String), name: 'Rex', controller: { kind: 'bot', playingStrategy: baselinePlayingStrategy } }]);
  const view = await read(table);
  expect(view).toMatchObject({
    mode: 'online', viewerParticipantId: table.ownerParticipant, ownerParticipantId: table.ownerParticipant, options: { actionTimeLimitSeconds: 15, allowLiveAnalysis: false },
    inspection: { adminMode: false, completedHands: [] },
    view: { configuration: { seatCount: 4, smallBlind: 5, bigBlind: 10, ante: 1, minimumBuyIn: 200, defaultBuyIn: 500, maximumBuyIn: 1000, allowSeatChanges: false }, state: { status: 'between-hands', participants: [{ participantId: table.ownerParticipant, seat: null, stack: 0, sittingOut: false }] } },
  });
  // The Join Link is unguessable and distinct from the Table Session ID.
  expect(view.joinToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(view.joinToken).not.toContain(table.id);
  expect((await read(table)).joinToken).toBe(view.joinToken);
  expect((await (await get('/api/table-sessions', cookie)).json()).tables).toContainEqual(expect.objectContaining({ tableSessionId: table.id, mode: 'online' }));
  // A Practice Table keeps its fixed mode, no Join Link, and no Action Time Limit.
  const practice = await (await post('/api/table-sessions', cookie, { requestId: randomUUID() })).json();
  expect(await (await get('/api/table-sessions/' + practice.tableSessionId, cookie)).json()).toMatchObject({ mode: 'practice', options: { actionTimeLimitSeconds: null, allowLiveAnalysis: true } });
  expect(JSON.stringify(await (await get('/api/table-sessions/' + practice.tableSessionId, cookie)).json())).not.toContain('joinToken');
});

test('Online creation defaults to a 30 second Action Time Limit with Live Analysis allowed, and rejects options an Online Table cannot have', async () => {
  const cookie = await guest('Bea');
  expect((await read(await online(cookie))).options).toEqual({ actionTimeLimitSeconds: 30, allowLiveAnalysis: true });
  const rejected = async (contents: object) => refusal(await post('/api/table-sessions', cookie, { requestId: randomUUID(), mode: 'online', ...contents }));
  for (const options of [{ actionTimeLimitSeconds: 20 }, { actionTimeLimitSeconds: null }, { allowLiveAnalysis: 'yes' }, { surprise: true }])
    expect(await rejected({ options })).toEqual({ status: 400, code: 'invalid-creation-settings' });
  expect(await rejected({ configuration: { seatCount: 10 } })).toMatchObject({ status: 400 });
  expect(await rejected({ configuration: { seatCount: 1 } })).toMatchObject({ status: 400 });
  expect(await rejected({ mode: 'tournament' })).toEqual({ status: 400, code: 'invalid-creation-settings' });
  // A table's Participants must be distinguishable by name, ignoring case.
  expect(await rejected({ bots: [{ name: 'BEA', playingStrategy: baselinePlayingStrategy }] })).toEqual({ status: 400, code: 'name-taken' });
  expect(await rejected({ bots: [{ name: 'Rex', playingStrategy: baselinePlayingStrategy }, { name: 'rex', playingStrategy: baselinePlayingStrategy }] })).toEqual({ status: 400, code: 'name-taken' });
  // Bot names follow the same rules as every Participant's name, at creation as later.
  for (const name of ['x'.repeat(21), 'Bea' + String.fromCodePoint(0x200b), 'Bot <1>'])
    expect(await rejected({ bots: [{ name, playingStrategy: baselinePlayingStrategy }] })).toEqual({ status: 400, code: 'invalid-creation-settings' });
});

const join = (token: string, cookie: string, requestId = randomUUID()) => post('/api/join-links/' + encodeURIComponent(token) + '/join', cookie, { requestId });
const tokenOf = async (t: Table) => (await read(t)).joinToken!;

test('a Guest opens a Join Link, joins as an unseated Participant under their display name, and joining again returns the same Participant', async () => {
  const ann = await guest('Ann');
  const table = await online(ann, { bots: [{ name: 'Rex', playingStrategy: baselinePlayingStrategy }] });
  const token = await tokenOf(table);
  const ben = await guest('Ben');
  expect(await (await get('/api/join-links/' + token, ben)).json()).toEqual({
    ok: true, ownerName: 'Ann', placesTaken: 2, alreadyJoined: false,
    configuration: { seatCount: 6, smallBlind: 10, bigBlind: 20, ante: 0, minimumBuyIn: 1000, defaultBuyIn: 1000, maximumBuyIn: 1000, allowSeatChanges: true },
    options: { actionTimeLimitSeconds: 30, allowLiveAnalysis: true },
  });
  const before = await read(table);
  const requestId = randomUUID();
  const joined = await join(token, ben, requestId);
  expect(joined.status).toBe(200);
  const outcome = await joined.json();
  expect(outcome).toMatchObject({ ok: true, tableSessionId: table.id, participantId: expect.any(String) });
  // The Guest sees the public table from their own Participant, with no Seat, and cannot read the Join Link.
  const seen = await read(table, ben);
  expect(seen).toMatchObject({ mode: 'online', viewerParticipantId: outcome.participantId, ownerParticipantId: table.ownerParticipant, view: { state: { status: 'between-hands', participants: expect.arrayContaining([{ participantId: outcome.participantId, seat: null, stack: 0, sittingOut: false }]) } } });
  expect(seen.bindings).toContainEqual({ participantId: outcome.participantId, name: 'Ben', controller: { kind: 'human' } });
  expect(JSON.stringify(seen)).not.toContain(token);
  expect(await read(table)).toMatchObject({ joinToken: token, bindings: expect.arrayContaining([{ participantId: outcome.participantId, name: 'Ben', controller: { kind: 'human' } }]) });
  expect((await read(table)).pokerRevision).toBe(before.pokerRevision + 1);
  expect((await (await get('/api/table-sessions', ben)).json()).tables).toMatchObject([{ tableSessionId: table.id, mode: 'online' }]);
  // Retrying the request, or joining again, returns the Guest's existing Participant without another commit.
  expect(await (await join(token, ben, requestId)).json()).toEqual(outcome);
  const again = await (await join(token, ben)).json();
  expect(again).toMatchObject({ ok: true, participantId: outcome.participantId, pokerRevision: outcome.pokerRevision, sessionRevision: outcome.sessionRevision });
  expect(await refusal(await join(token, await guest('Cy'), requestId))).toEqual({ status: 409, code: 'request-id-conflict' });
  expect(await (await get('/api/join-links/' + token, ben)).json()).toMatchObject({ placesTaken: 3, alreadyJoined: true });
  // The membership and the Join Link survive a restart.
  await server.close();
  await start();
  expect(await (await join(token, ben)).json()).toMatchObject({ participantId: outcome.participantId });
  expect((await read(table, ben)).viewerParticipantId).toBe(outcome.participantId);
});

test('the owner sees a Guest arrive in a live update', async () => {
  const table = await online(await guest('Dee'));
  const socket = new WebSocket(base.replace('http:', 'ws:') + '/api/table-sessions/' + table.id + '/live', { headers: { cookie: table.owner } });
  const updates: ObservableTableSession[] = [];
  socket.on('message', data => { const message = JSON.parse(data.toString()); if (message.type === 'table-update') updates.push(message); });
  try {
    await expect.poll(() => updates.length).toBe(1);
    const joined = await (await join(await tokenOf(table), await guest('Eli'))).json();
    await expect.poll(() => updates.at(-1)?.bindings.map(binding => binding.name)).toEqual(['Dee', 'Eli']);
    expect(updates.at(-1)?.view.state.participants).toContainEqual({ participantId: joined.participantId, seat: null, stack: 0, sittingOut: false });
    expect(updates.at(-1)?.pokerRevision).toBe(updates[0]!.pokerRevision + 1);
  } finally { socket.terminate(); }
});

test('an invalid Join Link, a missing name, and a name already used at the table each get their own rejection', async () => {
  const table = await online(await guest('Fay'), { bots: [{ name: 'Rex', playingStrategy: baselinePlayingStrategy }] });
  const token = await tokenOf(table);
  const stranger = await guest('Gus');
  const invalid = { status: 404, code: 'invalid-join-link' };
  for (const bad of ['x'.repeat(43), 'short', table.id, '../' + table.id]) {
    expect(await refusal(await join(bad, stranger))).toEqual(invalid);
    expect(await refusal(await get('/api/join-links/' + encodeURIComponent(bad), stranger))).toEqual(invalid);
  }
  // A Practice Table has no Join Link, so nothing joins it.
  const practice = await (await post('/api/table-sessions', stranger, { requestId: randomUUID() })).json();
  expect(await refusal(await join(practice.tableSessionId, stranger))).toEqual(invalid);
  expect(await refusal(await post('/api/join-links/' + token + '/join', stranger, { requestId: randomUUID(), expectedPokerRevision: 0 }))).toEqual({ status: 400, code: 'invalid-mutation-request' });
  expect(await refusal(await post('/api/join-links/' + token + '/join', stranger, {}))).toEqual({ status: 400, code: 'invalid-request-id' });
  expect((await fetch(base + '/api/join-links/' + token + '/join', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ requestId: 'r' }) })).status).toBe(401);

  // Joining requires a display name, which the Guest sets first and then joins with a fresh request ID.
  const unnamed = await guest();
  expect(await refusal(await join(token, unnamed))).toEqual({ status: 400, code: 'display-name-required' });
  await nameGuest(base, unnamed, 'Hal');
  expect((await join(token, unnamed)).status).toBe(200);

  // Names are unique at the table, ignoring case, among humans and Bots.
  for (const taken of ['FAY', 'rex', 'hal']) {
    const other = await guest(taken);
    expect(await refusal(await join(token, other))).toEqual({ status: 409, code: 'name-taken' });
    expect((await get('/api/table-sessions', other).then(r => r.json())).tables).toEqual([]);
    await nameGuest(base, other, taken + '2');
    expect((await join(token, other)).status).toBe(200);
  }
  // A Participant's name is fixed when they join, whatever the Guest is later called.
  await nameGuest(base, unnamed, 'Hal Renamed');
  expect((await read(table, unnamed)).bindings.map(binding => binding.name)).toEqual(['Fay', 'Rex', 'Hal', 'FAY2', 'rex2', 'hal2']);
});

test('an Online Table holds at most 20 Participants, Bots included, and keeps a place for its owner while they are away', async () => {
  const table = await online(await guest('Owner'), { bots: [{ name: 'Rex', playingStrategy: baselinePlayingStrategy }, { name: 'Tim', playingStrategy: baselinePlayingStrategy }] });
  const token = await tokenOf(table);
  const placesTaken = async (cookie: string) => (await (await get('/api/join-links/' + token, cookie)).json()).placesTaken;
  // The owner and the two Bots take three of the twenty places.
  for (let index = 1; index <= 17; index++) expect((await join(token, await guest('Guest ' + index))).status).toBe(200);
  const late = await guest('Late');
  expect(await refusal(await join(token, late))).toEqual({ status: 409, code: 'table-full' });
  expect((await get('/api/table-sessions/' + table.id, late)).status).toBe(404);
  expect(await placesTaken(late)).toBe(20);
  // A full table takes no more Bots either.
  expect(await refusal(await command(table, table.owner, 'add-bot', { name: 'Zed', playingStrategy: baselinePlayingStrategy }))).toEqual({ status: 409, code: 'table-full' });
  // Someone already at a full table still gets their own Participant back.
  expect((await join(token, table.owner)).status).toBe(200);
  // The owner's place is held while they are away, so they can always return to manage their table.
  expect((await command(table, table.owner, 'leave-table', { participantId: table.ownerParticipant })).status).toBe(200);
  expect(await placesTaken(late)).toBe(20);
  expect(await refusal(await join(token, late))).toEqual({ status: 409, code: 'table-full' });
  expect(await (await post('/api/table-sessions/' + table.id + '/rejoin-table', table.owner, { requestId: randomUUID() })).json()).toMatchObject({ ok: true, participantId: table.ownerParticipant });
  // A Bot the owner removes frees its place.
  expect((await command(table, table.owner, 'remove-bot', { participantId: table.bindings[1]!.participantId })).status).toBe(200);
  expect(await placesTaken(late)).toBe(19);
  expect((await join(token, late)).status).toBe(200);
});

async function command(t: Table, cookie: string, kind: string, contents: object = {}) {
  return post('/api/table-sessions/' + t.id + '/' + kind, cookie, { requestId: randomUUID(), expectedPokerRevision: (await read(t, cookie)).pokerRevision, ...contents });
}
/**
 * Automatic Dealing deals the first Hand: the owner, Ann, stays connected so that she counts as an Eligible
 * Participant, and the Next-Hand Countdown runs out. Then the deal phase passes.
 */
async function deal(t: Table) {
  await connectLive(base, t.owner, t.id);
  clock.advanceTo((await announcedCountdown(() => read(t))).endsAt);
  await expect.poll(async () => (await read(t)).view.state.handId).toBe('hand-1');
  clock.advance(1500);
}
const stakes = { seatCount: 3, smallBlind: 10, bigBlind: 20, minimumBuyIn: 200, defaultBuyIn: 500, maximumBuyIn: 1000 };

test('unseated Participants see the public table and the Hand in progress, and their history begins when they join', async () => {
  const table = await online(await guest('Ann'), { configuration: stakes, bots: [{ name: 'Rex', playingStrategy: baselinePlayingStrategy }, { name: 'Tim', playingStrategy: baselinePlayingStrategy }] });
  const [ann, rex] = table.bindings.map(binding => binding.participantId) as [string, string, string];
  expect((await command(table, table.owner, 'seat-participant', { participantId: rex, seat: 1 })).status).toBe(200);
  expect((await command(table, table.owner, 'seat-participant', { participantId: ann, seat: 2, buyIn: 300 })).status).toBe(200);
  await deal(table);
  const token = await tokenOf(table);
  const ben = await guest('Ben');
  const benParticipant = (await (await join(token, ben)).json()).participantId as string;

  // Mid-Hand, the newcomer sees seats, names, stacks, blinds and pots, and nobody's hole cards.
  const watching = await read(table, ben);
  expect(watching.view.state).toMatchObject({ status: 'active-hand', handId: 'hand-1', board: [], legalActions: [] });
  expect(watching.view.state.participants.map(participant => [participant.participantId, participant.seat, participant.stack + (participant.wager ?? 0)]))
    .toEqual(expect.arrayContaining([[rex, 1, 500], [ann, 2, 300], [benParticipant, null, 0]]));
  expect(watching.view.state.participants.reduce((total, participant) => total + (participant.contribution ?? 0), 0)).toBe(30);
  expect(watching.view.state.participants.some(participant => participant.holeCards)).toBe(false);
  expect(JSON.stringify(watching)).not.toMatch(/"(?:seed|deck|burns|commands|userId|ownerUserId)"\s*:/);
  // Rex holds the button, so the Bot acts first.
  const actor = watching.view.state.actorId!;
  expect(actor).toBe(rex);
  expect(watching.view.history.flatMap(hand => hand.decisions)).toEqual([]);

  // A Bot's accepted action and the Hand's result are public to everyone who was joined for them.
  const accepted = await controller.submitAction(table.id, { requestId: randomUUID(), expectedPokerRevision: watching.pokerRevision, participantId: actor, action: { type: 'fold' } });
  expect(accepted.ok).toBe(true);
  const cy = await guest('Cy');
  await join(token, cy);
  for (const cookie of [table.owner, ben]) {
    const seen = await read(table, cookie);
    expect(seen.view.state).toMatchObject({ status: 'completed-hand', handId: 'hand-1' });
    expect(seen.view.history).toMatchObject([{ handId: 'hand-1', decisions: [{ action: { participantId: actor, action: { type: 'fold' } } }], result: { status: 'completed-hand' } }]);
  }
  // Cy joined after the Hand and observes none of it.
  const late = await read(table, cy);
  expect(late.view.history).toEqual([]);
  expect(late.view.state.handId).toBeUndefined();
});

test('any Participant takes an empty Seat within the buy-in limits, even during a Hand, and only for themselves', async () => {
  const table = await online(await guest('Ann'), { configuration: stakes, bots: [{ name: 'Rex', playingStrategy: baselinePlayingStrategy }, { name: 'Tim', playingStrategy: baselinePlayingStrategy }] });
  const [ann, rex] = table.bindings.map(binding => binding.participantId) as [string, string, string];
  await command(table, table.owner, 'seat-participant', { participantId: rex, seat: 1 });
  await command(table, table.owner, 'seat-participant', { participantId: ann, seat: 2 });
  await deal(table);
  const ben = await guest('Ben');
  const benParticipant = (await (await join(await tokenOf(table), ben)).json()).participantId as string;
  const sit = (cookie: string, contents: object) => command(table, cookie, 'seat-participant', contents);

  expect(await refusal(await sit(ben, { participantId: benParticipant, seat: 3, buyIn: 199 }))).toEqual({ status: 400, code: 'invalid-buy-in' });
  expect(await refusal(await sit(ben, { participantId: benParticipant, seat: 3, buyIn: 1001 }))).toEqual({ status: 400, code: 'invalid-buy-in' });
  expect(await refusal(await sit(ben, { participantId: benParticipant, seat: 2, buyIn: 500 }))).toEqual({ status: 400, code: 'seat-occupied' });
  expect(await refusal(await sit(ben, { participantId: ann, seat: 3 }))).toEqual({ status: 403, code: 'not-your-participant' });
  expect(await refusal(await sit(ben, { participantId: rex, seat: 3 }))).toEqual({ status: 403, code: 'table-owner-required' });
  expect((await sit(ben, { participantId: benParticipant, seat: 3, buyIn: 200 })).status).toBe(200);

  // The Hand in progress is unchanged: the newcomer is dealt in from the next Hand.
  const seen = await read(table, ben);
  expect(seen.view.state).toMatchObject({ status: 'active-hand', handId: 'hand-1' });
  expect(seen.view.state.participants.find(participant => participant.participantId === benParticipant)).toEqual({ participantId: benParticipant, seat: 3, stack: 200, sittingOut: false });
  expect((await read(table)).view.state.participants.find(participant => participant.participantId === benParticipant)).toMatchObject({ seat: 3, stack: 200 });
});

test('Deal, choosing the dealer button and completed-Hand inspection are unavailable at an Online Table, for its owner and its other Participants', async () => {
  const table = await online(await guest('Ann'), { configuration: stakes, bots: [{ name: 'Rex', playingStrategy: baselinePlayingStrategy }] });
  const ben = await guest('Ben');
  await join(await tokenOf(table), ben);
  const owner = await refusal(await command(table, table.owner, 'start-hand'));
  expect(owner).toEqual({ status: 403, code: 'unavailable-at-online-tables' });
  expect(await refusal(await command(table, ben, 'start-hand'))).toEqual({ status: 403, code: 'table-owner-required' });
  // Automatic Dealing moves the button; the owner manages table options, Bots and the Join Link, not the deal.
  expect((await command(table, table.owner, 'seat-participant', { participantId: table.ownerParticipant, seat: 1 })).status).toBe(200);
  expect((await command(table, table.owner, 'seat-participant', { participantId: table.bindings[1]!.participantId, seat: 2 })).status).toBe(200);
  const before = await read(table);
  expect(await refusal(await command(table, table.owner, 'set-button', { seat: 2 }))).toEqual({ status: 403, code: 'unavailable-at-online-tables' });
  expect(await refusal(await command(table, ben, 'set-button', { seat: 2 }))).toEqual({ status: 403, code: 'table-owner-required' });
  expect(await read(table)).toMatchObject({ pokerRevision: before.pokerRevision, view: { state: { buttonSeat: before.view.state.buttonSeat } } });
  expect(await refusal(await post('/api/table-sessions/' + table.id + '/inspect-hand', table.owner, { handId: 'hand-1' }))).toEqual({ status: 403, code: 'unavailable-at-online-tables' });
  expect(await refusal(await post('/api/table-sessions/' + table.id + '/inspect-hand', ben, { handId: 'hand-1' }))).toEqual({ status: 403, code: 'table-owner-required' });
  expect(await refusal(await post('/api/table-sessions/' + table.id + '/inspect-hand', await guest('Cy'), { handId: 'hand-1' }))).toEqual({ status: 404, code: 'not-found' });
  // The table reports that inspection is not offered, so no client shows its controls.
  expect((await read(table)).inspection).toEqual({ adminMode: false, completedHands: [] });
  // Practice Tables keep Admin Mode and explicit Deal.
  const practice = await (await post('/api/table-sessions', table.owner, { requestId: randomUUID() })).json();
  expect((await (await get('/api/table-sessions/' + practice.tableSessionId, table.owner)).json()).inspection.adminMode).toBe(true);
});

test('saved tables carry each table’s mode, observable stakes and play state, an owned table the Guest has left included', async () => {
  const table = await online(await guest('Ann'), { configuration: { ...stakes, ante: 5 }, bots: [{ name: 'Rex', playingStrategy: baselinePlayingStrategy }] });
  const ben = await guest('Ben');
  const benParticipant = (await (await join(await tokenOf(table), ben)).json()).participantId as string;
  const list = async (cookie: string) => (await (await get('/api/table-sessions', cookie)).json()).tables;
  const between = { seatCount: 3, stakes: { smallBlind: 10, bigBlind: 20, ante: 5 }, playState: { status: 'between-hands', completedHands: 0, seatedParticipants: 0 } };
  expect(await list(ben)).toEqual([{ tableSessionId: table.id, mode: 'online', ...between }]);
  // Ben and the Bot sit down and a Hand is dealt; the owner watches, then leaves.
  await connectLive(base, ben, table.id);
  expect((await command(table, ben, 'seat-participant', { participantId: benParticipant, seat: 1, buyIn: 400 })).status).toBe(200);
  expect((await command(table, table.owner, 'seat-participant', { participantId: table.bindings[1]!.participantId, seat: 2 })).status).toBe(200);
  clock.advanceTo((await announcedCountdown(() => read(table, ben))).endsAt);
  await expect.poll(async () => (await read(table, ben)).view.state.handId).toBe('hand-1');
  expect((await command(table, table.owner, 'leave-table', { participantId: table.ownerParticipant })).status).toBe(200);
  const playing = { seatCount: 3, stakes: { smallBlind: 10, bigBlind: 20, ante: 5 }, playState: { status: 'active-hand', completedHands: 0, seatedParticipants: 2 } };
  const benStack = (await read(table, ben)).view.state.participants.find(participant => participant.participantId === benParticipant)!.stack;
  expect(await list(ben)).toEqual([{ tableSessionId: table.id, mode: 'online', ...playing, playState: { ...playing.playState, viewerStack: benStack } }]);
  // The owner who left cannot read the table, yet their saved list still says what it is and how play stands.
  expect((await get('/api/table-sessions/' + table.id, table.owner)).status).toBe(404);
  expect(await list(table.owner)).toContainEqual({ tableSessionId: table.id, mode: 'online', left: true, ...playing });
});
