import { afterAll, beforeAll, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import WebSocket from 'ws';
import { baselinePlayingStrategy, defaultTrainerConfiguration, highestProbabilityPlayingStrategy, strategyToken, type AnalysisUpdate, type ConcreteAction, type ObservableGameView, type ObservableTableSession, type ProgressUpdate, type ScoreSummary, type ServerLiveMessage, type StrategyDescriptor } from '@poker/contracts';
import { HighestProbabilitySelector, type PolicyResult } from '@poker/strategies';
import { createServer } from '../src/server.js';
import type { TableSessionControllerCommands } from '../src/mutations.js';
import { InstantClock } from './fixtures/clock.js';
import { nameGuest } from './fixtures/guest.js';

// A table's Score Summaries on the user channel (ADR-0026, ADR-0041): while one is pending its count travels as
// `progress` of the `summary` resource, at most once a second per User, and its completion or failure is a notice that
// has the client read it again over HTTP. Every Presentation Phase ends at once; only the spacing of `progress`
// messages waits for the clock, which the tests move.
const clock = new InstantClock();
const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('Set TEST_DATABASE_URL to a real PostgreSQL test database.');
const administration = new Pool({ connectionString: databaseUrl });
const fixtures: { close(): Promise<void> }[] = [];
const sockets: WebSocket[] = [];
afterAll(async () => { for (const socket of sockets) socket.terminate(); await Promise.all(fixtures.map(fixture => fixture.close())); await administration.end(); });

/** One Reference Strategy Evaluation the fake Strategy was asked for. */
interface Evaluation { readonly view: ObservableGameView; readonly descriptor: StrategyDescriptor; readonly result: ReturnType<typeof Promise.withResolvers<PolicyResult>>; answered: boolean }
/** All the fake Strategy's probability is on checking or calling: a check or call scores 1, a fold 0. */
const settle = (view: ObservableGameView): PolicyResult => {
  const action = view.state.legalActions.find(legal => legal.type === 'check' || legal.type === 'call') ?? view.state.legalActions[0]!;
  return { choices: [{ action: { type: action.type } as ConcreteAction, probability: 1 }] };
};
const reference = highestProbabilityPlayingStrategy;
/** A Strategy named beside the Reference Strategy, as Table History's comparison names one. */
const compared = baselinePlayingStrategy;

/** A server whose fake Strategy answers at once, until `hold` makes it wait; `fail` makes the next evaluations fail. */
async function fixture() {
  const schema = 'test_' + randomUUID().replaceAll('-', '');
  await administration.query('CREATE SCHEMA "' + schema + '"');
  const evaluations: Evaluation[] = [];
  let holding = false, failing = 0;
  let controller!: TableSessionControllerCommands;
  const answer = (evaluation: Evaluation) => { evaluation.answered = true; evaluation.result.resolve(settle(evaluation.view)); };
  const server = await createServer({ journalConnectionTimeoutMs: 10_000, clock, databaseUrl: databaseUrl!, schema, automaticBots: false, jobRunnerOptions: { concurrency: 16, maximumQueued: 16 },
    onControllerCommandsReady: commands => { controller = commands; },
    strategyFactory: descriptor => ({ policy: { checkCompatibility: () => ({ compatible: true }), evaluate: view => {
      const evaluation: Evaluation = { view, descriptor, result: Promise.withResolvers<PolicyResult>(), answered: false };
      evaluations.push(evaluation);
      if (failing > 0) { failing--; evaluation.answered = true; evaluation.result.reject(new Error('Controlled Strategy failure.')); }
      else if (!holding) answer(evaluation);
      return evaluation.result.promise;
    } }, actionSelector: new HighestProbabilitySelector() }) });
  const base = await server.listen({ host: '127.0.0.1', port: 0 });
  const get = (path: string, cookie: string) => fetch(base + '/api' + path, { headers: { cookie } });
  const post = (path: string, cookie: string, body: unknown) => fetch(base + '/api' + path, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(body) });
  async function guest(name = 'Ann') {
    const cookie = (await fetch(base + '/api/identity')).headers.get('set-cookie')!.split(';')[0]!;
    await nameGuest(base, cookie, name);
    return cookie;
  }
  /** A heads-up Practice Table of the User's, the User on the button and the Bot in the big blind. */
  async function practice(cookie: string) {
    const created = await (await post('/table-sessions', cookie, { requestId: randomUUID(), bots: [{ name: 'Rex', playingStrategy: baselinePlayingStrategy }] })).json();
    const t = { id: created.tableSessionId as string, cookie, player: created.bindings[0].participantId as string, bot: created.bindings[1].participantId as string };
    await command(t, 'seat-participant', { participantId: t.player, seat: 1 });
    await command(t, 'seat-participant', { participantId: t.bot, seat: 4 });
    return t;
  }
  type Table = Awaited<ReturnType<typeof practice>>;
  const read = async (t: Table): Promise<ObservableTableSession> => (await get('/table-sessions/' + t.id, t.cookie)).json();
  async function command(t: Table, kind: string, contents: object = {}) {
    const response = await post('/table-sessions/' + t.id + '/' + kind, t.cookie, { requestId: randomUUID(), expectedPokerRevision: (await read(t)).pokerRevision, ...contents });
    expect(response.status).toBe(200);
  }
  const playerAct = (t: Table, action: ConcreteAction) => command(t, 'act', { participantId: t.player, action });
  const botAct = async (t: Table, action: ConcreteAction) => expect(await controller.submitAction(t.id, { requestId: randomUUID(), expectedPokerRevision: (await read(t)).pokerRevision, participantId: t.bot, action })).toMatchObject({ ok: true });
  /** A Hand checked down: the User calls preflop and checks the flop, turn and river, four decisions scoring 1. */
  async function checkDown(t: Table) {
    await command(t, 'start-hand');
    for (let state = (await read(t)).view.state; state.status === 'active-hand'; state = (await read(t)).view.state) {
      if (state.actorId === t.player) { await playerAct(t, { type: state.legalActions.some(action => action.type === 'check') ? 'check' : 'call' }); continue; }
      const bot = state.participants.find(participant => participant.participantId === t.bot)!, player = state.participants.find(participant => participant.participantId === t.player)!;
      await botAct(t, { type: (bot.wager ?? 0) < (player.wager ?? 0) ? 'call' : 'check' });
    }
  }
  const configure = async (cookie: string, referenceStrategy: StrategyDescriptor) => expect((await fetch(base + '/api/trainer-configuration', { method: 'PUT', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ requestId: randomUUID(), trainerConfiguration: { ...defaultTrainerConfiguration, referenceStrategy } }) })).status).toBe(200);
  const summaryPath = (t: Table, requestId: string) => '/table-sessions/' + t.id + '/summaries/' + requestId;
  /** The Session summary, the Hand's, and Table History's (which may name a Strategy to compare), each asked for explicitly. */
  const session = async (t: Table): Promise<ScoreSummary> => (await post('/table-sessions/' + t.id + '/session-summaries', t.cookie, {})).json();
  const hand = async (t: Table, handId = 'hand-1'): Promise<ScoreSummary> => (await post('/table-sessions/' + t.id + '/hand-summaries', t.cookie, { handId })).json();
  const history = async (t: Table, strategy?: StrategyDescriptor): Promise<ScoreSummary> => (await post('/table-sessions/' + t.id + '/session-summaries', t.cookie, { history: true, ...(strategy ? { strategy } : {}) })).json();
  const summary = async (t: Table, requestId: string): Promise<ScoreSummary> => (await get(summaryPath(t, requestId), t.cookie)).json();
  const retry = (t: Table, requestId: string) => post(summaryPath(t, requestId) + '/retry', t.cookie, {});
  const idle = () => expect.poll(() => evaluations.every(evaluation => evaluation.answered)).toBe(true);
  const waiting = (strategy: StrategyDescriptor) => evaluations.filter(evaluation => !evaluation.answered && strategyToken(evaluation.descriptor) === strategyToken(strategy));
  /** Answers one held evaluation under `strategy`, once one is waiting. */
  async function answerOne(strategy: StrategyDescriptor = reference) {
    await expect.poll(() => waiting(strategy).length).toBeGreaterThan(0);
    answer(waiting(strategy)[0]!);
  }
  return { base, guest, practice, checkDown, configure, session, hand, history, summary, retry, idle, answerOne, evaluations,
    hold() { holding = true; },
    release() { holding = false; for (const evaluation of evaluations) if (!evaluation.answered) answer(evaluation); },
    fail(count: number) { failing = count; },
    async close() { holding = false; await server.close(); await administration.query('DROP SCHEMA "' + schema + '" CASCADE'); },
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
let f: Fixture;
beforeAll(async () => { f = await fixture(); fixtures.push(f); });

/** A User with a Practice Table of four decisions, scoring 1, each needing a new analysis under their Reference Strategy. */
async function fourDecisions(name = 'Ann') {
  const cookie = await f.guest(name);
  const table = await f.practice(cookie);
  await f.checkDown(table);
  await f.idle();
  await f.configure(cookie, reference);
  return table;
}
/** One of the User's live connections, and what it has received on their user channel. */
async function listen(cookie: string) {
  const socket = new WebSocket(f.base.replace('http:', 'ws:') + '/api/live', { headers: { cookie } });
  sockets.push(socket);
  const messages: ServerLiveMessage[] = [];
  socket.on('error', () => {});
  socket.on('message', data => messages.push(JSON.parse(data.toString())));
  await expect.poll(() => messages[0]).toEqual({ type: 'user-channel-ready' });
  return {
    messages,
    progress: () => messages.filter((message): message is ProgressUpdate => message.type === 'progress'),
    notices: () => messages.filter((message): message is AnalysisUpdate => message.type === 'analysis-update' && message.resource === 'summary'),
  };
}
/** Time for anything already on its way to arrive. */
const pause = (ms = 60) => new Promise(resolve => setTimeout(resolve, ms));
/** A progress message's counts, by request. */
const counts = (message: ProgressUpdate) => Object.fromEntries(message.progress.map(entry => [entry.requestId, [entry.resource, entry.succeeded, entry.total]]));

test("a table's summaries report succeeded and total in every response, and a summary with no decisions reports none", async () => {
  const t = await fourDecisions();
  f.hold();
  try {
    const pending = await f.session(t);
    expect(pending).toMatchObject({ status: 'pending', decisionCount: 4, progress: { succeeded: 0, total: 4 } });
    expect(await f.summary(t, pending.requestId)).toMatchObject({ status: 'pending', progress: { succeeded: 0, total: 4 } });
    await f.answerOne();
    await expect.poll(async () => (await f.summary(t, pending.requestId)).progress).toEqual({ succeeded: 1, total: 4 });
  } finally { f.release(); }
  const cookie = await f.guest('Bea');
  const none = await f.session(await f.practice(cookie));
  expect(none).toMatchObject({ status: 'empty', progress: { succeeded: 0, total: 0 } });
});

test('a User hears at most one progress message a second for their table summaries, each with the latest count of every pending one, rising as analyses finish', async () => {
  const t = await fourDecisions();
  const tab = await listen(t.cookie);
  f.hold();
  try {
    // The Session summary, the same Hand's summary, and Table History's summary under a Strategy to compare.
    const whole = await f.session(t), first = await f.hand(t), shown = await f.history(t, compared);
    expect([whole.progress, first.progress, shown.progress]).toEqual([{ succeeded: 0, total: 4 }, { succeeded: 0, total: 4 }, { succeeded: 0, total: 4 }]);
    await pause();
    expect(tab.progress()).toEqual([]);
    const requests = [whole.requestId, first.requestId, shown.requestId];
    /** The latest counts over HTTP of the requests still pending, in a message's shape. */
    const latest = async () => Object.fromEntries((await Promise.all(requests.map(requestId => f.summary(t, requestId)))).filter(each => each.status === 'pending').map(each => [each.requestId, ['summary', each.progress.succeeded, each.progress.total]]));
    // The first analysis to finish is told at once. The Hand's summary and the Session summary share it.
    await f.answerOne();
    await expect.poll(() => tab.progress().length).toBe(1);
    const message = tab.progress()[0]!;
    expect(Object.keys(message).sort()).toEqual(['progress', 'type']);
    for (const entry of message.progress) expect(Object.keys(entry).sort()).toEqual(['requestId', 'resource', 'succeeded', 'total']);
    expect(counts(message)).toEqual(await latest());
    expect(counts(message)[whole.requestId]).toEqual(['summary', 1, 4]);
    expect(counts(message)[first.requestId]).toEqual(['summary', 1, 4]);
    expect(counts(message)[shown.requestId]).toEqual(['summary', 0, 4]);
    // Two more finish within the second: both wait for it to end, and go together.
    await f.answerOne();
    await expect.poll(async () => (await f.summary(t, whole.requestId)).progress.succeeded).toBe(2);
    await f.answerOne(compared);
    await expect.poll(async () => (await f.summary(t, shown.requestId)).progress.succeeded).toBe(1);
    await pause();
    expect(tab.progress()).toHaveLength(1);
    clock.advance(999);
    await pause();
    expect(tab.progress()).toHaveLength(1);
    clock.advance(1);
    await expect.poll(() => tab.progress().length).toBe(2);
    expect(counts(tab.progress()[1]!)).toEqual(await latest());
    expect(counts(tab.progress()[1]!)[whole.requestId]).toEqual(['summary', 2, 4]);
    expect(counts(tab.progress()[1]!)[shown.requestId]).toEqual(['summary', 1, 4]);
    // A second without any analysis finishing sends nothing.
    clock.advance(1000);
    await pause();
    expect(tab.progress()).toHaveLength(2);
    // Counts only rose.
    for (const requestId of requests) {
      const seen = tab.progress().flatMap(each => each.progress.filter(entry => entry.requestId === requestId).map(entry => entry.succeeded));
      expect(seen).toEqual([...seen].sort((a, b) => a - b));
    }
  } finally { f.release(); }
  // Once complete, each request has its notice, and from then on it is in no progress message.
  await expect.poll(() => new Set(tab.notices().map(notice => notice.requestId)).size).toBe(3);
  clock.advance(1000);
  await pause();
  const notified = new Set<string>();
  for (const message of tab.messages) {
    if (message.type === 'analysis-update') notified.add(message.requestId);
    if (message.type === 'progress') for (const entry of message.progress) expect(notified.has(entry.requestId)).toBe(false);
  }
  for (const notice of tab.notices()) {
    expect(notice).toMatchObject({ tableSessionId: t.id, resource: 'summary', status: 'complete' });
    expect(Object.keys(notice).sort()).toEqual(['attemptId', 'requestId', 'resource', 'status', 'tableSessionId', 'type']);
    expect(await f.summary(t, notice.requestId)).toMatchObject({ status: 'complete', attemptId: notice.attemptId, progress: { succeeded: 4, total: 4 } });
  }
});

test('a failed table summary publishes its failure, and its Retry follows progress again and publishes its completion', async () => {
  const t = await fourDecisions();
  const tab = await listen(t.cookie);
  const noticesOf = (requestId: string) => tab.notices().filter(notice => notice.requestId === requestId);
  // One analysis fails: the Session summary is in Error as soon as it has, however the others go.
  f.fail(1);
  const failing = await f.session(t);
  await expect.poll(() => noticesOf(failing.requestId).map(notice => notice.status)).toEqual(['error']);
  expect(await f.summary(t, failing.requestId)).toMatchObject({ status: 'error', attemptId: failing.attemptId });
  expect(noticesOf(failing.requestId)[0]!.attemptId).toBe(failing.attemptId);
  // The other three analyses still succeed, and the failed summary reports how far they got.
  await f.idle();
  await expect.poll(async () => (await f.summary(t, failing.requestId)).progress).toEqual({ succeeded: 3, total: 4 });
  // Retry asks again only for the failed one; the request is pending again with its count, and is followed again.
  f.hold();
  clock.advance(1000);
  const retried: ScoreSummary = await (await f.retry(t, failing.requestId)).json();
  try {
    expect(retried).toMatchObject({ requestId: failing.requestId, status: 'pending', progress: { succeeded: 3, total: 4 } });
    expect(retried.attemptId).not.toBe(failing.attemptId);
    const before = tab.progress().length;
    await f.answerOne();
    await expect.poll(() => tab.progress().slice(before).flatMap(message => message.progress.filter(entry => entry.requestId === failing.requestId)).length).toBeGreaterThan(0);
  } finally { f.release(); }
  await expect.poll(() => noticesOf(failing.requestId).map(notice => [notice.status, notice.attemptId])).toEqual([['error', failing.attemptId], ['complete', retried.attemptId]]);
  expect(await f.summary(t, failing.requestId)).toMatchObject({ status: 'complete', progress: { succeeded: 4, total: 4 } });
});

test("a User's connections hear progress and notices of their own table summaries only, never another User's", async () => {
  const ann = await fourDecisions('Ann'), ben = await fourDecisions('Ben');
  const annTabs = [await listen(ann.cookie), await listen(ann.cookie)], benTab = await listen(ben.cookie);
  f.hold();
  const asked: Record<'ann' | 'ben', string[]> = { ann: [], ben: [] };
  try {
    for (const [who, t] of [['ann', ann], ['ben', ben]] as const) asked[who].push((await f.session(t)).requestId, (await f.hand(t)).requestId, (await f.history(t, compared)).requestId);
    // Both Users' analyses finish a few at a time, each second's worth told together.
    for (let round = 0; round < 4; round++) {
      await f.answerOne();
      await f.answerOne();
      await pause();
      clock.advance(1000);
    }
  } finally { f.release(); }
  for (const tab of [...annTabs, benTab]) await expect.poll(() => new Set(tab.notices().map(notice => notice.requestId)).size).toBe(3);
  const heard = (tab: Awaited<ReturnType<typeof listen>>) => new Set([...tab.progress().flatMap(message => message.progress.map(entry => entry.requestId)), ...tab.notices().map(notice => notice.requestId)]);
  for (const tab of annTabs) {
    expect(tab.progress().length).toBeGreaterThan(0);
    expect([...heard(tab)].sort()).toEqual([...asked.ann].sort());
  }
  expect(benTab.progress().length).toBeGreaterThan(0);
  expect([...heard(benTab)].sort()).toEqual([...asked.ben].sort());
  // Every connection of a User hears the same, and a connection opened later is told nothing stored.
  expect(annTabs[1]!.progress()).toEqual(annTabs[0]!.progress());
  expect(annTabs[1]!.notices()).toEqual(annTabs[0]!.notices());
  const late = await listen(ann.cookie);
  await pause();
  expect(late.messages).toEqual([{ type: 'user-channel-ready' }]);
});

test('progress and notices of table summaries carry counts and identities only: no results, and nothing hidden', async () => {
  const t = await fourDecisions();
  const tab = await listen(t.cookie);
  f.hold();
  try {
    const request = await f.session(t);
    await f.answerOne();
    await expect.poll(() => tab.progress().length).toBe(1);
    expect(tab.progress()[0]).toEqual({ type: 'progress', progress: [{ resource: 'summary', requestId: request.requestId, succeeded: 1, total: 4 }] });
  } finally { f.release(); }
  await expect.poll(() => tab.notices().length).toBe(1);
  const text = JSON.stringify(tab.messages);
  for (const hidden of ['averages', 'decisionScore', 'holeCards', 'burn', 'deck', 'seed']) expect(text).not.toContain(hidden);
});
