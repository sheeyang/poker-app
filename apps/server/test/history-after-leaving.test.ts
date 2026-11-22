import { afterAll, beforeAll, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import WebSocket from 'ws';
import { highestProbabilityPlayingStrategy, baselinePlayingStrategy, defaultPlayingStrategy, strategyToken, supportedStrategies, type DecisionAnalysis, type TableHandReplay, type ObservableTableSession, type ScoreSummary, type ServerLiveMessage, type StrategyDescriptor, type TableHistory } from '@poker/contracts';
import { createServer } from '../src/server.js';
import type { TableSessionControllerCommands } from '../src/mutations.js';
import { idleTableCloseMs, idleTableSweepMs } from '../src/closing.js';
import { nameGuest } from './fixtures/guest.js';
import { ManualClock } from './fixtures/clock.js';
import { handEndsAt } from './fixtures/phases.js';
import { announcedCountdown, connectLive, type LiveConnection } from './fixtures/online.js';

// Online Tables always have Action Deadlines, so time moves only when a test moves it.
const clock = new ManualClock();
const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('Set TEST_DATABASE_URL to a real PostgreSQL test database.');
const schema = 'test_' + randomUUID().replaceAll('-', '');
const administration = new Pool({ connectionString: databaseUrl });
let server: Awaited<ReturnType<typeof createServer>>;
let base: string;
let controller: TableSessionControllerCommands;
beforeAll(async () => {
  await administration.query('CREATE SCHEMA "' + schema + '"');
  server = await createServer({ clock, automaticBots: false, databaseUrl: databaseUrl!, schema, onControllerCommandsReady: commands => { controller = commands; } });
  base = await server.listen({ host: '127.0.0.1', port: 0 });
});
afterAll(async () => { await server?.close(); await administration.query('DROP SCHEMA "' + schema + '" CASCADE'); await administration.end(); });

const minute = 60_000;
const loaded = (id: string) => controller.loadedTables().includes(id);
/** Each cookie is a separate Guest. */
async function guest(name: string) {
  const cookie = (await fetch(base + '/api/identity')).headers.get('set-cookie')!.split(';')[0]!;
  await nameGuest(base, cookie, name);
  return cookie;
}
const get = (path: string, cookie: string) => fetch(base + path, { headers: { cookie } });
const post = (path: string, cookie: string, body: unknown) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(body) });
const stakes = { seatCount: 3, smallBlind: 10, bigBlind: 20, minimumBuyIn: 1000, defaultBuyIn: 1000, maximumBuyIn: 1000 };

/**
 * Ann's Online Table, with Ben and Cy joined through its Join Link. All three are connected and seated, so the table
 * deals by itself. Every decision each human makes is recorded, by Decision ID.
 */
async function threeHanded() {
  const ann = await guest('Ann');
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
  const live: LiveConnection[] = [];
  for (const player of players) live.push(await connectLive(base, player.cookie, id));
  for (const [seat, player] of players.entries()) expect((await as(player.cookie, 'seat-participant', { participantId: player.participantId, seat: seat + 1 })).status).toBe(200);
  const cookieOf = (participantId: string) => players.find(player => player.participantId === participantId)!.cookie;
  const decisions = new Map<string, string[]>();
  /** Deals the next Hand, then every actor checks or calls it down to a showdown, and the Hand ends. */
  async function playHand(handId: string) {
    await expect.poll(async () => (await view()).schedule.nextHandCountdown).toBeDefined();
    clock.advanceTo((await announcedCountdown(() => view())).endsAt);
    await expect.poll(async () => (await view()).view.state.handId).toBe(handId);
    for (let current = await view(); current.view.state.status === 'active-hand'; current = await view()) {
      const window = current.schedule.actionWindow!;
      if (clock.now() < window.opensAt) clock.advanceTo(window.opensAt);
      const actor = window.participantId, own = await view(cookieOf(actor));
      decisions.set(actor, [...decisions.get(actor) ?? [], window.decisionId]);
      const action = own.view.state.legalActions.some(legal => legal.type === 'check') ? 'check' : 'call';
      expect((await as(cookieOf(actor), 'act', { participantId: actor, action: { type: action } })).status).toBe(200);
    }
    clock.advanceTo(handEndsAt(await view()));
  }
  return { id, ann: a, ben: b, cy: c, view, as, live, playHand, decisions };
}
const history = (id: string, cookie: string) => get('/api/table-sessions/' + id + '/history', cookie);
const listed = async (id: string, cookie: string): Promise<TableHistory> => { const response = await history(id, cookie); expect(response.status).toBe(200); return response.json(); };
const refusal = async (response: Response) => ({ status: response.status, code: (await response.json()).rejection?.code });
/** A Guest's user channel alone: the live connection that tells them of their own analyses, at no table. */
async function userChannel(cookie: string) {
  const socket = new WebSocket(base.replace('http:', 'ws:') + '/api/live', { headers: { cookie } });
  const messages: ServerLiveMessage[] = [];
  socket.on('message', data => messages.push(JSON.parse(data.toString())));
  socket.on('error', () => {});
  await expect.poll(() => messages[0]).toEqual({ type: 'user-channel-ready' });
  return { messages, close: () => socket.terminate() };
}
/** Sets the Guest's own Trainer Configuration, which applies at every table. */
const study = async (cookie: string, referenceStrategy: StrategyDescriptor) => expect((await fetch(base + '/api/trainer-configuration', { method: 'PUT', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ requestId: randomUUID(), trainerConfiguration: { referenceStrategy, liveAnalysis: true } }) })).status).toBe(200);
/**
 * Requests analysis of the Guest's own decision under a Reference Strategy nothing has analyzed it under yet, and waits
 * for it to complete; the Guest's user channel is told.
 */
