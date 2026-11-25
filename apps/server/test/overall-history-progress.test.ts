import { afterAll, beforeAll, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import WebSocket from 'ws';
import { baselinePlayingStrategy, defaultTrainerConfiguration, highestProbabilityPlayingStrategy, historyFilterParams, supportedStrategies, type ConcreteAction, type HistoryBreakdown, type HistoryFilter, type ObservableGameView, type ObservableTableSession, type OverallHistorySummary, type OverallHistoryUpdate, type ProgressUpdate, type ScoredOverallHistory, type ServerLiveMessage, type StrategyDescriptor } from '@poker/contracts';
import { HighestProbabilitySelector, type PolicyResult } from '@poker/strategies';
import { createServer } from '../src/server.js';
import type { TableSessionControllerCommands } from '../src/mutations.js';
import { InstantClock } from './fixtures/clock.js';
import { nameGuest } from './fixtures/guest.js';

// Overall History on the user channel (ADR-0026, ADR-0041): a pending request's count travels as `progress`, at most
// once a second per Guest, and each summary and score-filtered list publishes its completion or failure. Every
// Presentation Phase ends at once; only the spacing of `progress` messages waits for the clock, which the tests move.
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

/**
 * A server whose fake Strategy answers at once, until `hold` makes it wait; `fail` makes the next evaluations fail. Each
 * analysis is an evaluation then its scoring, so there are running slots enough for a scoring to run while every other
 * evaluation is held: an analysis finishes as soon as its evaluation is answered.
 */
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
  /** A heads-up Practice Table of the Guest's, the Guest on the button and the Bot in the big blind. */
  async function practice(cookie: string) {
    const created = await (await post('/table-sessions', cookie, { requestId: randomUUID(), bots: [{ name: 'Rex', playingStrategy: baselinePlayingStrategy }] })).json();
    const t = { id: created.tableSessionId as string, cookie, human: created.bindings[0].participantId as string, bot: created.bindings[1].participantId as string };
    await command(t, 'seat-participant', { participantId: t.human, seat: 1 });
    await command(t, 'seat-participant', { participantId: t.bot, seat: 4 });
    return t;
  }
  type Table = Awaited<ReturnType<typeof practice>>;
  const read = async (t: Table): Promise<ObservableTableSession> => (await get('/table-sessions/' + t.id, t.cookie)).json();
  async function command(t: Table, kind: string, contents: object = {}) {
    const response = await post('/table-sessions/' + t.id + '/' + kind, t.cookie, { requestId: randomUUID(), expectedPokerRevision: (await read(t)).pokerRevision, ...contents });
    expect(response.status).toBe(200);
  }
  const humanAct = (t: Table, action: ConcreteAction) => command(t, 'act', { participantId: t.human, action });
  const botAct = async (t: Table, action: ConcreteAction) => expect(await controller.submitAction(t.id, { requestId: randomUUID(), expectedPokerRevision: (await read(t)).pokerRevision, participantId: t.bot, action })).toMatchObject({ ok: true });
  /** A Hand checked down: the Guest calls preflop and checks the flop, turn and river, four decisions scoring 1. */
  async function checkDown(t: Table) {
    await command(t, 'start-hand');
    for (let state = (await read(t)).view.state; state.status === 'active-hand'; state = (await read(t)).view.state) {
      if (state.actorId === t.human) { await humanAct(t, { type: state.legalActions.some(action => action.type === 'check') ? 'check' : 'call' }); continue; }
      const bot = state.participants.find(participant => participant.participantId === t.bot)!, human = state.participants.find(participant => participant.participantId === t.human)!;
      await botAct(t, { type: (bot.wager ?? 0) < (human.wager ?? 0) ? 'call' : 'check' });
    }
  }
  /** A Hand the Guest folds preflop: one decision, scoring 0. */
  async function foldPreflop(t: Table) {
    await command(t, 'start-hand');
    await humanAct(t, { type: 'fold' });
  }
  const configure = async (cookie: string, referenceStrategy: StrategyDescriptor) => expect((await fetch(base + '/api/trainer-configuration', { method: 'PUT', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ requestId: randomUUID(), trainerConfiguration: { ...defaultTrainerConfiguration, referenceStrategy } }) })).status).toBe(200);
  async function summarize(cookie: string, filter: HistoryFilter = {}, breakdown?: HistoryBreakdown): Promise<OverallHistorySummary> {
    const response = await post('/overall-history/summaries', cookie, { filter: historyFilterParams(filter), ...(breakdown ? { breakdown } : {}) });
    expect(response.status).toBe(200);
    return response.json();
  }
  async function ask(cookie: string, filter: HistoryFilter): Promise<ScoredOverallHistory> {
    const response = await post('/overall-history/scored', cookie, { filter: historyFilterParams(filter) });
    expect(response.status).toBe(200);
    return response.json();
  }
  const summary = async (cookie: string, requestId: string): Promise<OverallHistorySummary> => (await get('/overall-history/summaries/' + requestId, cookie)).json();
  const scored = async (cookie: string, requestId: string): Promise<ScoredOverallHistory> => (await get('/overall-history/scored/' + requestId, cookie)).json();
  const idle = () => expect.poll(() => evaluations.every(evaluation => evaluation.answered)).toBe(true);
  const waiting = () => evaluations.filter(evaluation => !evaluation.answered && evaluation.descriptor.policy.id === highestProbabilityPlayingStrategy.policy.id);
  /** Answers one held evaluation, once one is waiting. */
  async function answerOne() {
    await expect.poll(() => waiting().length).toBeGreaterThan(0);
    answer(waiting()[0]!);
  }
  return { base, guest, practice, checkDown, foldPreflop, configure, summarize, ask, summary, scored, idle, answerOne,
    summaryRetry: (cookie: string, requestId: string) => post('/overall-history/summaries/' + requestId + '/retry', cookie, {}),
    scoredRetry: (cookie: string, requestId: string) => post('/overall-history/scored/' + requestId + '/retry', cookie, {}),
    hold() { holding = true; },
    release() { holding = false; for (const evaluation of evaluations) if (!evaluation.answered) answer(evaluation); },
    fail(count: number) { failing = count; },
    async close() { holding = false; await server.close(); await administration.query('DROP SCHEMA "' + schema + '" CASCADE'); },
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
let f: Fixture;
beforeAll(async () => { f = await fixture(); fixtures.push(f); });

/** A Guest with five decisions at two Practice Tables (four scoring 1, a fold scoring 0), each needing a new analysis. */
async function fiveDecisions(name = 'Ann') {
  const cookie = await f.guest(name);
  const first = await f.practice(cookie), second = await f.practice(cookie);
  await f.checkDown(first);
  await f.foldPreflop(second);
  await f.idle();
  await f.configure(cookie, highestProbabilityPlayingStrategy);
  return cookie;
}
/** One of the Guest's live connections, and what it has received on their user channel. */
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
    notices: () => messages.filter((message): message is OverallHistoryUpdate => message.type === 'overall-history-update'),
  };
}
type Listener = Awaited<ReturnType<typeof listen>>;
/** Time for anything already on its way to arrive. */
const pause = (ms = 60) => new Promise(resolve => setTimeout(resolve, ms));
/** A progress message's counts, by request. */
const counts = (message: ProgressUpdate) => Object.fromEntries(message.progress.map(entry => [entry.requestId, [entry.resource, entry.succeeded, entry.total]]));

