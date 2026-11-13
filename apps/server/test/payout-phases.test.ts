import { afterAll, beforeAll, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import WebSocket from 'ws';
import { baselinePlayingStrategy, payoutBeats, type ConcreteAction, type ObservableGameConfiguration, type ObservableTableSession, type ObservableTableUpdate, type ServerLiveMessage } from '@poker/contracts';
import { createServer } from '../src/server.js';
import type { TableSessionControllerCommands } from '../src/mutations.js';
import { nameGuest } from './fixtures/guest.js';
import { ManualClock } from './fixtures/clock.js';
import { backToBack, lengthOf, presentedFor, presentedShowdownFor, settleOf, windowOpensAt } from './fixtures/phases.js';
import { showdownMs, streetMs } from './fixtures/presentation.js';

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

type Table = { id: string; cookie: string; ids: string[]; revision: number };
async function table(count = 2, configuration: Partial<ObservableGameConfiguration> = {}): Promise<Table> {
  const cookie = (await fetch(base + '/api/identity')).headers.get('set-cookie')!.split(';')[0]!; await nameGuest(base, cookie);
  const response = await fetch(base + '/api/table-sessions', { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ requestId: randomUUID(), configuration, bots: Array.from({ length: count - 1 }, (_, i) => ({ name: 'Bot ' + (i + 1), playingStrategy: baselinePlayingStrategy })) }) });
  expect(response.status).toBe(201); const created = await response.json();
  return { id: created.tableSessionId, cookie, ids: created.bindings.map((b: { participantId: string }) => b.participantId), revision: 0 };
}
const submit = (t: Table, kind: string, fields: object, requestId: string = randomUUID()) => fetch(base + '/api/table-sessions/' + t.id + '/' + kind, { method: 'POST', headers: { 'content-type': 'application/json', cookie: t.cookie }, body: JSON.stringify({ requestId, expectedPokerRevision: t.revision, ...fields }) });
const read = async (t: Table): Promise<ObservableTableSession> => (await (await fetch(base + '/api/table-sessions/' + t.id, { headers: { cookie: t.cookie } })).json());
async function command(t: Table, kind: string, fields: object = {}) {
  const response = await submit(t, kind, fields); expect(response.status).toBe(200);
  const result = await response.json(); t.revision = result.pokerRevision; return result;
}
/** The human acts through HTTP; Bots through the trusted controller commands. */
async function act(t: Table, participantId: string, action: ConcreteAction) {
  if (participantId === t.ids[0]) return submit(t, 'act', { participantId, action });
  const outcome = await controllers.submitAction(t.id, { requestId: randomUUID(), expectedPokerRevision: t.revision, participantId, action });
  return Response.json(outcome, { status: outcome.ok ? 200 : 409 });
}
async function accepted(t: Table, participantId: string, action: ConcreteAction) {
  const response = await act(t, participantId, action); expect(response.status).toBe(200);
  t.revision = (await response.json()).pokerRevision;
}
async function headsUp() {
  const t = await table(2); const [human, bot] = t.ids as [string, string];
  await command(t, 'seat-participant', { participantId: human, seat: 1 }); await command(t, 'seat-participant', { participantId: bot, seat: 4 });
  return { t, human, bot };
}
/**
 * What the view's payout presents, and so how long it lasts: a showdown may split the pot, and each winner's award
 * takes its own beat.
 */
function paidFor(view: ObservableTableSession) {
  const payout = view.schedule.phases.find(phase => phase.kind === 'payout');
  if (payout?.kind !== 'payout') throw new Error('The Hand has no payout phase.');
  expect(payout.inputs.awards.length).toBeGreaterThan(0);
  return { durationMs: payoutBeats(payout.inputs).totalMs, inputs: payout.inputs };
}

/** Deals and checks every street down: the Hand ends at showdown on the river. */
async function checkDown(t: Table, human: string, bot: string) {
  await command(t, 'start-hand'); clock.advanceTo(windowOpensAt(await read(t)));
  await accepted(t, human, { type: 'call' }); await accepted(t, bot, { type: 'check' });
  for (const _street of ['flop', 'turn', 'river']) { clock.advanceTo(windowOpensAt(await read(t))); await accepted(t, bot, { type: 'check' }); await accepted(t, human, { type: 'check' }); }
}

