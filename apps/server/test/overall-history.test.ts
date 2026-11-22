import { afterAll, beforeAll, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { baselinePlayingStrategy, decisionStep, historyFilterParams, type ConcreteAction, type HistoryFilter, type ObservableTableSession, type OverallHistory, type OverallHistoryDecision, type TableHandReplay, type TableHistory } from '@poker/contracts';
import { createServer } from '../src/server.js';
import type { TableSessionControllerCommands } from '../src/mutations.js';
import { idleTableCloseMs, idleTableSweepMs } from '../src/closing.js';
import { nameGuest } from './fixtures/guest.js';
import { ManualClock } from './fixtures/clock.js';
import { handEndsAt } from './fixtures/phases.js';
import { announcedCountdown, connectLive } from './fixtures/online.js';

// Time stands still until a test moves it, so completion times are exactly the clock's time at the commit.
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
async function guest(name: string) {
  const cookie = (await fetch(base + '/api/identity')).headers.get('set-cookie')!.split(';')[0]!;
  await nameGuest(base, cookie, name);
  return cookie;
}
const get = (path: string, cookie: string) => fetch(base + path, { headers: { cookie } });
const post = (path: string, cookie: string, body: unknown) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(body) });
const loaded = (id: string) => controller.loadedTables().includes(id);

/** Overall History for a Guest, filtered by `filter` and paged by `page`. */
async function overall(cookie: string, filter: HistoryFilter = {}, page: { limit?: number; offset?: number } = {}): Promise<OverallHistory> {
  const query = new URLSearchParams({ ...historyFilterParams(filter), ...(page.limit !== undefined ? { limit: String(page.limit) } : {}), ...(page.offset !== undefined ? { offset: String(page.offset) } : {}) });
  const response = await get('/api/overall-history?' + query, cookie);
  expect(response.status).toBe(200);
  return response.json();
}
/** What a list shows of each decision, for comparing with what a test knows should be there. */
const summary = (decision: OverallHistoryDecision) => [decision.handNumber, decision.street, decision.position, decision.action.type, decision.potBigBlinds] as const;

// ---- Practice Tables played by script -------------------------------------------------------------------------------
type Table = { id: string; owner: string; human: string; bots: string[] };
async function practice(owner: string, seatCount: number, blinds = { smallBlind: 10, bigBlind: 20 }): Promise<Table> {
  const response = await post('/api/table-sessions', owner, { requestId: randomUUID(), configuration: { seatCount, ...blinds }, bots: Array.from({ length: seatCount - 1 }, (_, index) => ({ name: 'Bot' + (index + 1), playingStrategy: baselinePlayingStrategy })) });
  expect(response.status).toBe(201);
  const created = await response.json();
  const t: Table = { id: created.tableSessionId, owner, human: created.bindings[0].participantId, bots: created.bindings.slice(1).map((binding: { participantId: string }) => binding.participantId) };
  for (const [index, participantId] of [t.human, ...t.bots].entries()) await command(t, 'seat-participant', { participantId, seat: index + 1 });
  return t;
}
const read = async (t: Table): Promise<ObservableTableSession> => (await get('/api/table-sessions/' + t.id, t.owner)).json();
async function command(t: Table, kind: string, contents: object = {}) {
  const response = await post('/api/table-sessions/' + t.id + '/' + kind, t.owner, { requestId: randomUUID(), expectedPokerRevision: (await read(t)).pokerRevision, ...contents });
  expect(response.status).toBe(200);
}
const botAct = async (t: Table, participantId: string, action: ConcreteAction) => controller.submitAction(t.id, { requestId: randomUUID(), expectedPokerRevision: (await read(t)).pokerRevision, participantId, action });
/** The next decision is `who`'s (a Bot's index, or `'human'`) and they take `action`. */
async function turn(t: Table, who: 'human' | number, action: ConcreteAction) {
  clock.settle();
  const participantId = who === 'human' ? t.human : t.bots[who]!;
  expect((await read(t)).view.state.actorId).toBe(participantId);
  if (who === 'human') await command(t, 'act', { participantId, action });
  else expect(await botAct(t, participantId, action)).toMatchObject({ ok: true });
}
const deal = async (t: Table) => { clock.settle(); await command(t, 'start-hand'); clock.settle(); };
/**
 * Everyone checks, or calls what they must, until the Hand ends; with `foldAfterFlop` they fold once the flop is dealt, which
 * ends a Hand sooner (and a Guest decides at least once, preflop, whatever their seat).
 */