async function analyzed(id: string, cookie: string, decisionId: string, referenceStrategy: StrategyDescriptor = baselinePlayingStrategy) {
  await study(cookie, referenceStrategy);
  const channel = await userChannel(cookie);
  try {
    const response = await post('/api/table-sessions/' + id + '/analysis', cookie, { decisionId });
    expect(response.status).toBe(200);
    const { requestId } = await response.json() as DecisionAnalysis;
    await expect.poll(async () => ((await (await get('/api/table-sessions/' + id + '/analysis/' + requestId, cookie)).json()) as DecisionAnalysis).status).toBe('complete');
    await expect.poll(() => channel.messages.some(message => message.type === 'analysis-update' && message.requestId === requestId && message.status === 'complete')).toBe(true);
  } finally { channel.close(); }
}
/** Requests a summary of the Guest's own decisions and waits for it to complete. */
async function summarized(id: string, cookie: string, path: 'hand-summaries' | 'session-summaries', body: object) {
  const response = await post('/api/table-sessions/' + id + '/' + path, cookie, body);
  expect(response.status).toBe(200);
  const { requestId } = await response.json() as ScoreSummary;
  await expect.poll(async () => ((await (await get('/api/table-sessions/' + id + '/summaries/' + requestId, cookie)).json()) as ScoreSummary).status).toBe('complete');
}

test('a Guest who left, and a Guest who was removed, read the whole Table History, Hands completed after they left included, and study their own decisions; they cannot act there', async () => {
  const t = await threeHanded();
  await t.playHand('hand-1');
  // Ben leaves between Hands; Ann and Cy play on.
  expect((await t.as(t.ben.cookie, 'leave-table', { participantId: t.ben.participantId })).status).toBe(200);
  await t.playHand('hand-2');
  // Then Ann removes Cy.
  expect((await t.as(t.ann.cookie, 'remove-participant', { participantId: t.cy.participantId })).status).toBe(200);

  const ben = await listed(t.id, t.ben.cookie), cy = await listed(t.id, t.cy.cookie);
  expect(ben).toMatchObject({ viewerParticipantId: t.ben.participantId, mode: 'online', seatCount: 3, stakes: { smallBlind: 10, bigBlind: 20, ante: 0 }, left: true });
  expect(ben).not.toHaveProperty('closed');
  expect(ben.hands.map(hand => [hand.handNumber, hand.viewerDealtIn])).toEqual([[1, true], [2, false]]);
  // Ben's own cards in the Hand he was dealt; Hand 2 went to a showdown he was not in, which revealed Ann's and Cy's.
  expect(ben.hands[0]!.dealtIn.find(player => player.participantId === t.ben.participantId)!.holeCards).toHaveLength(2);
  expect(ben.hands[1]!.dealtIn.map(player => player.participantId)).not.toContain(t.ben.participantId);
  expect(cy).toMatchObject({ viewerParticipantId: t.cy.participantId, left: true });
  expect(cy.hands.map(hand => [hand.handNumber, hand.viewerDealtIn])).toEqual([[1, true], [2, true]]);
  expect(await listed(t.id, t.ann.cookie)).not.toHaveProperty('left');

  // Study keeps working: analysis of their own decisions, and summaries, complete.
  await analyzed(t.id, t.ben.cookie, t.decisions.get(t.ben.participantId)![0]!);
  await analyzed(t.id, t.cy.cookie, t.decisions.get(t.cy.participantId)!.at(-1)!);
  await summarized(t.id, t.ben.cookie, 'hand-summaries', { handId: 'hand-1' });
  await summarized(t.id, t.cy.cookie, 'session-summaries', {});
  // Nobody studies another's decision.
  expect(await refusal(await post('/api/table-sessions/' + t.id + '/analysis', t.ben.cookie, { decisionId: t.decisions.get(t.cy.participantId)![0]! }))).toEqual({ status: 400, code: 'decision-unavailable' });

  // They cannot see the live table, act, sit or change anything there.
  for (const former of [t.ben, t.cy]) {
    expect((await get('/api/table-sessions/' + t.id, former.cookie)).status).toBe(404);
    for (const [kind, fields] of [['seat-participant', { participantId: former.participantId, seat: 3 }], ['act', { participantId: former.participantId, action: { type: 'fold' } }], ['leave-table', { participantId: former.participantId }]] as const)
      expect(await refusal(await post('/api/table-sessions/' + t.id + '/' + kind, former.cookie, { requestId: randomUUID(), expectedPokerRevision: (await t.view()).pokerRevision, ...fields }))).toEqual({ status: 404, code: 'not-found' });
    expect(await refusal(await post('/api/table-sessions/' + t.id + '/set-table-options', former.cookie, { requestId: randomUUID(), expectedSessionRevision: (await t.view()).sessionRevision, options: { allowLiveAnalysis: false } }))).toEqual({ status: 404, code: 'not-found' });
  }
  // A Guest who was never a Participant learns nothing.
  const dee = await guest('Dee');
  expect(await refusal(await history(t.id, dee))).toEqual({ status: 404, code: 'not-found' });
  expect(await refusal(await post('/api/table-sessions/' + t.id + '/session-summaries', dee, {}))).toEqual({ status: 404, code: 'not-found' });
});

