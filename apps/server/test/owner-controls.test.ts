import { afterAll, beforeAll, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { baselinePlayingStrategy, highestProbabilityPlayingStrategy, simpleHeuristicPlayingStrategy, type ConcreteAction, type ObservableTableSession, type ObservableTableUpdate } from '@poker/contracts';
import { createServer } from '../src/server.js';
import type { TableSessionControllerCommands } from '../src/mutations.js';
import { nameGuest } from './fixtures/guest.js';
import { ManualClock } from './fixtures/clock.js';
import { connectLive, type LiveConnection, announcedCountdown } from './fixtures/online.js';

// Online Tables always have Action Deadlines, so time moves only when a test moves it (see fixtures/clock.ts).
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
const stakes = { seatCount: 4, smallBlind: 10, bigBlind: 20, minimumBuyIn: 500, defaultBuyIn: 1000, maximumBuyIn: 1500 };
const refusal = async (response: Response) => ({ status: response.status, code: (await response.json()).rejection?.code as string | undefined });

/** A table of Ann (its owner), with Bots (by default one named Rex) that start unseated. Other Guests join an Online Table through its Join Link. */
async function newTable(mode: 'practice' | 'online', bots: string[] = ['Rex'], configuration: object = stakes) {
  const ann = await guest('Ann');
  const created = await (await post('/api/table-sessions', ann, { requestId: randomUUID(), mode, configuration, bots: bots.map(name => ({ name, playingStrategy: baselinePlayingStrategy })) })).json();
  const id = created.tableSessionId as string;
  const [annId, ...botIds] = created.bindings.map((binding: { participantId: string }) => binding.participantId) as string[];
  const view = async (cookie = ann): Promise<ObservableTableSession> => (await get('/api/table-sessions/' + id, cookie)).json();
  const token = (await view()).joinToken;
  const t = {
    id, ann, annId: annId!, botIds, token, view,
    async join(name: string) {
      const cookie = await guest(name);
      const joined = await (await post('/api/join-links/' + token + '/join', cookie, { requestId: randomUUID() })).json();
      return { cookie, participantId: joined.participantId as string };
    },
    /** A poker request from a Guest, at the poker revision that Guest last saw. */
    async as(cookie: string, kind: string, fields: object = {}) {
      return post('/api/table-sessions/' + id + '/' + kind, cookie, { requestId: randomUUID(), expectedPokerRevision: (await view(cookie)).pokerRevision, ...fields });
    },
    /** A configuration request from a Guest, at the session revision that Guest last saw. */
    async configure(cookie: string, kind: string, fields: object = {}) {
      return post('/api/table-sessions/' + id + '/' + kind, cookie, { requestId: randomUUID(), expectedSessionRevision: (await view(cookie)).sessionRevision, ...fields });
    },
    setOptions: (cookie: string, options: object, fields: object = {}) => t.configure(cookie, 'set-table-options', { options, ...fields }),
    async seat(cookie: string, participantId: string, seat: number) {
      expect((await t.as(cookie, 'seat-participant', { participantId, seat })).status).toBe(200);
    },
    connect: (cookie = ann) => connectLive(base, cookie, id),
  };
  return t;
}
type Table = Awaited<ReturnType<typeof newTable>>;
const participant = (table: ObservableTableSession, participantId: string) => table.view.state.participants.find(p => p.participantId === participantId)!;
const updates = (connection: LiveConnection) => connection.messages.filter((message): message is ObservableTableUpdate => message.type === 'table-update');
/** A Bot acts through the trusted controller commands, as an automatic Bot would. */
async function botActs(t: Table, action: ConcreteAction) {
  const current = await t.view();
  const actor = current.view.state.actorId!;
  expect(await controllers.submitAction(t.id, { requestId: randomUUID(), expectedPokerRevision: current.pokerRevision, participantId: actor, action })).toMatchObject({ ok: true });
}

test('the owner changes the Action Time Limit and the seat-change permission, and everyone at the table sees it', async () => {
  const t = await newTable('online');
  const ben = await t.join('Ben');
  const benLive = await t.connect(ben.cookie);
  await t.seat(ben.cookie, ben.participantId, 2);
  const before = await t.view();
  expect(before.options).toEqual({ actionTimeLimitSeconds: 30, allowLiveAnalysis: true });
  expect(before.view.configuration.allowSeatChanges).toBe(true);

  const changed = await t.setOptions(t.ann, { actionTimeLimitSeconds: 60, allowSeatChanges: false });
  expect(changed.status).toBe(200);
  // One request is one step of each revision, though the seat-change permission is a CashGame command.
  expect(await changed.json()).toEqual({ ok: true, tableSessionId: t.id, pokerRevision: before.pokerRevision + 1, sessionRevision: before.sessionRevision + 1 });
  for (const cookie of [t.ann, ben.cookie]) {
    const seen = await t.view(cookie);
    expect(seen.options).toEqual({ actionTimeLimitSeconds: 60, allowLiveAnalysis: true });
    expect(seen.view.configuration.allowSeatChanges).toBe(false);
  }
  await expect.poll(() => updates(benLive).at(-1)).toMatchObject({ options: { actionTimeLimitSeconds: 60 }, view: { configuration: { allowSeatChanges: false } }, presentationEvents: [{ type: 'seat-changes-changed', allowSeatChanges: false }] });
  expect(await refusal(await t.as(ben.cookie, 'move-participant', { participantId: ben.participantId, seat: 3 }))).toEqual({ status: 400, code: 'seat-changes-disabled' });

  const again = await t.setOptions(t.ann, { allowSeatChanges: true, allowLiveAnalysis: false });
  expect(again.status).toBe(200);
  expect((await t.view(ben.cookie)).options).toEqual({ actionTimeLimitSeconds: 60, allowLiveAnalysis: false });
  expect((await t.as(ben.cookie, 'move-participant', { participantId: ben.participantId, seat: 3 })).status).toBe(200);
  expect(participant(await t.view(), ben.participantId).seat).toBe(3);

  // An application-only option leaves the poker revision alone.
  const settled = await t.view();
  expect(await (await t.setOptions(t.ann, { actionTimeLimitSeconds: 15 })).json()).toMatchObject({ ok: true, pokerRevision: settled.pokerRevision, sessionRevision: settled.sessionRevision + 1 });
});

test('option changes name only supported options, belong to the owner, are idempotent, and an unchanged value is acknowledged without a commit', async () => {
  const t = await newTable('online');
  const ben = await t.join('Ben');
  const before = await t.view();
  expect(await refusal(await t.setOptions(ben.cookie, { actionTimeLimitSeconds: 15 }))).toEqual({ status: 403, code: 'table-owner-required' });
  const invalid: [string, unknown][] = [['nothing', {}], ['an unsupported length', { actionTimeLimitSeconds: 45 }], ['no limit', { actionTimeLimitSeconds: null }], ['a non-boolean', { allowLiveAnalysis: 'yes' }],
    ['a non-boolean seat setting', { allowSeatChanges: 1 }], ['an unknown option', { smallBlind: 5 }], ['a list', [15]], ['no object', undefined]];
  for (const [label, options] of invalid) expect({ label, ...await refusal(await t.setOptions(t.ann, options as object)) }).toEqual({ label, status: 400, code: 'invalid-table-options' });
  expect({ extra: true, ...await refusal(await t.configure(t.ann, 'set-table-options', { options: { actionTimeLimitSeconds: 15 }, participantId: ben.participantId })) }).toEqual({ extra: true, status: 400, code: 'invalid-table-options' });
  expect(await refusal(await t.configure(t.ann, 'set-table-options', { options: { actionTimeLimitSeconds: 15 }, expectedSessionRevision: before.sessionRevision + 5 }))).toEqual({ status: 409, code: 'stale-session-revision' });
  expect(await t.view()).toEqual(before);

  // Setting what is already set records the request and changes nothing.
  const same = await t.setOptions(t.ann, { actionTimeLimitSeconds: 30, allowSeatChanges: true, allowLiveAnalysis: true });
  expect(await same.json()).toEqual({ ok: true, tableSessionId: t.id, pokerRevision: before.pokerRevision, sessionRevision: before.sessionRevision });
  expect(await t.view()).toEqual(before);

  const requestId = randomUUID();
  const body = { requestId, expectedSessionRevision: before.sessionRevision, options: { actionTimeLimitSeconds: 15 } };
  const first = await (await post('/api/table-sessions/' + t.id + '/set-table-options', t.ann, body)).json();
  expect(first).toMatchObject({ ok: true, sessionRevision: before.sessionRevision + 1 });
  expect(await (await post('/api/table-sessions/' + t.id + '/set-table-options', t.ann, body)).json()).toEqual(first);
  expect((await t.view()).sessionRevision).toBe(before.sessionRevision + 1);
  expect(await refusal(await post('/api/table-sessions/' + t.id + '/set-table-options', t.ann, { ...body, options: { actionTimeLimitSeconds: 60 } }))).toEqual({ status: 409, code: 'request-id-conflict' });
  expect((await t.view()).options.actionTimeLimitSeconds).toBe(15);
});

test('a Practice Table has no option changes after creation', async () => {
  const t = await newTable('practice');
  const before = await t.view();
  expect(await refusal(await t.setOptions(t.ann, { allowSeatChanges: false }))).toEqual({ status: 403, code: 'unavailable-at-practice-tables' });
  expect(await t.view()).toEqual(before);
});

/** Rex in seat 1, the button, and Ann in seat 2, connected; the countdown has run out and the deal phase passed: Rex's first Action Window is open. */
async function rexToAct(t: Table) {
  const live = await t.connect();
  await t.seat(t.ann, t.botIds[0]!, 1); await t.seat(t.ann, t.annId, 2);
  clock.advanceTo((await announcedCountdown(() => t.view())).endsAt);
  await expect.poll(async () => (await t.view()).view.state.handId).toBe('hand-1');
  clock.advance(1500);
  return live;
}

test('options change only between Hands: not while a Hand is played or paid out, and a running Next-Hand Countdown is left alone, the next Hand using the new limit', async () => {
  const t = await newTable('online');
  await rexToAct(t);
  const hand = await t.view();
  expect(hand.view.state.status).toBe('active-hand');
  expect(await refusal(await t.setOptions(t.ann, { actionTimeLimitSeconds: 15 }))).toEqual({ status: 400, code: 'active-hand' });
  expect(await refusal(await t.setOptions(t.ann, { allowSeatChanges: false }))).toEqual({ status: 400, code: 'active-hand' });
  expect(await t.view()).toEqual(hand);

  await botActs(t, { type: 'fold' });
  const paidAt = clock.now();
  expect((await t.view()).view.state.status).toBe('completed-hand');
  // The payout phase is still part of the Hand.
  expect(await refusal(await t.setOptions(t.ann, { actionTimeLimitSeconds: 15 }))).toEqual({ status: 400, code: 'active-hand' });
  clock.advanceTo(paidAt + 2000);
  expect((await t.setOptions(t.ann, { allowLiveAnalysis: false })).status).toBe(200);

  // The countdown is announced once the pause has passed. Changing an option while it runs does not cancel or restart it.
  clock.advanceTo(paidAt + 5000);
  await expect.poll(async () => (await t.view()).schedule.nextHandCountdown).toEqual({ startsAt: paidAt + 5000, endsAt: paidAt + 10_000, durationMs: 5000 });
  clock.advanceTo(paidAt + 7000);
  expect((await t.setOptions(t.ann, { actionTimeLimitSeconds: 15 })).status).toBe(200);
  expect((await t.view()).schedule.nextHandCountdown).toEqual({ startsAt: paidAt + 5000, endsAt: paidAt + 10_000, durationMs: 5000 });
  clock.advanceTo(paidAt + 10_000);
  await expect.poll(async () => (await t.view()).view.state.handId).toBe('hand-2');
  clock.advance(1500);
  // Hand 2's button is Ann's, so her Action Window carries the limit chosen during the countdown.
  const second = await t.view();
  expect(second.schedule.actionWindow).toMatchObject({ participantId: t.annId, deadlineAt: second.schedule.actionWindow!.opensAt + 15_000 });
});

test('the options and the seat-change permission survive a restart', async () => {
  const t = await newTable('online');
  expect((await t.setOptions(t.ann, { actionTimeLimitSeconds: 60, allowLiveAnalysis: false, allowSeatChanges: false })).status).toBe(200);
  const before = await t.view();
  await server.close();
  await startServer();
  expect(await t.view()).toEqual({ ...before, serverTime: clock.now() });
  expect(before.view.configuration.allowSeatChanges).toBe(false);
});

const cleo = { name: 'Cleo', playingStrategy: highestProbabilityPlayingStrategy, buyIn: 800 };
const botOf = (table: ObservableTableSession, name: string) => table.bindings.find(binding => binding.name === name && binding.controller.kind === 'bot')!;
/** Chips at the table: stacks, plus what is in the pot while a Hand is played; once it completes the pot has been paid into the stacks. */
const chipsAtTable = (table: ObservableTableSession) => table.view.state.participants.reduce((sum, p) => sum + p.stack + (table.view.state.status === 'active-hand' ? p.contribution ?? 0 : 0), 0);

test('at a Practice Table the owner adds a Bot at any time, and one added during a Hand is dealt in from the next Hand without a missed blind', async () => {
  const t = await newTable('practice');
  await t.seat(t.ann, t.annId, 1); await t.seat(t.ann, t.botIds[0]!, 2);
  expect((await t.as(t.ann, 'start-hand')).status).toBe(200);
  clock.advance(1500);
  const hand = await t.view();
  expect(hand.view.state).toMatchObject({ status: 'active-hand', actorId: t.annId });

  const added = await t.as(t.ann, 'add-bot', cleo);
  expect(added.status).toBe(200);
  const mid = await t.view();
  // The newcomer takes the lowest open Seat with her buy-in, and is not in the Hand being played.
  expect(botOf(mid, 'Cleo')).toMatchObject({ controller: { kind: 'bot', playingStrategy: highestProbabilityPlayingStrategy } });
  expect(participant(mid, botOf(mid, 'Cleo').participantId)).toEqual({ participantId: botOf(mid, 'Cleo').participantId, seat: 3, stack: 800, sittingOut: false });
  expect(mid.view.state).toMatchObject({ status: 'active-hand', handId: 'hand-1', actorId: t.annId });
  expect(mid.view.state.pots).toEqual(hand.view.state.pots);
  expect(chipsAtTable(mid)).toBe(2800);

  expect((await t.as(t.ann, 'act', { participantId: t.annId, action: { type: 'fold' } })).status).toBe(200);
  clock.advance(2000);
  expect((await t.as(t.ann, 'start-hand')).status).toBe(200);
  const second = await t.view();
  // Dealt in with the normal blinds of three players, and nothing extra for the seat she took.
  const cleoId = botOf(second, 'Cleo').participantId;
  expect(second.view.state.participants.filter(p => p.inHand).map(p => p.participantId).sort()).toEqual([t.annId, t.botIds[0]!, cleoId].sort());
  expect(second.view.state.participants.reduce((sum, p) => sum + (p.contribution ?? 0), 0)).toBe(30);
  expect(chipsAtTable(second)).toBe(2800);
});

test('at an Online Table the owner adds a Bot at any time, and it joins the next Hand the server deals', async () => {
  const t = await newTable('online');
  const ben = await t.join('Ben');
  await t.connect(ben.cookie);
  await rexToAct(t);
  const added = await t.as(t.ann, 'add-bot', cleo);
  expect(added.status).toBe(200);
  const mid = await t.view(ben.cookie);
  const cleoId = botOf(mid, 'Cleo').participantId;
  // Everyone sees her, seated at the lowest open Seat, outside the current Hand.
  expect(participant(mid, cleoId)).toEqual({ participantId: cleoId, seat: 3, stack: 800, sittingOut: false });
  expect(mid.view.state.status).toBe('active-hand');
  await botActs(t, { type: 'fold' });
  clock.advanceTo(clock.now() + 2000 + 3000);
  await expect.poll(async () => (await t.view()).schedule.nextHandCountdown).toBeDefined();
  clock.advanceTo((await announcedCountdown(() => t.view())).endsAt);
  await expect.poll(async () => (await t.view()).view.state.handId).toBe('hand-2');
  const second = await t.view(ben.cookie);
  expect(participant(second, cleoId)).toMatchObject({ inHand: true });
  expect(participant(second, ben.participantId)).toEqual({ participantId: ben.participantId, seat: null, stack: 0, sittingOut: false });
  expect(chipsAtTable(second)).toBe(2800);
});

test('a Bot is added with a unique name, a supported Playing Strategy and a buy-in within the limits, into an open Seat, by the owner only', async () => {
  const t = await newTable('online');
  const ben = await t.join('Ben');
  await t.seat(ben.cookie, ben.participantId, 3);
  const before = await t.view();
  const refuse = async (label: string, fields: object, status: number, code: string, cookie = t.ann) => expect({ label, ...await refusal(await t.as(cookie, 'add-bot', fields)) }).toEqual({ label, status, code });
  await refuse('a Guest cannot add Bots', cleo, 403, 'table-owner-required', ben.cookie);
  // Names are told apart ignoring case, among every Participant: humans, Bots, and those who have left.
  await refuse('the owner’s name', { ...cleo, name: 'ann' }, 409, 'name-taken');
  await refuse('another Guest’s name', { ...cleo, name: 'BEN' }, 409, 'name-taken');
  await refuse('a Bot’s name', { ...cleo, name: ' rex ' }, 409, 'name-taken');
  // A Bot's name follows the rules for every Participant's name: 1 to 20 letters, digits, spaces or basic punctuation.
  // An invisible character (a zero-width space, a direction isolate) cannot make a second "Ben" either.
  const invisible = (codePoint: number) => String.fromCodePoint(codePoint);
  for (const name of ['', '   ', 'x'.repeat(21), 'Bad\u0007Name', 'Ben' + invisible(0x200b), invisible(0x2066) + 'Ben', 'Bot <1>', 7]) await refuse('name ' + JSON.stringify(name), { ...cleo, name }, 400, 'invalid-bot-name');
  await refuse('an unsupported strategy', { ...cleo, playingStrategy: { policy: { id: 'unknown', version: 'v1', configuration: {} }, selector: baselinePlayingStrategy.selector } }, 400, 'unsupported-strategy');
  await refuse('a buy-in above the limit', { ...cleo, buyIn: 1501 }, 400, 'invalid-buy-in');
  await refuse('a buy-in below the limit', { ...cleo, buyIn: 499 }, 400, 'invalid-buy-in');
  await refuse('an occupied seat', { ...cleo, seat: 3 }, 400, 'seat-occupied');
  await refuse('a missing seat', { ...cleo, seat: 5 }, 400, 'invalid-seat');
  await refuse('an unsupported field', { ...cleo, participantId: ben.participantId }, 400, 'invalid-mutation-request');
  await refuse('no strategy', { name: 'Cleo' }, 400, 'unsupported-strategy');
  expect(await t.view()).toEqual(before);

  // Without a buy-in or a Seat: the table's default buy-in and the lowest open Seat. Or the Seat the owner chooses.
  const requestId = randomUUID();
  const request = { requestId, expectedPokerRevision: before.pokerRevision, name: 'Cleo', playingStrategy: simpleHeuristicPlayingStrategy };
  const first = await (await post('/api/table-sessions/' + t.id + '/add-bot', t.ann, request)).json();
  expect(first).toMatchObject({ ok: true, pokerRevision: before.pokerRevision + 1, sessionRevision: before.sessionRevision + 1 });
  expect(await (await post('/api/table-sessions/' + t.id + '/add-bot', t.ann, request)).json()).toEqual(first);
  expect(await refusal(await post('/api/table-sessions/' + t.id + '/add-bot', t.ann, { ...request, name: 'Dot' }))).toEqual({ status: 409, code: 'request-id-conflict' });
  let seen = await t.view();
  expect(seen.bindings.filter(binding => binding.name === 'Cleo')).toHaveLength(1);
  expect(participant(seen, botOf(seen, 'Cleo').participantId)).toMatchObject({ seat: 1, stack: 1000 });
  expect((await t.as(t.ann, 'add-bot', { name: 'Dot', playingStrategy: baselinePlayingStrategy, seat: 4, buyIn: 500 })).status).toBe(200);
  expect((await t.as(t.ann, 'add-bot', { name: 'Eve', playingStrategy: baselinePlayingStrategy })).status).toBe(200);
  seen = await t.view();
  expect(['Cleo', 'Dot', 'Eve'].map(name => participant(seen, botOf(seen, name).participantId).seat)).toEqual([1, 4, 2]);
  expect(participant(seen, botOf(seen, 'Dot').participantId).stack).toBe(500);
  // The table is full.
  await refuse('no open Seat', { name: 'Fay', playingStrategy: baselinePlayingStrategy }, 400, 'no-empty-seat');
});

test('between Hands the owner changes a Bot’s Playing Strategy, tops up its stack, sits it out and resumes it, and removes it, whose name then stays taken', async () => {
  const t = await newTable('practice', ['Rex', 'Sol']);
  const [rex, sol] = t.botIds as [string, string];
  await t.seat(t.ann, rex, 2);
  expect((await t.as(t.ann, 'add-bot', cleo)).status).toBe(200);
  const cleoId = botOf(await t.view(), 'Cleo').participantId;
  expect((await t.configure(t.ann, 'set-playing-strategy', { participantId: rex, playingStrategy: simpleHeuristicPlayingStrategy })).status).toBe(200);
  expect(botOf(await t.view(), 'Rex').controller).toEqual({ kind: 'bot', playingStrategy: simpleHeuristicPlayingStrategy });
  expect((await t.as(t.ann, 'top-up-to', { participantId: cleoId, targetStack: 1500 })).status).toBe(200);
  expect(participant(await t.view(), cleoId).stack).toBe(1500);
  expect((await t.as(t.ann, 'set-sitting-out', { participantId: rex, sittingOut: true })).status).toBe(200);
  expect(participant(await t.view(), rex).sittingOut).toBe(true);
  expect((await t.as(t.ann, 'set-sitting-out', { participantId: rex, sittingOut: false })).status).toBe(200);
  expect(participant(await t.view(), rex).sittingOut).toBe(false);

  // Removal stands the Bot up, cashing it out, and ends its place at the table. Nobody else's chips change.
  const before = await t.view();
  expect(before.departedParticipantIds).toBeUndefined();
  const removed = await t.as(t.ann, 'remove-bot', { participantId: cleoId });
  expect(removed.status).toBe(200);
  expect(await removed.json()).not.toHaveProperty('afterHand');
  const after = await t.view();
  expect(participant(after, cleoId)).toEqual({ participantId: cleoId, seat: null, stack: 0, sittingOut: false });
  expect(participant(after, rex)).toEqual(participant(before, rex));
  expect(after.departedParticipantIds).toEqual([cleoId]);
  expect(after.bindings.find(binding => binding.participantId === cleoId)).toMatchObject({ name: 'Cleo' });
  expect(after.pendingChanges).toEqual([]);
  // A removed Bot is gone for good: its name stays taken and nothing can seat, manage or retune it.
  expect(await refusal(await t.as(t.ann, 'add-bot', cleo))).toEqual({ status: 409, code: 'name-taken' });
  for (const [kind, fields] of [['seat-participant', { seat: 3 }], ['top-up-to', { targetStack: 1500 }], ['set-sitting-out', { sittingOut: true }], ['remove-bot', {}]] as const)
    expect({ kind, ...await refusal(await t.as(t.ann, kind, { participantId: cleoId, ...fields })) }).toEqual({ kind, status: 400, code: 'bot-removed' });
  expect(await refusal(await t.configure(t.ann, 'set-playing-strategy', { participantId: cleoId, playingStrategy: baselinePlayingStrategy }))).toEqual({ status: 400, code: 'bot-removed' });

  // A Bot that was never seated is removed at once too, and an unknown Participant is refused.
  expect((await t.as(t.ann, 'remove-bot', { participantId: sol })).status).toBe(200);
  expect((await t.view()).departedParticipantIds).toEqual([sol, cleoId]);
  expect(await refusal(await t.as(t.ann, 'remove-bot', { participantId: randomUUID() }))).toEqual({ status: 400, code: 'participant-not-bound' });
});

test('a seated Bot is sat out or removed after the Hand, shown to everyone as pending, while a Bot without a Seat goes at once', async () => {
  const t = await newTable('online', ['Rex', 'Sol', 'Tia']);
  const ben = await t.join('Ben');
  await t.connect(ben.cookie);
  const [rex, sol, tia] = t.botIds as [string, string, string];
  await t.seat(t.ann, sol, 4);
  await rexToAct(t);
  // Sol was seated before the deal, so she is in the Hand. Cleo, added mid-Hand, is seated but not in it. Tia never sat down.
  expect((await t.as(t.ann, 'add-bot', cleo)).status).toBe(200);
  const cleoId = botOf(await t.view(), 'Cleo').participantId;
  expect(participant(await t.view(), sol)).toMatchObject({ inHand: true });
  expect(participant(await t.view(), cleoId)).toMatchObject({ seat: 3 });

  // Stack changes and resuming wait for the Hand, as a human's do.
  for (const [kind, fields] of [['top-up-to', { participantId: sol, targetStack: 1500 }], ['stand-up-participant', { participantId: sol }], ['move-participant', { participantId: sol, seat: 3 }], ['set-sitting-out', { participantId: sol, sittingOut: false }]] as const)
    expect({ kind, ...await refusal(await t.as(t.ann, kind, fields)) }).toEqual({ kind, status: 400, code: 'active-hand' });
  const sat = await t.as(t.ann, 'set-sitting-out', { participantId: sol, sittingOut: true });
  expect(await sat.json()).toMatchObject({ ok: true, afterHand: true });
  const removal = await t.as(t.ann, 'remove-bot', { participantId: rex });
  expect(await removal.json()).toMatchObject({ ok: true, afterHand: true });
  // CashGame stands nobody up mid-Hand, so a seated Bot outside the Hand waits for it too.
  expect(await (await t.as(t.ann, 'remove-bot', { participantId: cleoId })).json()).toMatchObject({ ok: true, afterHand: true });
  const pending = await t.view(ben.cookie);
  expect(pending.pendingChanges).toEqual([{ participantId: sol, change: 'sit-out' }, { participantId: rex, change: 'remove' }, { participantId: cleoId, change: 'remove' }]);
  expect(participant(pending, rex)).toMatchObject({ seat: 1, inHand: true });
  expect(pending.departedParticipantIds).toBeUndefined();
  // Tia has no Seat, so nothing is at stake: she goes at once.
  const gone = await t.as(t.ann, 'remove-bot', { participantId: tia });
  expect(gone.status).toBe(200);
  expect(await gone.json()).not.toHaveProperty('afterHand');
  expect((await t.view(ben.cookie)).departedParticipantIds).toEqual([tia]);

  // The Hand is played out; when its payout phase ends Rex has left and Sol sits out.
  await botActs(t, { type: 'fold' });
  expect((await t.as(t.ann, 'act', { participantId: t.annId, action: { type: 'fold' } })).status).toBe(200);
  expect((await t.view()).view.state.status).toBe('completed-hand');
  expect((await t.view()).pendingChanges).toHaveLength(3);
  clock.advance(2000);
  await expect.poll(async () => (await t.view()).pendingChanges).toEqual([]);
  const settled = await t.view(ben.cookie);
  // Rex's folded hand is still in the completed Hand he played; he has no Seat or chips any more.
  expect(participant(settled, rex)).toMatchObject({ seat: null, stack: 0, sittingOut: false, folded: true });
  expect(participant(settled, cleoId)).toEqual({ participantId: cleoId, seat: null, stack: 0, sittingOut: false });
  expect(participant(settled, sol)).toMatchObject({ seat: 4, sittingOut: true });
  expect(settled.departedParticipantIds).toEqual([rex, tia, cleoId]);
  // Rex and Cleo cashed out their chips; what Ann and Sol played for is all that is left.
  expect(chipsAtTable(settled)).toBe(2000);
  // The owner resumes the sat-out Bot, as after any other sit-out (Online failures sit Bots out the same way).
  expect((await t.as(t.ann, 'set-sitting-out', { participantId: sol, sittingOut: false })).status).toBe(200);
  expect(participant(await t.view(), sol).sittingOut).toBe(false);
});

test('the owner can never act for, move, sit out, stand up or change the chips of another human, nor see their hole cards or analysis', async () => {
  const t = await newTable('online');
  const ben = await t.join('Ben');
  await t.connect(ben.cookie);
  await t.seat(t.ann, t.botIds[0]!, 1); await t.seat(ben.cookie, ben.participantId, 2);
  clock.advanceTo((await announcedCountdown(() => t.view())).endsAt);
  await expect.poll(async () => (await t.view()).view.state.handId).toBe('hand-1');
  clock.advance(1500);
  await botActs(t, { type: 'call' });

  const benSees = participant(await t.view(ben.cookie), ben.participantId);
  expect(benSees.holeCards).toHaveLength(2);
  // The owner sees that Ben holds two cards, not which.
  const annSees = await t.view();
  expect(participant(annSees, ben.participantId)).toMatchObject({ inHand: true, cardCount: 2 });
  expect(participant(annSees, ben.participantId).holeCards).toBeUndefined();
  // A card is a JSON string of its own; its two characters alone can occur inside any identifier.
  const card = JSON.stringify(benSees.holeCards![0]!);
  expect(JSON.stringify(annSees)).not.toContain(card);

  // Every request that names Ben's Participant is refused for the owner, whatever it asks and whether or not a Hand is on.
  const before = await t.view(ben.cookie);
  const target = { participantId: ben.participantId };
  const requests: [string, object][] = [['seat-participant', { ...target, seat: 3 }], ['act', { ...target, action: { type: 'fold' } }], ['stand-up-participant', target], ['move-participant', { ...target, seat: 3 }],
    ['set-sitting-out', { ...target, sittingOut: true }], ['top-up-to', { ...target, targetStack: 1500 }], ['leave-table', target], ['remove-bot', target]];
  for (const [kind, fields] of requests) expect({ kind, ...await refusal(await t.as(t.ann, kind, fields)) }).toEqual({ kind, status: 403, code: 'not-your-participant' });
  expect({ kind: 'set-playing-strategy', ...await refusal(await t.configure(t.ann, 'set-playing-strategy', { ...target, playingStrategy: highestProbabilityPlayingStrategy })) }).toEqual({ kind: 'set-playing-strategy', status: 400, code: 'participant-not-bot' });
  expect({ kind: 'retry-bot', ...await refusal(await t.configure(t.ann, 'retry-bot', target)) }).toEqual({ kind: 'retry-bot', status: 403, code: 'unavailable-at-online-tables' });
  // A Trainer configuration is the requester's own: it names no Participant.
  expect(await refusal(await t.configure(t.ann, 'set-trainer-configuration', { ...target, trainerConfiguration: { referenceStrategy: highestProbabilityPlayingStrategy, liveAnalysis: true } }))).toEqual({ status: 400, code: 'invalid-trainer-configuration' });
  expect(await t.view(ben.cookie)).toEqual(before);

  // Ben acts for himself, and his analysis is his alone.
  expect((await t.as(ben.cookie, 'act', { ...target, action: { type: 'fold' } })).status).toBe(200);
  const decisionId = 'hand-1/decision-2';
  const analysis = await (await post('/api/table-sessions/' + t.id + '/analysis', ben.cookie, { decisionId })).json();
  expect(analysis).toMatchObject({ ok: true, participantId: ben.participantId, decisionId });
  expect(await refusal(await post('/api/table-sessions/' + t.id + '/analysis', t.ann, { decisionId }))).toEqual({ status: 400, code: 'decision-unavailable' });
  expect((await get('/api/table-sessions/' + t.id + '/analysis/' + analysis.requestId, t.ann)).status).toBe(404);
  expect((await post('/api/table-sessions/' + t.id + '/analysis/' + analysis.requestId + '/retry', t.ann, {})).status).toBe(404);
  // The owner's own summary covers none of Ben's decisions, and nobody inspects a completed Hand at an Online Table.
  expect(await (await post('/api/table-sessions/' + t.id + '/session-summaries', t.ann, {})).json()).toMatchObject({ ok: true, status: 'empty', decisionCount: 0 });
  expect(await refusal(await post('/api/table-sessions/' + t.id + '/inspect-hand', t.ann, { handId: 'hand-1' }))).toEqual({ status: 403, code: 'unavailable-at-online-tables' });
  expect(JSON.stringify(await t.view())).not.toContain(card);
});

test('the table view says who has left or been removed, humans and Bots alike', async () => {
  const t = await newTable('online');
  const ben = await t.join('Ben'), cy = await t.join('Cy');
  expect((await t.view()).departedParticipantIds).toBeUndefined();
  expect((await t.as(ben.cookie, 'leave-table', { participantId: ben.participantId })).status).toBe(200);
  expect((await t.as(t.ann, 'remove-participant', { participantId: cy.participantId })).status).toBe(200);
  expect((await t.as(t.ann, 'remove-bot', { participantId: t.botIds[0] })).status).toBe(200);
  // Everyone still at the table sees the same list, in binding order; the owner never counts as departed while they are here.
  const seen = await t.view();
  expect(seen.departedParticipantIds).toEqual([t.botIds[0], ben.participantId, cy.participantId]);
  expect(JSON.stringify(seen)).not.toMatch(/"(?:membership|removed)"\s*:/);
  expect(seen.bindings.map(binding => binding.name)).toEqual(['Ann', 'Rex', 'Ben', 'Cy']);
  // Ben rejoins as the same Participant: he is no longer listed.
  expect((await post('/api/join-links/' + t.token + '/join', ben.cookie, { requestId: randomUUID() })).status).toBe(200);
  expect((await t.view()).departedParticipantIds).toEqual([t.botIds[0], cy.participantId]);
});

test('Bots added and removed, and their names, survive a restart, and an added Bot is dealt in afterwards', async () => {
  const t = await newTable('online', ['Rex', 'Sol']);
  expect((await t.as(t.ann, 'add-bot', cleo)).status).toBe(200);
  expect((await t.as(t.ann, 'remove-bot', { participantId: t.botIds[1] })).status).toBe(200);
  const before = await t.view();
  await server.close();
  await startServer();
  expect(await t.view()).toEqual(before);
  expect(await refusal(await t.as(t.ann, 'add-bot', { name: 'Sol', playingStrategy: baselinePlayingStrategy }))).toEqual({ status: 409, code: 'name-taken' });
  expect(await refusal(await t.as(t.ann, 'add-bot', cleo))).toEqual({ status: 409, code: 'name-taken' });
  await t.connect();
  await t.seat(t.ann, t.annId, 2);
  const cleoId = botOf(before, 'Cleo').participantId;
  clock.advanceTo((await announcedCountdown(() => t.view())).endsAt);
  await expect.poll(async () => (await t.view()).view.state.handId).toBe('hand-1');
  expect(participant(await t.view(), cleoId)).toMatchObject({ inHand: true });
});