async function checkDown(t: Table, foldAfterFlop = false) {
  for (;;) {
    clock.settle();
    const view = await read(t), state = view.view.state, actor = state.actorId;
    if (state.status !== 'active-hand' || !actor) break;
    const folds = foldAfterFlop && state.street !== 'preflop';
    if (actor === t.human) {
      const action: ConcreteAction = { type: folds ? 'fold' : state.legalActions.some(legal => legal.type === 'check') ? 'check' : 'call' };
      expect((await post('/api/table-sessions/' + t.id + '/act', t.owner, { requestId: randomUUID(), expectedPokerRevision: view.pokerRevision, participantId: actor, action })).status).toBe(200);
    } else {
      const submit = (action: ConcreteAction) => controller.submitAction(t.id, { requestId: randomUUID(), expectedPokerRevision: view.pokerRevision, participantId: actor, action });
      if (folds) expect(await submit({ type: 'fold' })).toMatchObject({ ok: true });
      else if (!(await submit({ type: 'check' })).ok) expect(await submit({ type: 'call' })).toMatchObject({ ok: true });
    }
  }
  clock.settle();
}
/**
 * Three-handed, blinds 10/20, the Guest on the button (seat 1) with Bot1 the small blind and Bot2 the big blind. The Guest
 * raises to 60 and Bot1 folds; Bot2 re-raises to 180, which the Guest calls; on the flop Bot2 checks, the Guest bets 100
 * and Bot2 folds. The Guest decided three times: pot 30, 250 and 370 chips, which is 1.5, 12.5 and 18.5 big blinds.
 */
async function threeBet(t: Table) {
  await deal(t);
  await turn(t, 'human', { type: 'raise', raiseTo: 60 });
  await turn(t, 0, { type: 'fold' });
  await turn(t, 1, { type: 'raise', raiseTo: 180 });
  await turn(t, 'human', { type: 'call' });
  await turn(t, 1, { type: 'check' });
  await turn(t, 'human', { type: 'bet', betTo: 100 });
  await turn(t, 1, { type: 'fold' });
  clock.settle();
}
const threeBetDecisions = [[1, 'preflop', 'BTN', 'raise', 1.5], [1, 'preflop', 'BTN', 'call', 12.5], [1, 'flop', 'BTN', 'bet', 18.5]] as const;
/** The next Hand of that table: the Guest is in the big blind and everyone checks it down; the Guest decides four times at a pot of three big blinds. */
const checkedDownDecisions = [[2, 'preflop', 'BB', 'check', 3], [2, 'flop', 'BB', 'check', 3], [2, 'turn', 'BB', 'check', 3], [2, 'river', 'BB', 'check', 3]] as const;

test('a Guest with no tables has an empty Overall History, and a stranger to the service has none to read', async () => {
  expect(await overall(await guest('Zed'))).toEqual({ filter: {}, total: 0, offset: 0, decisions: [] });
  expect((await fetch(base + '/api/overall-history')).status).toBe(401);
});

test("Overall History lists the Guest's decisions in their own Hands, newest Hand first, each with the facts the filters use", async () => {
  const t = await practice(await guest('Ann'), 3);
  await threeBet(t);
  await deal(t);
  await checkDown(t);
  const { total, decisions } = await overall(t.owner);
  expect(total).toBe(7);
  expect(decisions.map(summary)).toEqual([...checkedDownDecisions, ...threeBetDecisions]);
  expect(decisions[0]).toMatchObject({ tableSessionId: t.id, mode: 'practice', handId: 'hand-2', handNumber: 2, seatCount: 3, stakes: { smallBlind: 10, bigBlind: 20 }, pot: 60 });
  expect(decisions.at(-1)).toMatchObject({ handId: 'hand-1', decisionId: 'hand-1/decision-6', pot: 370, holeCards: [expect.any(String), expect.any(String)] });
  expect(decisions.at(-1)!.board).toHaveLength(3);
  expect(decisions.every(decision => typeof decision.completedAt === 'number')).toBe(true);
});

// ---- an Online Table of three humans, played to a showdown, for tables the Guest has left or that have closed -------------
const stakes = { seatCount: 3, smallBlind: 10, bigBlind: 20, minimumBuyIn: 1000, defaultBuyIn: 1000, maximumBuyIn: 1000 };
const minute = 60_000;
/**
 * Ann's Online Table, with Ben and Cy joined and seated, all connected, so the table deals by itself. `playHand` checks or
 * calls the next Hand down to its end; `decisions` records every decision each human was asked for, by Decision ID.
 */