test('a Guest hears at most one progress message a second, each with the latest count of every pending request, rising as analyses finish', async () => {
  const cookie = await fiveDecisions();
  const tab = await listen(cookie);
  f.hold();
  let whole: OverallHistorySummary, preflop: OverallHistorySummary, list: ScoredOverallHistory;
  try {
    whole = await f.summarize(cookie); preflop = await f.summarize(cookie, { street: ['preflop'] });
    list = await f.ask(cookie, { decisionScore: { min: 0.5 } });
    expect([whole.summary.progress, preflop.summary.progress, list.progress]).toEqual([{ succeeded: 0, total: 5 }, { succeeded: 0, total: 2 }, { succeeded: 0, total: 5 }]);
    // Nothing has finished, so nothing is sent.
    await pause();
    expect(tab.progress()).toEqual([]);
    /** The latest counts over HTTP of the requests still pending, in a message's shape. */
    const latest = async () => {
      const [w, p, l] = [await f.summary(cookie, whole.requestId), await f.summary(cookie, preflop.requestId), await f.scored(cookie, list.requestId)];
      return Object.fromEntries([
        ...[w, p].filter(each => each.summary.status === 'pending').map(each => [each.requestId, ['overall-history-summary', each.summary.progress.succeeded, each.summary.progress.total]]),
        ...l.status === 'pending' ? [[l.requestId, ['overall-history-scored', l.progress.succeeded, l.progress.total]]] : [],
      ]);
    };
    // The first analysis to finish is told at once, with every pending request's count.
    await f.answerOne();
    await expect.poll(() => tab.progress().length).toBe(1);
    const first = tab.progress()[0]!;
    expect(Object.keys(first).sort()).toEqual(['progress', 'type']);
    for (const entry of first.progress) expect(Object.keys(entry).sort()).toEqual(['requestId', 'resource', 'succeeded', 'total']);
    expect(counts(first)).toEqual(await latest());
    expect(counts(first)[whole.requestId]).toEqual(['overall-history-summary', 1, 5]);
    expect(counts(first)[list.requestId]).toEqual(['overall-history-scored', 1, 5]);
    // Two more finish within the second: both wait for it to end, and go together.
    await f.answerOne();
    await expect.poll(async () => (await f.summary(cookie, whole.requestId)).summary.progress.succeeded).toBe(2);
    await f.answerOne();
    await expect.poll(async () => (await f.summary(cookie, whole.requestId)).summary.progress.succeeded).toBe(3);
    await pause();
    expect(tab.progress()).toHaveLength(1);
    clock.advance(999);
    await pause();
    expect(tab.progress()).toHaveLength(1);
    clock.advance(1);
    await expect.poll(() => tab.progress().length).toBe(2);
    expect(counts(tab.progress()[1]!)).toEqual(await latest());
    expect(counts(tab.progress()[1]!)[whole.requestId]).toEqual(['overall-history-summary', 3, 5]);
    // A second without any analysis finishing sends nothing.
    clock.advance(1000);
    await pause();
    expect(tab.progress()).toHaveLength(2);
    // The next goes out at once, more than a second after the last.
    await f.answerOne();
    await expect.poll(() => tab.progress().length).toBe(3);
    expect(counts(tab.progress()[2]!)[whole.requestId]).toEqual(['overall-history-summary', 4, 5]);
    // Each request's counts rose as its analyses finished, and none ever fell.
    for (const requestId of [whole.requestId, preflop.requestId, list.requestId]) {
      const seen = tab.progress().flatMap(message => message.progress.filter(entry => entry.requestId === requestId).map(entry => entry.succeeded));
      expect(seen).toEqual([...seen].sort((a, b) => a - b));
    }
    expect(tab.progress().map(message => counts(message)[whole.requestId]![1])).toEqual([1, 3, 4]);
  } finally { f.release(); }
  // Once complete, each request has its notice, and from then on it is in no progress message.
  await expect.poll(() => new Set(tab.notices().map(notice => notice.requestId)).size).toBe(3);
  clock.advance(1000);
  await pause();
  const notified = new Set<string>();
  for (const message of tab.messages) {
    if (message.type === 'overall-history-update') notified.add(message.requestId);
    if (message.type === 'progress') for (const entry of message.progress) expect(notified.has(entry.requestId)).toBe(false);
  }
  expect((await f.summary(cookie, whole.requestId)).summary.status).toBe('complete');
  expect((await f.summary(cookie, preflop.requestId)).summary.status).toBe('complete');
  expect((await f.scored(cookie, list.requestId)).status).toBe('complete');
});

