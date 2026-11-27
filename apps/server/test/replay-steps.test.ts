import { afterAll, beforeAll, expect, test } from 'vitest';
import { nameGuest } from './fixtures/guest.js';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { baselinePlayingStrategy, type ConcreteAction, type ObservableTableSession, type ReplayStep, type TableHandReplay } from '@poker/contracts';
import { createServer } from '../src/server.js';
import type { TableSessionControllerCommands } from '../src/mutations.js';
import { ManualClock } from './fixtures/clock.js';
import { announcedCountdown, connectLive } from './fixtures/online.js';
import { presentedFor } from './fixtures/phases.js';

// A completed Hand's Replay Steps (ADR-0041), read under Table History's access rules.
const clock = new ManualClock();

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('Set TEST_DATABASE_URL to a real PostgreSQL test database.');
const schema = 'test_' + randomUUID().replaceAll('-', '');
const administration = new Pool({ connectionString: databaseUrl });
let server: Awaited<ReturnType<typeof createServer>>;
let base: string;
let controller: TableSessionControllerCommands;
async function start() {
  server = await createServer({ journalConnectionTimeoutMs: 10_000, clock, automaticBots: false, databaseUrl: databaseUrl!, schema, onControllerCommandsReady: commands => { controller = commands; } });
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
type Table = { id: string; owner: string; player: string; bot: string };
async function create(cookie: string, contents: object): Promise<Table> {
  const response = await post('/api/table-sessions', cookie, { requestId: randomUUID(), bots: [{ name: 'Rex', playingStrategy: baselinePlayingStrategy }], ...contents });
  expect(response.status).toBe(201);
  const created = await response.json();
  return { id: created.tableSessionId, owner: cookie, player: created.bindings[0].participantId, bot: created.bindings[1].participantId };
}
const read = async (t: Table, cookie = t.owner): Promise<ObservableTableSession> => (await get('/api/table-sessions/' + t.id, cookie)).json();
const replayOf = (t: Table, handId: string, cookie = t.owner) => get('/api/table-sessions/' + t.id + '/history/' + handId, cookie);
const replayed = async (t: Table, handId = 'hand-1', cookie = t.owner): Promise<TableHandReplay> => { const response = await replayOf(t, handId, cookie); expect(response.status).toBe(200); return response.json(); };
async function command(t: Table, cookie: string, kind: string, contents: object = {}) {
  const response = await post('/api/table-sessions/' + t.id + '/' + kind, cookie, { requestId: randomUUID(), expectedPokerRevision: (await read(t, cookie)).pokerRevision, ...contents });
  expect(response.status).toBe(200);
}
const playerAct = async (t: Table, action: ConcreteAction) => { clock.settle(); await command(t, t.owner, 'act', { participantId: t.player, action }); };
const botAct = async (t: Table, action: ConcreteAction) => { clock.settle(); expect(await controller.submitAction(t.id, { requestId: randomUUID(), expectedPokerRevision: (await read(t)).pokerRevision, participantId: t.bot, action })).toMatchObject({ ok: true }); };
/** A Practice Table with the player on the button and the Bot in the big blind. */
async function practice(): Promise<Table> {
  const t = await create(await guest('Ann'), {});
  await command(t, t.owner, 'seat-participant', { participantId: t.player, seat: 1 });
  await command(t, t.owner, 'seat-participant', { participantId: t.bot, seat: 4 });
  return t;
}
const deal = async (t: Table) => { clock.settle(); await command(t, t.owner, 'start-hand'); };
const outline = (steps: readonly ReplayStep[]) => steps.map(step => [step.kind, step.state.street, step.state.actorId]);
/** Who shows hole cards at each step. */
const holders = (steps: readonly ReplayStep[]) => steps.map(step => step.state.participants.filter(p => p.holeCards).map(p => p.participantId));

test('a Participant reads a completed Hand\'s Replay Steps, their own decisions marked, with no hand shown before the showdown reveals it', async () => {
  const t = await practice();
  await deal(t);
  await playerAct(t, { type: 'call' }); await botAct(t, { type: 'check' });
  for (let street = 0; street < 3; street++) { await botAct(t, { type: 'check' }); await playerAct(t, { type: 'check' }); }
  const replay = await replayed(t);
  expect(replay).toMatchObject({ tableSessionId: t.id, mode: 'practice', viewerParticipantId: t.player, handId: 'hand-1', hand: { handId: 'hand-1', handNumber: 1, viewerDealtIn: true, dealtIn: [{ participantId: t.player, name: 'Ann' }, { participantId: t.bot, name: 'Rex' }] }, configuration: { seatCount: 6, smallBlind: 10, bigBlind: 20 } });
  expect(replay.participants).toEqual([{ participantId: t.player, name: 'Ann', bot: false }, { participantId: t.bot, name: 'Rex', bot: true }]);
  expect(outline(replay.steps)).toEqual([
    ['decision', 'preflop', t.player], ['decision', 'preflop', t.bot],
    ['street', 'flop', null], ['decision', 'flop', t.bot], ['decision', 'flop', t.player],
    ['street', 'turn', null], ['decision', 'turn', t.bot], ['decision', 'turn', t.player],
    ['street', 'river', null], ['decision', 'river', t.bot], ['decision', 'river', t.player],
    ['result', 'river', null],
  ]);
  // Ann's own decisions are marked with their DecisionIds, the Bot's are not.
  expect(replay.steps.map(step => step.viewerDecisionId)).toEqual(replay.steps.map(step => step.kind === 'decision' && step.state.actorId === t.player ? step.state.decisionId : undefined));
  // Rex's cards stay hidden until the result reveals them.
  expect(holders(replay.steps)).toEqual([...Array(11).fill([t.player]), [t.player, t.bot]]);
  expect(replay.steps.at(-1)!.transition).toMatchObject({ showdown: { shown: [{ participantId: t.player, cardCount: 2 }, { participantId: t.bot, cardCount: 2 }] }, payout: { awards: expect.any(Array) } });
  expect(JSON.stringify(replay)).not.toMatch(/"(?:seed|deck|burns|commands|userId|ownerUserId)"\s*:/);
});

test("a Hand's replay holds no board, result or revealed cards outside its result step", async () => {
  const t = await practice();
  await deal(t);
  await playerAct(t, { type: 'call' }); await botAct(t, { type: 'check' });
  for (let street = 0; street < 3; street++) { await botAct(t, { type: 'check' }); await playerAct(t, { type: 'check' }); }
  const replay = await replayed(t);
  const result = replay.steps.at(-1)!;
  const earlier = replay.steps.slice(0, -1);
  // The Hand row the replay carries is only its number, completion time and who was dealt in.
  expect(Object.keys(replay.hand).filter(key => key !== 'completedAt').sort()).toEqual(['dealtIn', 'handId', 'handNumber', 'viewerDealtIn']);
  expect(replay.hand.dealtIn.every(dealt => Object.keys(dealt).sort().join() === 'name,participantId')).toBe(true);
  // How it ended is on the result step alone: the board it ended on, the showdown, who won, and Rex's revealed cards.
  expect(earlier.some(step => 'result' in step)).toBe(false);
  expect(result.kind).toBe('result');
  const finalBoard = result.state.board;
  expect(finalBoard).toHaveLength(5);
  expect(result.result).toMatchObject({ board: finalBoard, showdown: true, payouts: expect.any(Array) });
  const rex = result.state.participants.find(p => p.participantId === t.bot)!.holeCards!;
  expect(result.result!.holeCards).toEqual(expect.arrayContaining([{ participantId: t.bot, cards: rex }]));
  // Before it, each step shows the board revealed so far, no payout, and none of Rex's cards.
  const revealed = { preflop: 0, flop: 3, turn: 4, river: 5 } as const;
  for (const step of earlier) {
    expect(step.state.board).toEqual(finalBoard.slice(0, revealed[step.state.street ?? 'preflop']));
    expect(step.state.payouts ?? []).toEqual([]);
    expect(step.transition.payout).toBeUndefined();
    expect(step.transition.showdown).toBeUndefined();
    expect(step.state.status).not.toBe('completed-hand');
  }
  const outside = JSON.stringify({ ...replay, steps: earlier });
  for (const card of rex) expect(outside).not.toContain(JSON.stringify(card));
  expect(outside).not.toMatch(/"(?:showdown|result)"|"payouts":\[\{/);
});

test('an all-in Hand has a Replay Step after each runout street, and a result step', async () => {
  const t = await practice();
  await deal(t);
  const raise = (await read(t)).view.state.legalActions.find(action => action.type === 'raise')!;
  await playerAct(t, { type: 'raise', raiseTo: 'maximum' in raise ? raise.maximum : 0 });
  await botAct(t, { type: 'call' });
  const { steps } = await replayed(t);
  expect(outline(steps)).toEqual([['decision', 'preflop', t.player], ['decision', 'preflop', t.bot], ['street', 'flop', null], ['street', 'turn', null], ['street', 'river', null], ['result', 'river', null]]);
  expect(steps.map(step => step.transition.street?.cardCount)).toEqual([undefined, undefined, 3, 1, 1, undefined]);
  expect(holders(steps)).toEqual([[t.player], [t.player], [t.player], [t.player], [t.player], [t.player, t.bot]]);
});

test('every Participant reads the same steps of an Online Table\'s Hand, a late joiner included; anyone else is refused, as is a Hand that is not complete', async () => {
  const ann = await guest('Ann');
  const t = await create(ann, { mode: 'online', configuration: { seatCount: 3, smallBlind: 10, bigBlind: 20, minimumBuyIn: 200, defaultBuyIn: 500, maximumBuyIn: 1000 } });
  await command(t, ann, 'seat-participant', { participantId: t.bot, seat: 1 });
  await command(t, ann, 'seat-participant', { participantId: t.player, seat: 2, buyIn: 300 });
  await connectLive(base, ann, t.id);
  clock.advanceTo((await announcedCountdown(() => read(t))).endsAt);
  await expect.poll(async () => (await read(t)).view.state.handId).toBe('hand-1');
  clock.advance(presentedFor('deal', 'online'));
  expect((await read(t)).view.state.actorId).toBe(t.bot);
  await botAct(t, { type: 'fold' });
  const ben = await guest('Ben');
  const joined = await (await post('/api/table-sessions/' + t.id + '/join-table', ben, { requestId: randomUUID() })).json();
  const owners = await replayed(t), late = await replayed(t, 'hand-1', ben);
  expect(owners).toMatchObject({ mode: 'online', viewerParticipantId: t.player, hand: { handNumber: 1, viewerDealtIn: true } });
  expect(outline(owners.steps)).toEqual([['decision', 'preflop', t.bot], ['result', 'preflop', null]]);
  // Ben joined after the Hand: the same steps, nobody's cards, and none of them his decisions.
  expect(late).toMatchObject({ viewerParticipantId: joined.participantId, hand: { handNumber: 1, viewerDealtIn: false } });
  expect(late.steps.map(step => [step.kind, step.state.board, step.transition])).toEqual(owners.steps.map(step => [step.kind, step.state.board, step.transition]));
  expect(holders(late.steps)).toEqual([[], []]);
  expect(late.steps.some(step => step.viewerDecisionId)).toBe(false);
  // A User who never joined learns nothing, not even that the table exists.
  const cy = await guest('Cy');
  for (const response of [await replayOf(t, 'hand-1', cy), await get('/api/table-sessions/' + randomUUID() + '/history/hand-1', cy)]) {
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ ok: false, rejection: { code: 'not-found' } });
  }
  // A Participant asking for a Hand that is not complete, or not there, is told so.
  clock.advance(presentedFor('payout', 'online'));
  clock.advanceTo((await announcedCountdown(() => read(t))).endsAt);
  await expect.poll(async () => (await read(t)).view.state.handId).toBe('hand-2');
  for (const handId of ['hand-2', 'hand-7']) {
    const response = await replayOf(t, handId);
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ ok: false, rejection: { code: 'hand-not-found' } });
  }
  expect((await get('/api/table-sessions/' + t.id + '/history/hand-1', '')).status).toBe(401);
});