async function online(ann: string) {
  const created = await (await post('/api/table-sessions', ann, { requestId: randomUUID(), mode: 'online', configuration: stakes })).json();
  const id = created.tableSessionId as string;
  const players = [{ cookie: ann, participantId: created.bindings[0].participantId as string }];
  for (const name of ['Ben', 'Cy']) {
    const cookie = await guest(name);
    const joined = await (await post('/api/table-sessions/' + id + '/join-table', cookie, { requestId: randomUUID() })).json();
    players.push({ cookie, participantId: joined.participantId as string });
  }
  const [a, b, c] = players as [typeof players[number], typeof players[number], typeof players[number]];
  const view = async (cookie = ann): Promise<ObservableTableSession> => (await get('/api/table-sessions/' + id, cookie)).json();
  const as = async (cookie: string, kind: string, fields: object = {}) => post('/api/table-sessions/' + id + '/' + kind, cookie, { requestId: randomUUID(), expectedPokerRevision: (await view(cookie)).pokerRevision, ...fields });
  const live = [];
  for (const player of players) live.push(await connectLive(base, player.cookie, id));
  for (const [seat, player] of players.entries()) expect((await as(player.cookie, 'seat-participant', { participantId: player.participantId, seat: seat + 1 })).status).toBe(200);
  const cookieOf = (participantId: string) => players.find(player => player.participantId === participantId)!.cookie;
  const decisions = new Map<string, string[]>();
  async function playHand(handId: string) {
    await expect.poll(async () => (await view()).schedule.nextHandCountdown).toBeDefined();
    clock.advanceTo((await announcedCountdown(() => view())).endsAt);
    await expect.poll(async () => (await view()).view.state.handId).toBe(handId);
    for (let current = await view(); current.view.state.status === 'active-hand'; current = await view()) {
      const window = current.schedule.actionWindow!;
      if (clock.now() < window.opensAt) clock.advanceTo(window.opensAt);
      const actor = window.participantId, own = await view(cookieOf(actor));
      decisions.set(actor, [...decisions.get(actor) ?? [], window.decisionId]);
      expect((await as(cookieOf(actor), 'act', { participantId: actor, action: { type: own.view.state.legalActions.some(legal => legal.type === 'check') ? 'check' : 'call' } })).status).toBe(200);
    }
    clock.advanceTo(handEndsAt(await view()));
  }
  return { id, ann: a, ben: b, cy: c, view, as, live, playHand, decisions };
}
const ids = (decisions: readonly OverallHistoryDecision[]) => decisions.map(decision => decision.decisionId).sort();
const tableIds = (history: OverallHistory) => [...new Set(history.decisions.map(decision => decision.tableSessionId))].sort();

test("it reaches every table the Guest can read, Practice, left and Closed, only in Hands they were dealt into, and never shows another Guest's decisions or loads a table", async () => {
  const ann = await guest('Ann');
  const mine = await practice(ann, 3);
  await threeBet(mine);
  const t = await online(ann);
  await t.playHand('hand-1');
  // Ben leaves between Hands, so Hand 2 is one he was not dealt into; Ann and Cy play on.
  expect((await t.as(t.ben.cookie, 'leave-table', { participantId: t.ben.participantId })).status).toBe(200);
  await t.playHand('hand-2');
  const history = async (cookie: string, filter: HistoryFilter = {}) => overall(cookie, filter);

  // Each reads the decisions the table asked of them (an independent record), plus Ann's Practice Table; nobody sees another's.
  const annOnline = (await history(t.ann.cookie, { mode: ['online'] })).decisions, cy = await history(t.cy.cookie), ben = await history(t.ben.cookie);
  expect(ids(annOnline)).toEqual([...t.decisions.get(t.ann.participantId)!].sort());
  expect(ids(cy.decisions)).toEqual([...t.decisions.get(t.cy.participantId)!].sort());
  expect(ids(ben.decisions)).toEqual([...t.decisions.get(t.ben.participantId)!].sort());
  expect(new Set(ben.decisions.map(decision => decision.handId))).toEqual(new Set(['hand-1']));
  expect(tableIds(ben)).toEqual([t.id]);
  expect(cy.decisions.every(decision => decision.mode === 'online')).toBe(true);
  const annAll = await history(ann);
  expect(tableIds(annAll)).toEqual([mine.id, t.id].sort());
  expect(annAll.total).toBe(3 + annOnline.length);
  expect(ids(annAll.decisions.filter(decision => decision.tableSessionId === mine.id))).toEqual(['hand-1/decision-1', 'hand-1/decision-4', 'hand-1/decision-6']);
  // Modes narrow to one or the other.
  expect((await history(ann, { mode: ['practice'] })).decisions.every(decision => decision.tableSessionId === mine.id)).toBe(true);
  expect(ids((await history(ann, { mode: ['online'] })).decisions)).toEqual(ids(annOnline));
  // Someone who was never at either table has none of it.
  expect((await history(await guest('Dee'))).total).toBe(0);

  // Nobody is connected and nothing is scheduled: the table leaves memory, and reading its history never brings it back.
  for (const player of [t.ann, t.cy]) expect((await t.as(player.cookie, 'stand-up-participant', { participantId: player.participantId })).status).toBe(200);
  for (const connection of t.live) await connection.close();
  await expect.poll(() => { clock.advance(minute); return loaded(t.id); }).toBe(false);
  expect(ids((await history(t.ben.cookie)).decisions)).toEqual(ids(ben.decisions));
  expect(loaded(t.id)).toBe(false);
  // A day without a committed change closes it; every former Participant still reads their decisions there.
  clock.advance(idleTableCloseMs + idleTableSweepMs);
  await expect.poll(async () => ((await (await get('/api/table-sessions/' + t.id + '/history', t.ann.cookie)).json()) as TableHistory).closed).toBe(true);
  expect(ids((await history(t.ben.cookie)).decisions)).toEqual(ids(ben.decisions));
  expect(ids((await history(t.cy.cookie)).decisions)).toEqual(ids(cy.decisions));
  expect(ids((await history(ann, { mode: ['online'] })).decisions)).toEqual(ids(annOnline));
  expect(loaded(t.id)).toBe(false);
});