/** Deals, the human raises and the Bot folds: the Hand is over at once. */
async function foldOut(t: Table, human: string, bot: string) {
  await command(t, 'start-hand'); clock.advance(presentedFor('deal'));
  await accepted(t, human, { type: 'raise', raiseTo: 60 });
  await accepted(t, bot, { type: 'fold' });
}

test('a river showdown turns the hands up, then pays out, each followed by its Settle', async () => {
  const { t, human, bot } = await headsUp();
  await checkDown(t, human, bot);
  const at = clock.now();
  const done = await read(t);
  expect(done.view.state).toMatchObject({ status: 'completed-hand', actorId: null });
  expect(done.view.state.participants.every(p => p.holeCards?.length === 2)).toBe(true);
  // The river was checked through: the showdown sweeps nothing and turns both hands up, in the order they are shown.
  const inputs = { swept: [], shown: [{ participantId: human, cardCount: 2 }, { participantId: bot, cardCount: 2 }] };
  const shown = at + showdownMs(0), turned = shown + settleOf('showdown'), payout = paidFor(done), paid = turned + payout.durationMs;
  expect(done.schedule.phases.slice(-4)).toEqual([
    { kind: 'showdown', handId: 'hand-1', street: 'river', startsAt: at, endsAt: shown, durationMs: showdownMs(0), inputs },
    { kind: 'settle', handId: 'hand-1', street: 'river', startsAt: shown, endsAt: turned, durationMs: settleOf('showdown') },
    { kind: 'payout', handId: 'hand-1', street: 'river', startsAt: turned, endsAt: paid, ...payout },
    { kind: 'settle', handId: 'hand-1', street: 'river', startsAt: paid, endsAt: paid + settleOf('payout'), durationMs: settleOf('payout') },
  ]);
  expect(done.schedule.actionWindow).toBeNull();
});

test('Deal is rejected with its own code until the Settle after the payout ends, and accepted at that moment', async () => {
  const { t, human, bot } = await headsUp();
  await checkDown(t, human, bot);
  const ends = clock.now() + presentedShowdownFor(0) + paidFor(await read(t)).durationMs + settleOf('payout');
  clock.advanceTo(ends - 1);
  const before = await read(t);
  const early = await submit(t, 'start-hand', {});
  expect(early.status).toBe(409);
  expect(await early.json()).toMatchObject({ ok: false, rejection: { code: 'payout-phase-not-ended' } });
  expect(await read(t)).toEqual(before);
  clock.advanceTo(ends);
  await command(t, 'start-hand');
  expect((await read(t)).view.state).toMatchObject({ status: 'active-hand', handId: 'hand-2' });
});

test('an all-in runout reaches a live client as one complete result, ahead of the steps that present it', async () => {
  const { t, human, bot } = await headsUp();
  const socket = new WebSocket(base.replace('http:', 'ws:') + '/api/live', { headers: { cookie: t.cookie } });
  const updates: ObservableTableUpdate[] = [];
  socket.on('message', data => { const message = JSON.parse(data.toString()) as ServerLiveMessage; if (message.type === 'table-update') updates.push(message); });
  socket.on('open', () => socket.send(JSON.stringify({ type: 'subscribe-table', requestId: randomUUID(), tableSessionId: t.id })));
  try {
    await command(t, 'start-hand'); clock.advance(presentedFor('deal'));
    await accepted(t, human, { type: 'raise', raiseTo: 1000 });
    await accepted(t, bot, { type: 'call' });
    await expect.poll(() => updates.some(update => update.pokerRevision === t.revision)).toBe(true);
    const update = updates.find(candidate => candidate.pokerRevision === t.revision)!;
    // Nothing is left to decide, so this update already holds the whole board and the pot awards; the schedule says when each is presented.
    expect(update.view.state).toMatchObject({ status: 'completed-hand', actorId: null });
    expect(update.view.state.board).toHaveLength(5);
    expect(update.view.state.payouts?.length).toBeGreaterThan(0);
    expect(update.presentationEvents.map(event => event.type)).toEqual(expect.arrayContaining(['hole-cards-revealed', 'board-dealt', 'pot-awarded', 'hand-completed']));
    expect(update.schedule.phases.map(phase => phase.kind)).toEqual(['deal', 'settle', 'showdown', 'settle', 'street', 'settle', 'street', 'settle', 'street', 'settle', 'payout', 'settle']);
    expect(update.schedule.phases.at(-1)!.startsAt).toBeGreaterThan(update.serverTime);
  } finally { socket.terminate(); }
});