test('reading a table one has left, and studying there, loads nothing; once it is a Closed Table every former Participant still reads and studies it, read-only', async () => {
  const t = await threeHanded();
  await t.playHand('hand-1');
  expect((await t.as(t.ben.cookie, 'leave-table', { participantId: t.ben.participantId })).status).toBe(200);
  // Nobody is connected and nothing is scheduled, so the table leaves memory.
  for (const player of [t.ann, t.cy]) expect((await t.as(player.cookie, 'stand-up-participant', { participantId: player.participantId })).status).toBe(200);
  for (const connection of t.live) await connection.close();
  // The unload grace starts once the server has seen the connections end, so time moves until it has run.
  await expect.poll(() => { clock.advance(minute); return loaded(t.id); }).toBe(false);

  expect((await listed(t.id, t.ben.cookie)).hands).toHaveLength(1);
  await analyzed(t.id, t.ben.cookie, t.decisions.get(t.ben.participantId)![0]!);
  await summarized(t.id, t.ben.cookie, 'session-summaries', {});
  expect(loaded(t.id)).toBe(false);

  // A day without a committed change closes it, unloaded.
  clock.advance(idleTableCloseMs + idleTableSweepMs);
  await expect.poll(async () => (await listed(t.id, t.ann.cookie)).closed).toBe(true);
  for (const former of [t.ann, t.ben, t.cy]) {
    const read = await listed(t.id, former.cookie);
    expect(read).toMatchObject({ viewerParticipantId: former.participantId, closed: true, left: true });
    expect(read.hands.map(hand => hand.handNumber)).toEqual([1]);
  }
  // Study at a Closed Table writes only derived analysis.
  const before = (await administration.query('SELECT aggregate FROM "' + schema + '".table_sessions WHERE id = $1', [t.id])).rows[0].aggregate;
  await analyzed(t.id, t.ann.cookie, t.decisions.get(t.ann.participantId)![0]!, highestProbabilityPlayingStrategy);
  await summarized(t.id, t.cy.cookie, 'hand-summaries', { handId: 'hand-1' });
  expect((await administration.query('SELECT aggregate FROM "' + schema + '".table_sessions WHERE id = $1', [t.id])).rows[0].aggregate).toEqual(before);
  expect(loaded(t.id)).toBe(false);
  // Nobody joins, opens or acts at it.
  expect(await refusal(await post('/api/table-sessions/' + t.id + '/join-table', t.ben.cookie, { requestId: randomUUID() }))).toEqual({ status: 410, code: 'table-closed' });
  expect((await get('/api/table-sessions/' + t.id, t.ann.cookie)).status).toBe(404);
  expect(await refusal(await post('/api/table-sessions/' + t.id + '/seat-participant', t.ann.cookie, { requestId: randomUUID(), expectedPokerRevision: 0, participantId: t.ann.participantId, seat: 1 }))).toEqual({ status: 404, code: 'not-found' });
  expect(await refusal(await history(t.id, await guest('Dee')))).toEqual({ status: 404, code: 'not-found' });
  expect(loaded(t.id)).toBe(false);
});

