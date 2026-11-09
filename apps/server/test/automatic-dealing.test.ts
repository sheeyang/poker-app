import { afterAll, beforeAll, expect, onTestFinished, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { baselinePlayingStrategy, type ConcreteAction, type ObservableTableSession, type ObservableTableUpdate } from '@poker/contracts';
import { createServer } from '../src/server.js';
import type { TableSessionControllerCommands } from '../src/mutations.js';
import { nameGuest } from './fixtures/guest.js';
import { ManualClock } from './fixtures/clock.js';
import { connectLive, type LiveConnection, announcedCountdown } from './fixtures/online.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('Set TEST_DATABASE_URL to a real PostgreSQL test database.');
const schema = 'test_' + randomUUID().replaceAll('-', '');
const administration = new Pool({ connectionString: databaseUrl });
const clock = new ManualClock();
let server: Awaited<ReturnType<typeof createServer>>;
let base: string;
let controllers: TableSessionControllerCommands;
type Context = { tableSessionId?: string; requestId: string };
let beforeCommit: (context: Context) => Promise<void> = async () => {};
async function startServer() {
  server = await createServer({ clock, automaticBots: false, databaseUrl: databaseUrl!, schema, onControllerCommandsReady: commands => { controllers = commands; },
    mutationTransactionFaults: { beforeCommit: context => beforeCommit(context) } });
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
const stakes = { seatCount: 4, smallBlind: 10, bigBlind: 20, minimumBuyIn: 1000, defaultBuyIn: 1000, maximumBuyIn: 1000 };

/** An Online Table of Ann (its owner) with Bots, by default one named Rex. Other Guests join through its Join Link. */
async function onlineTable(bots: string[] = ['Rex']) {
  const ann = await guest('Ann');
  const created = await (await post('/api/table-sessions', ann, { requestId: randomUUID(), mode: 'online', configuration: stakes, bots: bots.map(name => ({ name, playingStrategy: baselinePlayingStrategy })) })).json();
  const id = created.tableSessionId as string;
  const [annId, ...botIds] = created.bindings.map((binding: { participantId: string }) => binding.participantId) as string[];
  const view = async (cookie = ann): Promise<ObservableTableSession> => (await get('/api/table-sessions/' + id, cookie)).json();
  const t = {
    id, ann, annId: annId!, botIds, view,
    async join(name: string) {
      const cookie = await guest(name);
      const joined = await (await post('/api/table-sessions/' + id + '/join-table', cookie, { requestId: randomUUID() })).json();
      return { cookie, participantId: joined.participantId as string };
    },
    /** A request from a Guest, at the poker revision that Guest last saw. */
    async as(cookie: string, kind: string, fields: object = {}) {
      return post('/api/table-sessions/' + id + '/' + kind, cookie, { requestId: randomUUID(), expectedPokerRevision: (await view(cookie)).pokerRevision, ...fields });
    },
    async seat(cookie: string, participantId: string, seat: number) {
      expect((await t.as(cookie, 'seat-participant', { participantId, seat })).status).toBe(200);
    },
    /** A live connection of the Guest: Ann's by default. */
    connect: (cookie = ann) => connectLive(base, cookie, id),
  };
  return t;
}
type Table = Awaited<ReturnType<typeof onlineTable>>;
const participant = (table: ObservableTableSession, participantId: string) => table.view.state.participants.find(p => p.participantId === participantId)!;
/** Stacks, plus what is in the pot while a Hand is played; once it completes, the pot has been paid into the stacks. */
const chipsAtTable = (table: ObservableTableSession) => table.view.state.participants.reduce((sum, p) => sum + p.stack + (table.view.state.status === 'active-hand' ? p.contribution ?? 0 : 0), 0);
const updates = (connection: LiveConnection) => connection.messages.filter((message): message is ObservableTableUpdate => message.type === 'table-update');
/** The acting human acts through HTTP; a Bot through the trusted controller commands. */
async function act(t: Table, cookieOf: (participantId: string) => string | undefined, action: ConcreteAction) {
  const current = await t.view();
  const actor = current.view.state.actorId!;
  const cookie = cookieOf(actor);
  if (cookie) { expect((await t.as(cookie, 'act', { participantId: actor, action })).status).toBe(200); return; }
  expect(await controllers.submitAction(t.id, { requestId: randomUUID(), expectedPokerRevision: current.pokerRevision, participantId: actor, action })).toMatchObject({ ok: true });
}
const annOnly = (t: Table) => (id: string) => id === t.annId ? t.ann : undefined;
/** Lets the announced countdown run out and the deal phase pass: the first Action Window of the Hand is open. */
async function dealt(t: Table, handId = 'hand-1') {
  clock.advanceTo((await announcedCountdown(() => t.view())).endsAt);
  await expect.poll(async () => (await t.view()).view.state.handId).toBe(handId);
  clock.advance(1500);
}
/** Ann, connected, and the Bot are seated heads-up, and Hand 1 is dealt with Ann, on the button, to act. */
async function dealtHeadsUp(t: Table) {
  const live = await t.connect();
  await t.seat(t.ann, t.annId, 1); await t.seat(t.ann, t.botIds[0]!, 2);
  await dealt(t);
  return live;
}

test('an Online Table announces a Next-Hand Countdown, visible to everyone, once two Eligible Participants including a connected human are seated, and deals when it expires', async () => {
  const t = await onlineTable();
  const ben = await t.join('Ben');
  const annLive = await t.connect(), benLive = await t.connect(ben.cookie);
  await t.seat(t.ann, t.annId, 1);
  // One Eligible Participant is not enough.
  expect((await t.view()).schedule.nextHandCountdown).toBeUndefined();
  const seatedAt = clock.now();
  await t.seat(t.ann, t.botIds[0]!, 2);
  const announced = await t.view();
  expect(announced.schedule.nextHandCountdown).toEqual({ startsAt: seatedAt, endsAt: seatedAt + 5000, durationMs: 5000 });
  expect(announced.view.state.status).toBe('between-hands');
  // Everyone at the table sees it, seated or not, in their views and live.
  expect((await t.view(ben.cookie)).schedule.nextHandCountdown).toEqual(announced.schedule.nextHandCountdown);
  await expect.poll(() => updates(benLive).at(-1)?.schedule.nextHandCountdown).toEqual(announced.schedule.nextHandCountdown);
  // Deal is never accepted at an Online Table: the server deals.
  const deal = await t.as(t.ann, 'start-hand');
  expect({ status: deal.status, code: (await deal.json()).rejection?.code }).toEqual({ status: 403, code: 'unavailable-at-online-tables' });
  clock.advance(4999);
  expect((await t.view()).view.state.status).toBe('between-hands');
  clock.advance(1);
  await expect.poll(async () => (await t.view()).view.state.status).toBe('active-hand');
  const hand = await t.view();
  expect(hand.view.state).toMatchObject({ handId: 'hand-1', actorId: t.annId });
  expect(hand.schedule).toEqual({ phases: [{ kind: 'deal', handId: 'hand-1', street: 'preflop', startsAt: seatedAt + 5000, endsAt: seatedAt + 6500, durationMs: 1500 }],
    actionWindow: { participantId: t.annId, decisionId: 'hand-1/decision-1', opensAt: seatedAt + 6500, deadlineAt: seatedAt + 6500 + 30_000 } });
  // Ben joined unseated, so he watches the Hand without being dealt in.
  expect(participant(await t.view(ben.cookie), ben.participantId)).toEqual({ participantId: ben.participantId, seat: null, stack: 0, sittingOut: false });
  await expect.poll(() => updates(annLive).at(-1)?.view.state.handId).toBe('hand-1');
});

test('after each Hand the payout phase and a 3 s pause pass before the next countdown is announced, and the server keeps dealing while the table can', async () => {
  const t = await onlineTable();
  await dealtHeadsUp(t);
  await act(t, annOnly(t), { type: 'fold' });
  const finished = await t.view();
  const paidAt = clock.now();
  expect(finished.view.state).toMatchObject({ status: 'completed-hand', handId: 'hand-1' });
  expect(finished.schedule.phases.slice(-2)).toEqual([
    { kind: 'payout', handId: 'hand-1', street: 'preflop', startsAt: paidAt, endsAt: paidAt + 2000, durationMs: 2000 },
    { kind: 'pause', handId: 'hand-1', street: 'preflop', startsAt: paidAt + 2000, endsAt: paidAt + 5000, durationMs: 3000 },
  ]);
  expect(chipsAtTable(finished)).toBe(2000);
  // Nothing is announced during the payout phase or the pause.
  clock.advanceTo(paidAt + 4999);
  expect((await t.view()).schedule.nextHandCountdown).toBeUndefined();
  clock.advanceTo(paidAt + 5000);
  await expect.poll(async () => (await t.view()).schedule.nextHandCountdown).toEqual({ startsAt: paidAt + 5000, endsAt: paidAt + 10_000, durationMs: 5000 });
  clock.advanceTo(paidAt + 10_000);
  await expect.poll(async () => (await t.view()).view.state.handId).toBe('hand-2');
  const second = await t.view();
  // The button moves on, so the Bot is first to act; every chip is still at the table.
  expect(second.view.state).toMatchObject({ status: 'active-hand', actorId: t.botIds[0] });
  expect(second.schedule.nextHandCountdown).toBeUndefined();
  expect(chipsAtTable(second)).toBe(2000);
});

test('when a countdown expires, humans still disconnected are sat out first, and without two Eligible Participants including a human the countdown is cancelled until a commit or a connection makes the table dealable again', async () => {
  const t = await onlineTable();
  const ben = await t.join('Ben');
  const annLive = await t.connect(), benLive = await t.connect(ben.cookie);
  await t.seat(t.ann, t.annId, 1); await t.seat(ben.cookie, ben.participantId, 2); await t.seat(t.ann, t.botIds[0]!, 3);
  const { endsAt } = await announcedCountdown(() => t.view());
  // A disconnect does not cancel the countdown: eligibility is rechecked when it expires.
  await benLive.close();
  await expect.poll(async () => (await t.view()).connectedParticipantIds).toEqual([t.annId]);
  expect((await t.view()).schedule.nextHandCountdown?.endsAt).toBe(endsAt);
  clock.advanceTo(endsAt);
  await expect.poll(async () => (await t.view()).view.state.handId).toBe('hand-1');
  const hand = await t.view();
  expect(participant(hand, ben.participantId)).toEqual({ participantId: ben.participantId, seat: 2, stack: 1000, sittingOut: true });
  expect(participant(hand, t.annId)).toMatchObject({ inHand: true });
  expect(participant(hand, t.botIds[0]!)).toMatchObject({ inHand: true });
  // Ann folds; then she too is gone when the pause ends, so no countdown is announced.
  clock.advance(1500);
  await act(t, annOnly(t), { type: 'fold' });
  await annLive.close();
  clock.advance(10_000);
  const idle = await t.view();
  expect(idle.schedule.nextHandCountdown).toBeUndefined();
  expect(idle.view.state.status).toBe('completed-hand');
  // Her connection makes the table dealable again: a fresh countdown is announced.
  const back = await t.connect();
  await expect.poll(async () => (await t.view()).schedule.nextHandCountdown?.startsAt).toBe(clock.now());
  // She disconnects again before it expires: she is sat out, only the Bot remains, and the countdown is cancelled.
  await back.close();
  const before = await t.view();
  clock.advanceTo(before.schedule.nextHandCountdown!.endsAt);
  await expect.poll(async () => participant(await t.view(), t.annId).sittingOut).toBe(true);
  const cancelled = await t.view();
  expect(cancelled.schedule.nextHandCountdown).toBeUndefined();
  expect(cancelled.view.state).toMatchObject({ status: 'completed-hand', handId: 'hand-1' });
  expect(cancelled.sessionRevision).toBeGreaterThan(before.sessionRevision);
  // Reconnecting does not resume her: resuming is always explicit, and only that commit announces a fresh countdown.
  await t.connect();
  await expect.poll(async () => (await t.view()).connectedParticipantIds).toEqual([t.annId]);
  expect((await t.view()).schedule.nextHandCountdown).toBeUndefined();
  expect((await t.as(t.ann, 'set-sitting-out', { participantId: t.annId, sittingOut: false })).status).toBe(200);
  expect((await t.view()).schedule.nextHandCountdown).toEqual({ startsAt: clock.now(), endsAt: clock.now() + 5000, durationMs: 5000 });
  clock.advance(5000);
  await expect.poll(async () => (await t.view()).view.state.handId).toBe('hand-2');
  expect(participant(await t.view(), ben.participantId)).toEqual({ participantId: ben.participantId, seat: 2, stack: 1000, sittingOut: true });
});

test('connection status is public and transient: it counts any of a Guest’s connections, is published live to everyone, changes no revision, and is lost by a restart', async () => {
  const t = await onlineTable();
  const ben = await t.join('Ben');
  const benLive = await t.connect(ben.cookie);
  const annPhone = await t.connect(), annLaptop = await t.connect();
  const presence = () => benLive.messages.filter(message => message.type === 'table-presence');
  await expect.poll(async () => (await t.view(ben.cookie)).connectedParticipantIds).toEqual([t.annId, ben.participantId]);
  const before = await t.view();
  expect(presence().at(-1)).toEqual({ type: 'table-presence', tableSessionId: t.id, connectedParticipantIds: [t.annId, ben.participantId] });
  // Closing one of Ann's devices changes nothing: she is connected until her last connection ends.
  const published = presence().length;
  await annPhone.close();
  expect((await t.view(ben.cookie)).connectedParticipantIds).toEqual([t.annId, ben.participantId]);
  await annLaptop.close();
  await expect.poll(() => presence().at(-1)).toEqual({ type: 'table-presence', tableSessionId: t.id, connectedParticipantIds: [ben.participantId] });
  expect(presence()).toHaveLength(published + 1);
  expect(await t.view()).toMatchObject({ connectedParticipantIds: [ben.participantId], pokerRevision: before.pokerRevision, sessionRevision: before.sessionRevision });
  // A restart drops every connection; nobody counts as connected until they reconnect.
  await server.close(); await startServer();
  expect((await t.view(ben.cookie)).connectedParticipantIds).toEqual([]);
  await t.connect(ben.cookie);
  await expect.poll(async () => (await t.view()).connectedParticipantIds).toEqual([ben.participantId]);
});

test('every Online Table enforces its Action Time Limit: a missed deadline plays the Timeout Action, later missed decisions in the Hand time out too, the human is sat out after the Hand, and resuming is explicit', async () => {
  const t = await onlineTable([]);
  const ben = await t.join('Ben');
  await t.connect(); await t.connect(ben.cookie);
  const cookieOf = (id: string) => id === t.annId ? t.ann : ben.cookie;
  await t.seat(t.ann, t.annId, 1); await t.seat(ben.cookie, ben.participantId, 2);
  await dealt(t);
  // Ann (button) calls; Ben, the big blind, lets every deadline of his pass.
  await act(t, cookieOf, { type: 'call' });
  const waiting = await t.view();
  expect(waiting.schedule.actionWindow).toMatchObject({ participantId: ben.participantId, deadlineAt: waiting.schedule.actionWindow!.opensAt + 30_000 });
  clock.advanceTo(waiting.schedule.actionWindow!.deadlineAt! + 1);
  await expect.poll(async () => (await t.view()).pendingChanges).toEqual([{ participantId: ben.participantId, change: 'sit-out' }]);
  // Ben is still in the Hand; the Timeout Action checked for him, and he is sat out only after the Hand.
  const timedOut = await t.view();
  expect(timedOut.view.history[0]!.decisions.map(decision => decision.action)).toEqual([{ participantId: t.annId, action: { type: 'call' } }, { participantId: ben.participantId, action: { type: 'check' } }]);
  expect(participant(timedOut, ben.participantId)).toMatchObject({ inHand: true, sittingOut: false });
  // A late action is refused and explained.
  const late = await post('/api/table-sessions/' + t.id + '/act', ben.cookie, { requestId: randomUUID(), expectedPokerRevision: waiting.pokerRevision, participantId: ben.participantId, action: { type: 'check' } });
  expect({ status: late.status, code: (await late.json()).rejection?.code }).toEqual({ status: 409, code: 'action-deadline-passed' });
  // On every later street Ben acts first and times out again, and Ann checks behind.
  for (const street of ['flop', 'turn', 'river']) {
    clock.advance(1000);
    const next = await t.view();
    expect(next.view.state).toMatchObject({ street, actorId: ben.participantId });
    clock.advanceTo(next.schedule.actionWindow!.deadlineAt! + 1);
    await expect.poll(async () => (await t.view()).view.state.actorId).toBe(t.annId);
    await act(t, cookieOf, { type: 'check' });
  }
  const finished = await t.view();
  expect(finished.view.state.status).toBe('completed-hand');
  expect(finished.view.history[0]!.decisions.filter(decision => decision.action.participantId === ben.participantId).map(decision => decision.action.action)).toEqual([{ type: 'check' }, { type: 'check' }, { type: 'check' }, { type: 'check' }]);
  expect(finished.pendingChanges).toEqual([{ participantId: ben.participantId, change: 'sit-out' }]);
  // When the payout phase ends Ben sits out, even though he is still connected, so nothing is dealt.
  clock.advanceTo(finished.schedule.phases.find(phase => phase.kind === 'payout')!.endsAt);
  await expect.poll(async () => participant(await t.view(), ben.participantId).sittingOut).toBe(true);
  clock.advance(60_000);
  expect(await t.view()).toMatchObject({ pendingChanges: [], view: { state: { status: 'completed-hand', handId: 'hand-1' } } });
  expect((await t.view()).schedule.nextHandCountdown).toBeUndefined();
  // Resuming is his to ask for; then play continues.
  expect((await t.as(ben.cookie, 'set-sitting-out', { participantId: ben.participantId, sittingOut: false })).status).toBe(200);
  clock.advance(5000);
  await expect.poll(async () => (await t.view()).view.state.handId).toBe('hand-2');
  expect(participant(await t.view(), ben.participantId)).toMatchObject({ inHand: true, sittingOut: false });
});

test('a human who disconnects mid-Hand stays in it under a running deadline, reconnecting in time continues normally, and a Guest seated mid-Hand is dealt in from the next Hand', async () => {
  const t = await onlineTable();
  const ben = await t.join('Ben'), cy = await t.join('Cy');
  await t.connect();
  const benLive = await t.connect(ben.cookie);
  await t.connect(cy.cookie);
  const cookieOf = (id: string) => id === t.annId ? t.ann : id === ben.participantId ? ben.cookie : undefined;
  await t.seat(t.ann, t.annId, 1); await t.seat(ben.cookie, ben.participantId, 2); await t.seat(t.ann, t.botIds[0]!, 3);
  await dealt(t);
  // Ben drops out mid-Hand: he stays in it, and Cy takes a Seat for the next Hand.
  await benLive.close();
  await expect.poll(async () => (await t.view()).connectedParticipantIds).toEqual([t.annId, cy.participantId]);
  await t.seat(cy.cookie, cy.participantId, 4);
  const dropped = await t.view();
  expect(participant(dropped, ben.participantId)).toMatchObject({ inHand: true, sittingOut: false });
  expect(participant(dropped, cy.participantId)).toEqual({ participantId: cy.participantId, seat: 4, stack: 1000, sittingOut: false });
  // Ann, on the button, acts first three-handed; Ben's deadline then runs while he is away, and he is back in time.
  await act(t, cookieOf, { type: 'call' });
  const benToAct = await t.view();
  expect(benToAct.view.state.actorId).toBe(ben.participantId);
  clock.advanceTo(benToAct.schedule.actionWindow!.deadlineAt! - 1);
  await t.connect(ben.cookie);
  await act(t, cookieOf, { type: 'fold' });
  // Rex, the big blind, checks; the Hand runs to a showdown without Ben, and the next Hand deals all four.
  await act(t, cookieOf, { type: 'check' });
  for (let street = 0; street < 3; street++) {
    clock.advance(1000);
    await act(t, cookieOf, { type: 'check' });
    await act(t, cookieOf, { type: 'check' });
  }
  const finished = await t.view();
  expect(finished.view.state.status).toBe('completed-hand');
  expect(finished.pendingChanges).toEqual([]);
  clock.advanceTo(finished.schedule.phases.at(-1)!.endsAt);
  await expect.poll(async () => (await t.view()).schedule.nextHandCountdown).toBeDefined();
  await dealt(t, 'hand-2');
  const second = await t.view();
  for (const id of [t.annId, ben.participantId, t.botIds[0]!, cy.participantId]) expect(participant(second, id)).toMatchObject({ inHand: true, sittingOut: false });
});

test('a countdown survives a restart, and one that expired during the outage runs its recheck once: everyone counts as disconnected, so the humans are sat out and nothing is dealt', async () => {
  const t = await onlineTable();
  const ben = await t.join('Ben');
  const annLive = await t.connect(), benLive = await t.connect(ben.cookie);
  await t.seat(t.ann, t.annId, 1); await t.seat(ben.cookie, ben.participantId, 2); await t.seat(t.ann, t.botIds[0]!, 3);
  const countdown = await announcedCountdown(() => t.view());
  // A restart before it expires keeps the countdown; a Guest who reconnects in time is dealt in.
  await annLive.close(); await benLive.close();
  await server.close(); clock.advance(1000); await startServer();
  expect((await t.view()).schedule.nextHandCountdown).toEqual(countdown);
  const annBack = await t.connect();
  await dealt(t);
  const hand = await t.view();
  expect(participant(hand, t.annId)).toMatchObject({ inHand: true });
  expect(participant(hand, ben.participantId)).toMatchObject({ sittingOut: true });
  await act(t, annOnly(t), { type: 'fold' });
  clock.advanceTo((await t.view()).schedule.phases.at(-1)!.endsAt);
  await expect.poll(async () => (await t.view()).schedule.nextHandCountdown).toBeDefined();
  const next = await t.view();
  // The server is down when the next countdown expires.
  await annBack.close();
  await server.close();
  clock.advanceTo(next.schedule.nextHandCountdown!.endsAt + 60_000);
  await startServer();
  // The restarted server has already run the recheck when it serves its first request.
  const recovered = await t.view();
  expect(recovered.schedule.nextHandCountdown).toBeUndefined();
  expect(recovered.view.state).toMatchObject({ status: 'completed-hand', handId: 'hand-1' });
  expect(participant(recovered, t.annId)).toMatchObject({ sittingOut: true });
  expect(chipsAtTable(recovered)).toBe(3000);
  await server.close(); await startServer();
  clock.advance(60_000);
  expect(await t.view()).toMatchObject({ pokerRevision: recovered.pokerRevision, sessionRevision: recovered.sessionRevision });
  expect((await controllers.readPersistedSession(t.id))!.pokerRecord.commands.filter(command => command.type === 'start-hand')).toHaveLength(1);
});

test('an Action Deadline that expired during an outage plays one Timeout Action at startup, whose sit-out applies after the Hand, without duplicating it, the payout or a Hand start', async () => {
  const t = await onlineTable();
  const live = await dealtHeadsUp(t);
  const waiting = await t.view();
  expect(waiting.view.state.actorId).toBe(t.annId);
  await live.close();
  await server.close();
  clock.advanceTo(waiting.schedule.actionWindow!.deadlineAt! + 60_000);
  await startServer();
  const resumed = await t.view();
  // Preflop Ann faces the big blind, so her Timeout Action folded. The Hand is presented from the restart on.
  expect(resumed.view.history[0]!.decisions.map(decision => decision.action)).toEqual([{ participantId: t.annId, action: { type: 'fold' } }]);
  expect(resumed.pendingChanges).toEqual([{ participantId: t.annId, change: 'sit-out' }]);
  clock.advanceTo(resumed.schedule.phases.find(phase => phase.kind === 'payout')!.endsAt);
  await expect.poll(async () => participant(await t.view(), t.annId).sittingOut).toBe(true);
  const settled = await t.view();
  expect(settled).toMatchObject({ pendingChanges: [], view: { state: { status: 'completed-hand', handId: 'hand-1' } } });
  expect(settled.schedule.nextHandCountdown).toBeUndefined();
  expect(chipsAtTable(settled)).toBe(2000);
  for (let restart = 0; restart < 2; restart++) { await server.close(); clock.advance(30_000); await startServer(); }
  expect(await t.view()).toMatchObject({ pokerRevision: settled.pokerRevision, sessionRevision: settled.sessionRevision });
  const commands = (await controllers.readPersistedSession(t.id))!.pokerRecord.commands;
  expect(commands.filter(command => command.type === 'act')).toHaveLength(1);
  expect(commands.filter(command => command.type === 'start-hand')).toHaveLength(1);
});

test('a deal that could not be saved is tried again shortly and starts exactly one Hand', async () => {
  const t = await onlineTable();
  await t.connect();
  let failures = 0;
  beforeCommit = async ({ tableSessionId, requestId }) => { if (tableSessionId === t.id && requestId.startsWith('deal:') && failures++ === 0) throw new Error('controlled deal rollback'); };
  onTestFinished(() => { beforeCommit = async () => {}; });
  await t.seat(t.ann, t.annId, 1); await t.seat(t.ann, t.botIds[0]!, 2);
  const { endsAt } = await announcedCountdown(() => t.view());
  const before = await t.view();
  clock.advanceTo(endsAt);
  await expect.poll(() => failures).toBe(1);
  expect((await t.view()).pokerRevision).toBe(before.pokerRevision);
  await expect.poll(async () => { clock.advance(250); return (await t.view()).view.state.handId; }).toBe('hand-1');
  expect(failures).toBe(2);
  expect((await t.view()).pokerRevision).toBe(before.pokerRevision + 1);
  expect((await controllers.readPersistedSession(t.id))!.pokerRecord.commands.filter(command => command.type === 'start-hand')).toHaveLength(1);
});