test('a three-way all-in with side pots schedules one showdown, the remaining streets and one payout, and keeps every chip', async () => {
  const t = await table(3, { minimumBuyIn: 100 });
  const [human, short, middle] = t.ids as [string, string, string];
  await command(t, 'seat-participant', { participantId: human, seat: 1 });
  await command(t, 'seat-participant', { participantId: short, seat: 3, buyIn: 300 });
  await command(t, 'seat-participant', { participantId: middle, seat: 5, buyIn: 500 });
  await command(t, 'start-hand'); clock.advance(presentedFor('deal', 'practice', 3));
  // Each player in turn puts in everything they can.
  for (let step = 0; step < 6; step++) {
    const { actorId, legalActions } = (await read(t)).view.state;
    if (!actorId) break;
    const sized = legalActions.find(a => a.type === 'raise' || a.type === 'bet');
    await accepted(t, actorId, !sized || !('maximum' in sized) ? { type: 'call' } : sized.type === 'bet' ? { type: 'bet', betTo: sized.maximum } : { type: 'raise', raiseTo: sized.maximum });
  }
  const at = clock.now();
  const done = await read(t);
  expect(done.view.state).toMatchObject({ status: 'completed-hand', actorId: null });
  expect(done.view.state.pots.length).toBeGreaterThanOrEqual(2);
  const total = (transfers: readonly { amount: number }[] = []) => transfers.reduce((sum, transfer) => sum + transfer.amount, 0);
  expect(total(done.view.state.payouts) + total(done.view.state.returns)).toBe(done.view.state.participants.reduce((sum, p) => sum + (p.contribution ?? 0), 0));
  expect(done.view.state.participants.reduce((sum, p) => sum + p.stack, 0)).toBe(1800);
  expect(done.schedule.phases.map(({ kind, street, startsAt, endsAt, durationMs }) => ({ kind, street, startsAt, endsAt, durationMs }))).toEqual(backToBack(at - presentedFor('deal', 'practice', 3), [
    ['deal', 'preflop', lengthOf('deal', 3)], ['settle', 'preflop', settleOf('deal')],
    ['showdown', 'preflop', showdownMs(3, 3)], ['settle', 'preflop', settleOf('showdown')],
    ['street', 'flop', streetMs(0, 3)], ['settle', 'flop', settleOf('street')],
    ['street', 'turn', streetMs(0, 1)], ['settle', 'turn', settleOf('street')],
    ['street', 'river', streetMs(0, 1)], ['settle', 'river', settleOf('street')],
    ['payout', 'river', paidFor(done).durationMs], ['settle', 'river', settleOf('payout')],
  ]));
  expect(done.schedule.actionWindow).toBeNull();
});