const replayOf = (id: string, handId: string, cookie: string) => get('/api/table-sessions/' + id + '/history/' + handId, cookie);
/** The Strategies a test can compare under that no post-action analysis has used: all but the default Reference Strategy. */
const counterfactuals = supportedStrategies.filter(strategy => strategyToken(strategy) !== strategyToken(defaultPlayingStrategy));
/**
 * Requests analysis of the Guest's own decision the way the replay does: from history, and under `strategy` when one is
 * named (Counterfactual Comparison), or the same without `history` for a named Strategy at `from: 'table'`. Waits for it
 * to complete, then reads and retries it. A fresh request under a named Strategy tells the Guest's user channel.
 */
async function studiedFromHistory(id: string, cookie: string, decisionId: string, strategy?: StrategyDescriptor, from: 'history' | 'table' = 'history') {
  const channel = await userChannel(cookie);
  try {
    const response = await post('/api/table-sessions/' + id + '/analysis', cookie, { decisionId, ...(from === 'history' ? { history: true } : {}), ...(strategy ? { strategy } : {}) });
    expect(response.status).toBe(200);
    const { requestId } = await response.json() as DecisionAnalysis;
    const read = () => get('/api/table-sessions/' + id + '/analysis/' + requestId, cookie);
    await expect.poll(async () => ((await (await read()).json()) as DecisionAnalysis).status).toBe('complete');
    if (strategy) await expect.poll(() => channel.messages.some(message => message.type === 'analysis-update' && message.requestId === requestId && message.status === 'complete')).toBe(true);
    const retried = await post('/api/table-sessions/' + id + '/analysis/' + requestId + '/retry', cookie, {});
    expect(retried.status).toBe(200);
    expect(await retried.json()).toMatchObject({ requestId, status: 'complete' });
    return requestId;
  } finally { channel.close(); }
}
/** A Guest who was never a Participant learns nothing of the table's Replay Steps or of anyone's study there. */
async function strangerRefused(id: string, decisionId: string, requestId: string) {
  const dee = await guest('Dee');
  expect(await refusal(await replayOf(id, 'hand-1', dee))).toEqual({ status: 404, code: 'not-found' });
  for (const body of [{ decisionId, history: true }, { decisionId, history: true, strategy: counterfactuals[0] }, { decisionId, strategy: counterfactuals[0] }])
    expect(await refusal(await post('/api/table-sessions/' + id + '/analysis', dee, body))).toEqual({ status: 404, code: 'not-found' });
  expect(await refusal(await get('/api/table-sessions/' + id + '/analysis/' + requestId, dee))).toEqual({ status: 404, code: 'not-found' });
  expect(await refusal(await post('/api/table-sessions/' + id + '/analysis/' + requestId + '/retry', dee, {}))).toEqual({ status: 404, code: 'not-found' });
}