test('each filter narrows the list to the decisions that meet it, and filters together meet all of them', async () => {
  const t = await practice(await guest('Ann'), 3);
  await threeBet(t);
  await deal(t);
  await checkDown(t);
  const rows = async (filter: HistoryFilter) => (await overall(t.owner, filter)).decisions.map(summary);
  const all = [...checkedDownDecisions, ...threeBetDecisions];
  expect(await rows({})).toEqual(all);
  // Street.
  expect(await rows({ street: ['flop'] })).toEqual([checkedDownDecisions[1], threeBetDecisions[2]]);
  expect(await rows({ street: ['turn', 'river'] })).toEqual([checkedDownDecisions[2], checkedDownDecisions[3]]);
  // Position.
  expect(await rows({ position: ['BTN'] })).toEqual(threeBetDecisions);
  expect(await rows({ position: ['BB', 'SB'] })).toEqual(checkedDownDecisions);
  expect(await rows({ position: ['CO', 'UTG', 'BTN/SB'] })).toEqual([]);
  // Action type.
  expect(await rows({ action: ['raise'] })).toEqual([threeBetDecisions[0]]);
  expect(await rows({ action: ['bet', 'raise'] })).toEqual([threeBetDecisions[0], threeBetDecisions[2]]);
  expect(await rows({ action: ['call'] })).toEqual([threeBetDecisions[1]]);
  expect(await rows({ action: ['check'] })).toEqual(checkedDownDecisions);
  expect(await rows({ action: ['fold'] })).toEqual([]);
  // Table mode.
  expect(await rows({ mode: ['practice'] })).toEqual(all);
  expect(await rows({ mode: ['online'] })).toEqual([]);
  // Pot in big blinds as faced before the decision: the Guest's own raise faced 30 chips, the three-bet 250.
  expect(await rows({ pot: { max: 1.5 } })).toEqual([threeBetDecisions[0]]);
  expect(await rows({ pot: { min: 12.5 } })).toEqual([threeBetDecisions[1], threeBetDecisions[2]]);
  expect(await rows({ pot: { min: 3, max: 12.4 } })).toEqual(checkedDownDecisions);
  expect(await rows({ pot: { min: 12.6, max: 18.4 } })).toEqual([]);
  // Together.
  expect(await rows({ street: ['preflop'], pot: { min: 2 } })).toEqual([checkedDownDecisions[0], threeBetDecisions[1]]);
  expect(await rows({ position: ['BTN'], action: ['call', 'bet'], street: ['flop'] })).toEqual([threeBetDecisions[2]]);
  // The response names the filter it applied, normalized, and unknown values change nothing.
  const response = await get('/api/overall-history?street=river,flop,moon&position=nope&potMin=abc&mode=online,practice', t.owner);
  expect(((await response.json()) as OverallHistory).filter).toEqual({ street: ['flop', 'river'], mode: ['practice', 'online'] });
});