test('every summary of a request, a bucket\'s included, and every score-filtered list publishes its completion, its failure, and its completion after a Retry', async () => {
  const cookie = await fiveDecisions();
  const tab = await listen(cookie);
  const noticesOf = (requestId: string) => tab.notices().filter(notice => notice.requestId === requestId);
  // A breakdown by street: the whole set's summary and four buckets', each telling of its completion.
  const byStreet = await f.summarize(cookie, {}, 'street');
  await expect.poll(() => noticesOf(byStreet.requestId).length).toBe(5);
  expect(noticesOf(byStreet.requestId).every(notice => notice.resource === 'overall-history-summary' && notice.status === 'complete' && notice.attemptId === byStreet.attemptId)).toBe(true);
  const read = await f.summary(cookie, byStreet.requestId);
  expect([read.summary, ...read.buckets!.map(bucket => bucket.summary)].map(each => each.status)).toEqual(['complete', 'complete', 'complete', 'complete', 'complete']);
  expect(Object.keys(noticesOf(byStreet.requestId)[0]!).sort()).toEqual(['attemptId', 'requestId', 'resource', 'status', 'type']);
  // A score range that admits nothing leaves the summary empty: that is its completion too.
  const none = await f.summarize(cookie, { decisionScore: { min: 0.2, max: 0.8 } });
  await expect.poll(() => noticesOf(none.requestId)).toEqual([{ type: 'overall-history-update', resource: 'overall-history-summary', requestId: none.requestId, attemptId: none.attemptId, status: 'complete' }]);
  expect((await f.summary(cookie, none.requestId)).summary.status).toBe('empty');
  // The score-filtered list.
  const list = await f.ask(cookie, { decisionScore: { min: 0.5 } });
  await expect.poll(() => noticesOf(list.requestId)).toEqual([{ type: 'overall-history-update', resource: 'overall-history-scored', requestId: list.requestId, attemptId: list.attemptId, status: 'complete' }]);
  expect(await f.scored(cookie, list.requestId)).toMatchObject({ status: 'complete', total: 4 });

  // Failures, then each Retry's completion, under a Strategy nothing has been analyzed with yet.
  await f.configure(cookie, baselinePlayingStrategy);
  f.fail(1);
  const failing = await f.summarize(cookie);
  await expect.poll(() => noticesOf(failing.requestId).map(notice => notice.status)).toEqual(['error']);
  expect((await f.summary(cookie, failing.requestId)).summary.status).toBe('error');
  await f.idle();
  const retried: OverallHistorySummary = await (await f.summaryRetry(cookie, failing.requestId)).json();
  expect(retried.attemptId).not.toBe(failing.attemptId);
  await expect.poll(() => noticesOf(failing.requestId).map(notice => [notice.status, notice.attemptId])).toEqual([['error', failing.attemptId], ['complete', retried.attemptId]]);
  expect((await f.summary(cookie, failing.requestId)).summary.status).toBe('complete');

  await f.configure(cookie, supportedStrategies[1]!);
  f.fail(1);
  const failingList = await f.ask(cookie, { actionRankScore: { max: 0.5 } });
  await expect.poll(() => noticesOf(failingList.requestId).map(notice => notice.status)).toEqual(['error']);
  expect((await f.scored(cookie, failingList.requestId)).status).toBe('error');
  await f.idle();
  const retriedList: ScoredOverallHistory = await (await f.scoredRetry(cookie, failingList.requestId)).json();
  await expect.poll(() => noticesOf(failingList.requestId).map(notice => [notice.resource, notice.status, notice.attemptId])).toEqual([['overall-history-scored', 'error', failingList.attemptId], ['overall-history-scored', 'complete', retriedList.attemptId]]);
  expect(await f.scored(cookie, failingList.requestId)).toMatchObject({ status: 'complete', total: 1 });
});