test('every Replay Step\'s actor, and everyone whose decision a step records, is among the replay\'s named participants, a Bot removed since included', async () => {
  const ann = await guest('Ann');
  const t = await create(ann, { bots: [{ name: 'Rex', playingStrategy: baselinePlayingStrategy }, { name: 'Kit', playingStrategy: baselinePlayingStrategy }] });
  const kit = (await read(t)).bindings[2]!.participantId;
  await command(t, ann, 'seat-participant', { participantId: t.player, seat: 1 });
  await command(t, ann, 'seat-participant', { participantId: t.bot, seat: 2 });
  await command(t, ann, 'seat-participant', { participantId: kit, seat: 3 });
  await deal(t);
  // Everyone checks or calls the Hand down to a showdown, so each of the three makes decisions on every street.
  for (let current = await read(t); current.view.state.status === 'active-hand'; current = await read(t)) {
    // A Bot's legal actions are not in Ann's view: it checks when nobody has bet more than it this street, else calls.
    const { actorId: actor, participants } = current.view.state, wager = (id: string | null) => participants.find(p => p.participantId === id)?.wager ?? 0;
    const action: ConcreteAction = { type: participants.every(p => wager(p.participantId) <= wager(actor)) ? 'check' : 'call' };
    if (actor === t.player) await playerAct(t, action);
    else { clock.settle(); expect(await controller.submitAction(t.id, { requestId: randomUUID(), expectedPokerRevision: (await read(t)).pokerRevision, participantId: actor!, action })).toMatchObject({ ok: true }); }
  }
  clock.settle();
  await command(t, ann, 'remove-bot', { participantId: kit });
  expect((await read(t)).view.state.participants.find(p => p.participantId === kit)?.seat ?? null).toBeNull();

  const replay = await replayed(t);
  expect(replay.participants).toEqual([{ participantId: t.player, name: 'Ann', bot: false }, { participantId: t.bot, name: 'Rex', bot: true }, { participantId: kit, name: 'Kit', bot: true }]);
  const named = new Map(replay.participants.map(participant => [participant.participantId, participant.name]));
  const actors = replay.steps.flatMap(step => [...step.kind === 'decision' ? [step.state.actorId] : [], ...step.transition.acted ? [step.transition.acted.participantId] : []]);
  expect(new Set(actors)).toEqual(new Set([t.player, t.bot, kit]));
  for (const actor of actors) expect(named.get(actor!)).toMatch(/\S/);
});

test('reading a Hand\'s Replay Steps does not load the table', async () => {
  const t = await practice();
  await deal(t);
  await playerAct(t, { type: 'fold' });
  await server.close(); await start();
  expect(controller.loadedTables()).not.toContain(t.id);
  expect((await replayed(t)).steps.at(-1)!.kind).toBe('result');
  expect(controller.loadedTables()).not.toContain(t.id);
});