test('a Guest who left and a Guest who was removed step through their Hands and study their own decisions from history, under a named Strategy too; nothing plays', async () => {
  const t = await threeHanded();
  await t.playHand('hand-1');
  expect((await t.as(t.ben.cookie, 'leave-table', { participantId: t.ben.participantId })).status).toBe(200);
  await t.playHand('hand-2');
  expect((await t.as(t.ann.cookie, 'remove-participant', { participantId: t.cy.participantId })).status).toBe(200);
  // Only Ann is left, so nothing deals: study must not change that.
  const before = await t.view();

  for (const former of [t.ben, t.cy]) {
    const response = await replayOf(t.id, 'hand-1', former.cookie);
    expect(response.status).toBe(200);
    const replay = await response.json() as TableHandReplay;
    expect(replay).toMatchObject({ tableSessionId: t.id, viewerParticipantId: former.participantId, mode: 'online', handId: 'hand-1' });
    expect(replay.steps.at(-1)!.kind).toBe('result');
    // Their own decisions in Hand 1 are marked: the first decision each made was there.
    const own = replay.steps.flatMap(step => step.viewerDecisionId ? [step.viewerDecisionId] : []);
    expect(own[0]).toBe(t.decisions.get(former.participantId)![0]);
    expect(t.decisions.get(former.participantId)).toEqual(expect.arrayContaining(own));
  }
  // Ben was not dealt into Hand 2, played after he left, and still steps through it, with no decisions of his own.
  const watched = await (await replayOf(t.id, 'hand-2', t.ben.cookie)).json() as TableHandReplay;
  expect(watched.steps.some(step => step.viewerDecisionId)).toBe(false);

  const benDecision = t.decisions.get(t.ben.participantId)![0]!, cyDecision = t.decisions.get(t.cy.participantId)!.at(-1)!;
  const requestId = await studiedFromHistory(t.id, t.ben.cookie, benDecision);
  await studiedFromHistory(t.id, t.ben.cookie, benDecision, counterfactuals[0]);
  await studiedFromHistory(t.id, t.cy.cookie, cyDecision);
  await studiedFromHistory(t.id, t.cy.cookie, cyDecision, counterfactuals[1]);
  // A named Strategy asked from the analysis panel rather than history works the same for a former Participant.
  await studiedFromHistory(t.id, t.cy.cookie, cyDecision, counterfactuals[2], 'table');
  // Each studies only their own decisions.
  expect(await refusal(await post('/api/table-sessions/' + t.id + '/analysis', t.ben.cookie, { decisionId: cyDecision, history: true, strategy: counterfactuals[0] }))).toEqual({ status: 400, code: 'decision-unavailable' });
  expect(await refusal(await get('/api/table-sessions/' + t.id + '/analysis/' + requestId, t.cy.cookie))).toEqual({ status: 404, code: 'not-found' });

  await strangerRefused(t.id, benDecision, requestId);
  const after = await t.view();
  expect({ pokerRevision: after.pokerRevision, handId: after.view.state.handId, status: after.view.state.status }).toEqual({ pokerRevision: before.pokerRevision, handId: before.view.state.handId, status: before.view.state.status });
});

test('at a table not in memory, and once it is a Closed Table, former Participants step through Hands and complete analysis from history under named Strategies, loading nothing and writing only derived analysis', async () => {
  const t = await threeHanded();
  await t.playHand('hand-1');
  expect((await t.as(t.ben.cookie, 'leave-table', { participantId: t.ben.participantId })).status).toBe(200);
  for (const player of [t.ann, t.cy]) expect((await t.as(player.cookie, 'stand-up-participant', { participantId: player.participantId })).status).toBe(200);
  for (const connection of t.live) await connection.close();
  await expect.poll(() => { clock.advance(minute); return loaded(t.id); }).toBe(false);
  const aggregate = async () => (await administration.query('SELECT aggregate FROM "' + schema + '".table_sessions WHERE id = $1', [t.id])).rows[0].aggregate;

  // Ben left a table nobody has open: his steps and his study load nothing.
  const left = await aggregate();
  expect((await replayOf(t.id, 'hand-1', t.ben.cookie)).status).toBe(200);
  const benDecision = t.decisions.get(t.ben.participantId)![0]!;
  await studiedFromHistory(t.id, t.ben.cookie, benDecision);
  await studiedFromHistory(t.id, t.ben.cookie, benDecision, counterfactuals[0]);
  expect(loaded(t.id)).toBe(false);
  expect(await aggregate()).toEqual(left);

  clock.advance(idleTableCloseMs + idleTableSweepMs);
  await expect.poll(async () => (await listed(t.id, t.ann.cookie)).closed).toBe(true);
  const closed = await aggregate();
  for (const [index, former] of [t.ann, t.ben, t.cy].entries()) {
    const replay = await (await replayOf(t.id, 'hand-1', former.cookie)).json() as TableHandReplay;
    expect(replay.viewerParticipantId).toBe(former.participantId);
    const decisionId = t.decisions.get(former.participantId)![0]!;
    expect(replay.steps.some(step => step.viewerDecisionId === decisionId)).toBe(true);
    // Fresh jobs, each accepted at the Closed Table: a Strategy nothing has analyzed this decision under yet.
    await studiedFromHistory(t.id, former.cookie, decisionId, counterfactuals[(index + 1) % counterfactuals.length]);
  }
  await studiedFromHistory(t.id, t.cy.cookie, t.decisions.get(t.cy.participantId)![0]!, counterfactuals[1], 'table');
  expect(await aggregate()).toEqual(closed);
  expect(loaded(t.id)).toBe(false);

  await strangerRefused(t.id, benDecision, (await (await post('/api/table-sessions/' + t.id + '/analysis', t.ben.cookie, { decisionId: benDecision, history: true })).json() as DecisionAnalysis).requestId);
  expect(loaded(t.id)).toBe(false);
  expect(await aggregate()).toEqual(closed);
});