test("a Guest's connections receive progress and notices for their own requests only, never another Guest's", async () => {
  const ann = await fiveDecisions('Ann'), ben = await fiveDecisions('Ben');
  const annTabs = [await listen(ann), await listen(ann)], benTab = await listen(ben);
  f.hold();
  const asked: Record<'ann' | 'ben', string[]> = { ann: [], ben: [] };
  try {
    for (const [who, cookie] of [['ann', ann], ['ben', ben]] as const) {
      asked[who].push((await f.summarize(cookie)).requestId, (await f.summarize(cookie, {}, 'action')).requestId, (await f.ask(cookie, { decisionScore: { min: 0.5 } })).requestId);
    }
    // Both Guests' analyses finish a few at a time, each second's worth told together.
    for (let round = 0; round < 4; round++) {
      await f.answerOne();
      await f.answerOne();
      await pause();
      clock.advance(1000);
    }
  } finally { f.release(); }
  for (const tab of [...annTabs, benTab]) await expect.poll(() => new Set(tab.notices().map(notice => notice.requestId)).size).toBe(3);
  const heard = (tab: Listener) => new Set([...tab.progress().flatMap(message => message.progress.map(entry => entry.requestId)), ...tab.notices().map(notice => notice.requestId)]);
  for (const tab of annTabs) {
    expect(tab.progress().length).toBeGreaterThan(0);
    expect([...heard(tab)].sort()).toEqual([...asked.ann].sort());
  }
  expect(benTab.progress().length).toBeGreaterThan(0);
  expect([...heard(benTab)].sort()).toEqual([...asked.ben].sort());
  // Every connection of a Guest hears the same.
  expect(annTabs[1]!.progress()).toEqual(annTabs[0]!.progress());
  expect(annTabs[1]!.notices()).toEqual(annTabs[0]!.notices());
  // A connection opened later is told nothing stored: only that its channel is ready.
  const late = await listen(ann);
  await pause();
  expect(late.messages).toEqual([{ type: 'user-channel-ready' }]);
});