test('a date filter keeps only Hands with a completion time in range, and excludes Hands completed before times were recorded', async () => {
  const t = await practice(await guest('Ann'), 3);
  await threeBet(t);
  await server.close();
  await administration.query('UPDATE "' + schema + '".table_sessions SET aggregate = aggregate - \'handCompletedAt\' WHERE id = $1', [t.id]);
  await start();
  clock.advance(1000);
  const before = clock.now();
  await deal(t);
  await checkDown(t);
  const completedAt = ((await (await get('/api/table-sessions/' + t.id + '/history', t.owner)).json()) as TableHistory).hands[1]!.completedAt!;
  expect(completedAt).toBeGreaterThanOrEqual(before);
  const rows = async (filter: HistoryFilter) => (await overall(t.owner, filter)).decisions.map(summary);
  const all = [...checkedDownDecisions, ...threeBetDecisions];
  expect(await rows({})).toEqual(all);
  // The undated Hand 1 is in neither side of any date filter.
  expect(await rows({ completed: { min: 0 } })).toEqual(checkedDownDecisions);
  expect(await rows({ completed: { max: completedAt + 1e9 } })).toEqual(checkedDownDecisions);
  expect(await rows({ completed: { min: completedAt, max: completedAt } })).toEqual(checkedDownDecisions);
  expect(await rows({ completed: { min: completedAt + 1 } })).toEqual([]);
  expect(await rows({ completed: { max: completedAt - 1 } })).toEqual([]);
  // Undated Hands still list, and pass the other filters.
  expect(await rows({ street: ['preflop'] })).toEqual([checkedDownDecisions[0], threeBetDecisions[0], threeBetDecisions[1]]);
  // Undated Hands sort after dated ones.
  expect((await overall(t.owner)).decisions.map(decision => decision.handNumber)).toEqual([2, 2, 2, 2, 1, 1, 1]);
});

test.each([
  { seats: 2, positions: ['BTN/SB', 'BB'] },
  { seats: 3, positions: ['BTN', 'SB', 'BB'] },
  { seats: 6, positions: ['BTN', 'SB', 'BB', 'UTG', 'HJ', 'CO'] },
  { seats: 9, positions: ['BTN', 'SB', 'BB', 'UTG', 'UTG+1', 'UTG+2', 'LJ', 'HJ', 'CO'] },
])('at a $seats-Seat table the Guest, in seat 1, is every Position in turn as the button moves round', async ({ seats, positions }) => {
  const t = await practice(await guest('Ann'), seats);
  for (let hand = 1; hand <= seats; hand++) { await deal(t); await checkDown(t, true); }
  const { decisions } = await overall(t.owner);
  // The button starts at seat 1 and moves one seat each Hand, so in Hand h seat 1 is h - 1 seats short of it, clockwise.
  const positionIn = (handNumber: number) => decisions.filter(decision => decision.handNumber === handNumber).at(-1)!.position;
  expect(Array.from({ length: seats }, (_, index) => positionIn(index + 1))).toEqual(Array.from({ length: seats }, (_, index) => positions[(seats - index) % seats]));
  // A Hand has one Position, and the filter reads it.
  for (const handNumber of [1, 2]) expect(new Set(decisions.filter(decision => decision.handNumber === handNumber).map(decision => decision.position)).size).toBe(1);
  for (const position of positions) expect((await overall(t.owner, { position: [position as never] })).decisions.every(decision => decision.position === position)).toBe(true);
  expect((await overall(t.owner, { position: positions as never })).total).toBe(decisions.length);
}, 60_000);

test('opening a listed decision lands on its Replay Step, and a list pages in its own order', async () => {
  const t = await practice(await guest('Ann'), 3);
  await threeBet(t);
  await deal(t);
  await checkDown(t);
  const { decisions } = await overall(t.owner);
  const replays = new Map<string, TableHandReplay>();
  for (const decision of decisions) {
    if (!replays.has(decision.handId)) replays.set(decision.handId, await (await get('/api/table-sessions/' + t.id + '/history/' + decision.handId, t.owner)).json());
    const step = replays.get(decision.handId)!.steps.find(candidate => candidate.viewerDecisionId === decision.decisionId);
    expect(step, decision.decisionId).toBeDefined();
    // The step is the table as the decision opened: its street and board are the row's.
    expect(step!.state).toMatchObject({ street: decision.street, board: decision.board, decisionId: decision.decisionId });
    expect(decision.decisionId.endsWith('/' + decisionStep(decision.decisionId))).toBe(true);
  }
  const page = await overall(t.owner, {}, { limit: 3, offset: 2 });
  expect(page).toMatchObject({ total: 7, offset: 2 });
  expect(page.decisions).toEqual(decisions.slice(2, 5));
  expect((await overall(t.owner, {}, { limit: 3, offset: 9 })).decisions).toEqual([]);
  expect((await overall(t.owner, {}, { limit: 1000 })).decisions).toHaveLength(7);
});