test('a Hand won by folds has a payout phase and its Settle but no showdown, and Deal waits for the Settle', async () => {
  const { t, human, bot } = await headsUp();
  await foldOut(t, human, bot);
  const at = clock.now();
  const done = await read(t);
  expect(done.view.state).toMatchObject({ status: 'completed-hand' });
  expect(done.view.state.participants.find(p => p.participantId === bot)).not.toHaveProperty('holeCards');
  const dealt = at - presentedFor('deal'), paid = at + lengthOf('payout'), ends = paid + settleOf('payout');
  expect(done.schedule.phases.map(({ kind, street, startsAt, endsAt }) => ({ kind, street, startsAt, endsAt }))).toEqual([
    { kind: 'deal', street: 'preflop', startsAt: dealt, endsAt: dealt + lengthOf('deal') },
    { kind: 'settle', street: 'preflop', startsAt: dealt + lengthOf('deal'), endsAt: at },
    { kind: 'payout', street: 'preflop', startsAt: at, endsAt: paid },
    { kind: 'settle', street: 'preflop', startsAt: paid, endsAt: ends },
  ]);
  clock.advanceTo(paid);
  expect(await (await submit(t, 'start-hand', {})).json()).toMatchObject({ ok: false, rejection: { code: 'payout-phase-not-ended' } });
  clock.advanceTo(ends - 1);
  expect((await submit(t, 'start-hand', {})).status).toBe(409);
  clock.advanceTo(ends);
  await command(t, 'start-hand');
});

test('a payout carries what each winner won and what came back uncalled, and lasts as long as its beats', async () => {
  const { t, human, bot } = await headsUp();
  // The human's raise to 60 is called by no one: 40 of it comes back, and the blinds' 40 are won.
  await foldOut(t, human, bot);
  const payout = (await read(t)).schedule.phases.find(phase => phase.kind === 'payout');
  const inputs = { awards: [{ participantId: human, won: 40, returned: 40 }] };
  expect(payout).toMatchObject({ kind: 'payout', inputs, durationMs: payoutBeats(inputs).totalMs });
  expect(payout!.endsAt - payout!.startsAt).toBe(payout!.durationMs);
});

test('a restart keeps the payout phase and its Settle, so Deal still waits for them; a Deal after them needs no wait', async () => {
  const { t, human, bot } = await headsUp();
  await foldOut(t, human, bot);
  const at = clock.now();
  const paying = await read(t);
  clock.advanceTo(at + 1000);
  await server.close(); await startServer();
  expect(await read(t)).toEqual({ ...paying, serverTime: at + 1000 });
  expect((await submit(t, 'start-hand', {})).status).toBe(409);
  clock.advanceTo(at + presentedFor('payout'));
  await server.close(); await startServer();
  await command(t, 'start-hand');
  expect((await read(t)).view.state).toMatchObject({ status: 'active-hand', handId: 'hand-2' });
});

test('Deal resumes a human who sat out by choice in the same commit that starts the Hand', async () => {
  const { t, human, bot } = await headsUp();
  await foldOut(t, human, bot);
  // Sitting out is a change between Hands: during the payout phase it would only be recorded to apply after it.
  clock.advance(presentedFor('payout'));
  await command(t, 'set-sitting-out', { participantId: human, sittingOut: true });
  expect((await read(t)).view.state.participants.find(p => p.participantId === human)).toMatchObject({ sittingOut: true });
  const revision = t.revision;
  const dealt = await command(t, 'start-hand');
  expect(dealt.pokerRevision).toBe(revision + 1);
  const state = (await read(t)).view.state;
  expect(state).toMatchObject({ status: 'active-hand', handId: 'hand-2' });
  expect(state.participants.find(p => p.participantId === human)).toMatchObject({ sittingOut: false, inHand: true });
  expect((await controllers.readPersistedSession(t.id))!.pokerRecord.commands.slice(-2).map(c => c.type)).toEqual(['set-sitting-out', 'start-hand']);
});

test('a Deal that cannot start the Hand leaves the sitting-out human sitting out', async () => {
  const { t, human, bot } = await headsUp();
  await foldOut(t, human, bot);
  clock.advance(presentedFor('payout'));
  await command(t, 'set-sitting-out', { participantId: human, sittingOut: true });
  await command(t, 'stand-up-participant', { participantId: bot });
  const before = await read(t);
  const rejected = await submit(t, 'start-hand', {});
  expect(rejected.status).toBe(400);
  expect(await rejected.json()).toMatchObject({ ok: false, rejection: { code: 'insufficient-participants' } });
  expect(await read(t)).toEqual(before);
  expect(before.view.state.participants.find(p => p.participantId === human)).toMatchObject({ sittingOut: true });
});
