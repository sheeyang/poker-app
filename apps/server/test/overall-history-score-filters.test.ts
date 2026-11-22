import { afterAll, beforeAll, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { baselinePlayingStrategy, defaultTrainerConfiguration, highestProbabilityPlayingStrategy, historyFilterParams, type ConcreteAction, type HistoryFilter, type OverallHistorySummary, type ObservableGameView, type ObservableTableSession, type ScoredOverallHistory, type StrategyDescriptor } from '@poker/contracts';
import { HighestProbabilitySelector, type PolicyResult } from '@poker/strategies';
import { createServer } from '../src/server.js';
import type { TableSessionControllerCommands } from '../src/mutations.js';
import { InstantClock } from './fixtures/clock.js';
import { nameGuest } from './fixtures/guest.js';

// Score filters in Overall History (ADR-0041): a score range is decided only by a finished analysis. Not a timing test.
const clock = new InstantClock();
const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('Set TEST_DATABASE_URL to a real PostgreSQL test database.');
const administration = new Pool({ connectionString: databaseUrl });
const fixtures: { close(): Promise<void> }[] = [];
afterAll(async () => { await Promise.all(fixtures.map(fixture => fixture.close())); await administration.end(); });

/** One Reference Strategy Evaluation the fake Strategy was asked for. */
interface Evaluation { readonly decisionId: string; readonly descriptor: StrategyDescriptor; readonly view: ObservableGameView; readonly result: ReturnType<typeof Promise.withResolvers<PolicyResult>>; answered: boolean }
/**
 * The fake Strategy puts all its probability on the passive action, checking or calling. A Guest who checks or calls
 * therefore scores 1 on both scores, and one who folds scores 0 on both: fold has none of the probability, and ranks
 * last of the two distinct probabilities.
 */
const settle = (view: ObservableGameView): PolicyResult => {
  const action = view.state.legalActions.find(legal => legal.type === 'check' || legal.type === 'call') ?? view.state.legalActions[0]!;
  return { choices: [{ action: { type: action.type } as ConcreteAction, probability: 1 }] };
};

/** A server whose fake Strategy answers at once, until `hold` makes it wait; `fail` makes the next evaluations fail. */
async function fixture(concurrency = 2) {
  const schema = 'test_' + randomUUID().replaceAll('-', '');
  await administration.query('CREATE SCHEMA "' + schema + '"');
  const evaluations: Evaluation[] = [];
  let holding = false, failing = 0;
  let controller!: TableSessionControllerCommands;
  const answer = (evaluation: Evaluation) => { evaluation.answered = true; evaluation.result.resolve(settle(evaluation.view)); };
  const server = await createServer({ clock, databaseUrl: databaseUrl!, schema, automaticBots: false, jobRunnerOptions: { concurrency, maximumQueued: 16 },
    onControllerCommandsReady: commands => { controller = commands; },
    strategyFactory: descriptor => ({ policy: { checkCompatibility: () => ({ compatible: true }), evaluate: view => {
      const evaluation: Evaluation = { decisionId: view.state.decisionId!, descriptor, view, result: Promise.withResolvers<PolicyResult>(), answered: false };
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
  /** A heads-up Practice Table of the Guest's, the Guest on the button (BTN/SB) and the Bot in the big blind. */
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
  /**
   * A Hand checked down to showdown. On the button the Guest calls preflop and checks the flop, turn and river: four
   * decisions, each scoring 1.
   */
  async function checkDown(t: Table) {
    await command(t, 'start-hand');
    for (let state = (await read(t)).view.state; state.status === 'active-hand'; state = (await read(t)).view.state) {
      if (state.actorId === t.human) { await humanAct(t, { type: state.legalActions.some(action => action.type === 'check') ? 'check' : 'call' }); continue; }
      const bot = state.participants.find(participant => participant.participantId === t.bot)!, human = state.participants.find(participant => participant.participantId === t.human)!;
      await botAct(t, { type: (bot.wager ?? 0) < (human.wager ?? 0) ? 'call' : 'check' });
    }
  }
  /** A Hand the Guest, on the button, folds preflop: one decision, scoring 0. */
  async function foldPreflop(t: Table) {
    await command(t, 'start-hand');
    expect((await read(t)).view.state.actorId).toBe(t.human);
    await humanAct(t, { type: 'fold' });
  }
  const configure = async (cookie: string, referenceStrategy: StrategyDescriptor) => expect((await fetch(base + '/api/trainer-configuration', { method: 'PUT', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ requestId: randomUUID(), trainerConfiguration: { ...defaultTrainerConfiguration, referenceStrategy } }) })).status).toBe(200);
  /** Asks for the decisions a filter with score ranges admits. */
  async function ask(cookie: string, filter: HistoryFilter): Promise<ScoredOverallHistory> {
    const response = await post('/overall-history/scored', cookie, { filter: historyFilterParams(filter) });
    expect(response.status).toBe(200);
    return response.json();
  }
  const readScored = (cookie: string, requestId: string, query = '') => get('/overall-history/scored/' + requestId + query, cookie);
  const current = async (cookie: string, requestId: string, query = ''): Promise<ScoredOverallHistory> => { const response = await readScored(cookie, requestId, query); expect(response.status).toBe(200); return response.json(); };
  const retry = (cookie: string, requestId: string) => post('/overall-history/scored/' + requestId + '/retry', cookie, {});
  /** Every evaluation asked for so far has answered. */
  const idle = () => expect.poll(() => evaluations.every(evaluation => evaluation.answered)).toBe(true);
  /** The evaluations asked for under `descriptor`, and those of them still waiting for an answer. */
  const under = (descriptor: StrategyDescriptor) => evaluations.filter(evaluation => evaluation.descriptor.policy.id === descriptor.policy.id && evaluation.descriptor.selector.id === descriptor.selector.id);
  const waiting = (descriptor: StrategyDescriptor) => under(descriptor).filter(evaluation => !evaluation.answered);
  return { base, get, post, evaluations, guest, practice, read, checkDown, foldPreflop, configure, ask, readScored, current, retry, idle, under, waiting, answer,
    hold() { holding = true; },
    release() { holding = false; for (const evaluation of evaluations) if (!evaluation.answered) answer(evaluation); },
    fail(count: number) { failing = count; },
    async close() { holding = false; await server.close(); await administration.query('DROP SCHEMA "' + schema + '" CASCADE'); },
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
let f: Fixture;
beforeAll(async () => { f = await fixture(); fixtures.push(f); });

/**
 * A Guest who played two Practice Tables: at the first a Hand checked down (preflop call, then checks on the flop, turn
 * and river, all scoring 1), at the second a preflop fold (scoring 0). Their Reference Strategy is then one no
 * post-action analysis ran under, so every decision needs a new analysis.
 */
async function twoTables(fixture: Fixture = f) {
  const cookie = await fixture.guest();
  const first = await fixture.practice(cookie), second = await fixture.practice(cookie);
  await fixture.checkDown(first);
  await fixture.foldPreflop(second);
  await fixture.idle();
  await fixture.configure(cookie, highestProbabilityPlayingStrategy);
  return { cookie, first, second };
}
const completed = (fixture: Fixture, cookie: string, requestId: string) => expect.poll(async () => (await fixture.current(cookie, requestId)).status).toBe('complete');
const listed = (scoredHistory: ScoredOverallHistory) => scoredHistory.status === 'complete' ? scoredHistory.decisions.map(decision => decision.street + ':' + decision.action.type) : undefined;

test('with every analysis complete, score ranges narrow the list, and combine with the non-score filters', async () => {
  const { cookie } = await twoTables();
  const everything = await f.ask(cookie, { decisionScore: { min: 0 } });
  await completed(f, cookie, everything.requestId);
  expect(listed(await f.current(cookie, everything.requestId))).toHaveLength(5);
  // The four check/call decisions score 1; the fold scores 0.
  const good = await f.ask(cookie, { decisionScore: { min: 0.5 } });
  await completed(f, cookie, good.requestId);
  const goodList = await f.current(cookie, good.requestId);
  expect(goodList).toMatchObject({ status: 'complete', total: 4, offset: 0, progress: { succeeded: 5, total: 5 }, referenceStrategy: highestProbabilityPlayingStrategy });
  expect(listed(goodList)).toEqual(expect.arrayContaining(['preflop:call', 'flop:check', 'turn:check', 'river:check']));
  expect(listed(goodList)).not.toContain('preflop:fold');
  const bad = await f.ask(cookie, { actionRankScore: { max: 0.5 } });
  await completed(f, cookie, bad.requestId);
  expect(listed(await f.current(cookie, bad.requestId))).toEqual(['preflop:fold']);
  // Combined with a non-score filter: only the preflop decisions, and of them the good one.
  const preflopGood = await f.ask(cookie, { street: ['preflop'], decisionScore: { min: 0.5 }, actionRankScore: { min: 1 } });
  await completed(f, cookie, preflopGood.requestId);
  expect(listed(await f.current(cookie, preflopGood.requestId))).toEqual(['preflop:call']);
  // Only the preflop set needed analysis.
  expect(preflopGood.progress.total).toBe(2);
  // Paging, with the same order as the list.
  const page = await f.current(cookie, good.requestId, '?limit=3&offset=3');
  expect(page).toMatchObject({ status: 'complete', total: 4, offset: 3 });
  expect(page.status === 'complete' && page.decisions).toHaveLength(1);
  // A set with no match is complete and empty.
  const none = await f.ask(cookie, { decisionScore: { min: 0.2, max: 0.8 } });
  await completed(f, cookie, none.requestId);
  expect(await f.current(cookie, none.requestId)).toMatchObject({ status: 'complete', total: 0, decisions: [] });
});

test('while any analysis is pending it reports Analyzing with progress and returns no partial list', async () => {
  const { cookie } = await twoTables();
  f.hold();
  try {
    const asked = await f.ask(cookie, { decisionScore: { min: 0.5 } });
    expect(asked).toMatchObject({ status: 'pending', progress: { succeeded: 0, total: 5 } });
    expect(asked).not.toHaveProperty('decisions');
    for (let answered = 0; answered < 4; answered++) {
      await expect.poll(() => f.waiting(highestProbabilityPlayingStrategy).length).toBeGreaterThan(0);
      f.answer(f.waiting(highestProbabilityPlayingStrategy)[0]!);
    }
    await expect.poll(async () => (await f.current(cookie, asked.requestId)).progress).toEqual({ succeeded: 4, total: 5 });
    const partway = await f.current(cookie, asked.requestId);
    expect(partway.status).toBe('pending');
    expect(partway).not.toHaveProperty('decisions');
    expect(partway).not.toHaveProperty('total');
  } finally { f.release(); }
});

test('a failed analysis makes it an Error until a Retry succeeds, and only the failed analysis runs again', async () => {
  const { cookie } = await twoTables();
  f.fail(1);
  const asked = await f.ask(cookie, { decisionScore: { min: 0.5 } });
  await expect.poll(async () => (await f.current(cookie, asked.requestId)).status).toBe('error');
  await f.idle();
  await expect.poll(async () => (await f.current(cookie, asked.requestId)).progress).toEqual({ succeeded: 4, total: 5 });
  const failed = await f.current(cookie, asked.requestId);
  expect(failed).not.toHaveProperty('decisions');
  await new Promise(resolve => setTimeout(resolve, 50));
  expect((await f.current(cookie, asked.requestId)).status).toBe('error');
  const evaluated = f.under(highestProbabilityPlayingStrategy).length;
  const retried = await f.retry(cookie, asked.requestId);
  expect(retried.status).toBe(200);
  expect((await retried.json()).attemptId).not.toBe(failed.attemptId);
  await completed(f, cookie, asked.requestId);
  expect(await f.current(cookie, asked.requestId)).toMatchObject({ status: 'complete', total: 4 });
  expect(f.under(highestProbabilityPlayingStrategy).length).toBe(evaluated + 1);
});

test('the list route does not answer a score range from recorded facts, and another Guest cannot read the request', async () => {
  const { cookie } = await twoTables();
  const asked = await f.ask(cookie, { decisionScore: { min: 0.5 } });
  const plain = await f.get('/overall-history?decisionScoreMin=0.5', cookie);
  expect(plain.status).toBe(400);
  expect((await plain.json()).rejection.code).toBe('score-filter-needs-analysis');
  const stranger = await f.guest('Zed');
  expect((await f.readScored(stranger, asked.requestId)).status).toBe(404);
  expect((await f.retry(stranger, asked.requestId)).status).toBe(404);
  expect((await fetch(f.base + '/api/overall-history/scored/' + asked.requestId)).status).toBe(401);
  expect((await f.post('/overall-history/scored', cookie, { filter: {}, other: 1 })).status).toBe(400);
  // A filter without a score range is not what this operation is for.
  expect((await f.post('/overall-history/scored', cookie, { filter: { street: 'flop' } })).status).toBe(400);
});

/** Asks for an Overall History Score Summary, optionally broken down and under a named Strategy. */
async function summarize(fixture: Fixture, cookie: string, filter: HistoryFilter, breakdown?: string, strategy?: StrategyDescriptor): Promise<OverallHistorySummary> {
  const response = await fixture.post('/overall-history/summaries', cookie, { filter: historyFilterParams(filter), ...(breakdown ? { breakdown } : {}), ...(strategy ? { strategy } : {}) });
  expect(response.status).toBe(200);
  return response.json();
}
const summaryNow = async (fixture: Fixture, cookie: string, requestId: string): Promise<OverallHistorySummary> => (await fixture.get('/overall-history/summaries/' + requestId, cookie)).json();
const summarized = (fixture: Fixture, cookie: string, requestId: string) => expect.poll(async () => (await summaryNow(fixture, cookie, requestId)).summary.status).not.toBe('pending');

test('score ranges narrow a Score Summary and each of its buckets, once every analysis of the set has succeeded', async () => {
  const { cookie } = await twoTables();
  // The four check/call decisions score 1, the fold 0, so the summary of the good ones is 100 / 100 over 4 decisions.
  const good = await summarize(f, cookie, { decisionScore: { min: 0.5 } });
  expect(good.filter).toEqual({ decisionScore: { min: 0.5 } });
  await summarized(f, cookie, good.requestId);
  expect((await summaryNow(f, cookie, good.requestId)).summary).toEqual({ status: 'complete', decisionCount: 4, progress: { succeeded: 5, total: 5 }, averages: { decisionScore: 1, actionRankScore: 1 } });
  // Below half: only the fold, scoring 0.
  const bad = await summarize(f, cookie, { actionRankScore: { max: 0.5 } });
  await summarized(f, cookie, bad.requestId);
  expect((await summaryNow(f, cookie, bad.requestId)).summary).toEqual({ status: 'complete', decisionCount: 1, progress: { succeeded: 5, total: 5 }, averages: { decisionScore: 0, actionRankScore: 0 } });
  // A range nothing falls in is an empty summary, with no score.
  const none = await summarize(f, cookie, { decisionScore: { min: 0.2, max: 0.8 } });
  await summarized(f, cookie, none.requestId);
  expect((await summaryNow(f, cookie, none.requestId)).summary).toEqual({ status: 'empty', decisionCount: 0, progress: { succeeded: 5, total: 5 } });
  // By action: the good calls and checks are in their buckets; the fold's bucket is empty, with no score.
  const byAction = await summarize(f, cookie, { decisionScore: { min: 0.5 } }, 'action');
  await summarized(f, cookie, byAction.requestId);
  const buckets = (await summaryNow(f, cookie, byAction.requestId)).buckets!;
  expect(Object.fromEntries(buckets.map(bucket => [bucket.value, bucket.summary.status === 'complete' ? [bucket.summary.decisionCount, bucket.summary.averages.decisionScore] : [bucket.summary.status, bucket.summary.decisionCount]]))).toEqual({ fold: ['empty', 0], check: [3, 1], call: [1, 1] });
  // Combined with a street filter, only the preflop set is analyzed and summarized.
  const preflopBad = await summarize(f, cookie, { street: ['preflop'], decisionScore: { max: 0.5 } });
  await summarized(f, cookie, preflopBad.requestId);
  expect((await summaryNow(f, cookie, preflopBad.requestId)).summary).toEqual({ status: 'complete', decisionCount: 1, progress: { succeeded: 2, total: 2 }, averages: { decisionScore: 0, actionRankScore: 0 } });
});

test('a score-filtered Score Summary is Analyzing with no decision count or mean until every analysis succeeds, and an Error until Retry', async () => {
  const { cookie } = await twoTables();
  f.hold();
  let asked: OverallHistorySummary;
  try {
    asked = await summarize(f, cookie, { decisionScore: { min: 0.5 } });
    expect(asked.summary).toEqual({ status: 'pending', progress: { succeeded: 0, total: 5 } });
    for (let answered = 0; answered < 4; answered++) {
      await expect.poll(() => f.waiting(highestProbabilityPlayingStrategy).length).toBeGreaterThan(0);
      f.answer(f.waiting(highestProbabilityPlayingStrategy)[0]!);
    }
    await expect.poll(async () => (await summaryNow(f, cookie, asked.requestId)).summary).toEqual({ status: 'pending', progress: { succeeded: 4, total: 5 } });
  } finally { f.release(); }
  await summarized(f, cookie, asked.requestId);
  expect((await summaryNow(f, cookie, asked.requestId)).summary).toMatchObject({ status: 'complete', decisionCount: 4 });

  const other = await twoTables();
  f.fail(1);
  const failing = await summarize(f, other.cookie, { decisionScore: { min: 0.5 } });
  await summarized(f, other.cookie, failing.requestId);
  await f.idle();
  await expect.poll(async () => (await summaryNow(f, other.cookie, failing.requestId)).summary.progress).toEqual({ succeeded: 4, total: 5 });
  const failed = await summaryNow(f, other.cookie, failing.requestId);
  expect(failed.summary.status).toBe('error');
  expect(failed.summary).not.toHaveProperty('decisionCount');
  expect(failed.summary).not.toHaveProperty('averages');
  expect((await f.post('/overall-history/summaries/' + failing.requestId + '/retry', other.cookie, {})).status).toBe(200);
  await summarized(f, other.cookie, failing.requestId);
  expect((await summaryNow(f, other.cookie, failing.requestId)).summary).toMatchObject({ status: 'complete', decisionCount: 4, averages: { decisionScore: 1, actionRankScore: 1 } });
});

test('a score-filtered list and its summary can be decided under a named Strategy, without touching the Trainer Configuration', async () => {
  const { cookie } = await twoTables();
  const response = await f.post('/overall-history/scored', cookie, { filter: historyFilterParams({ decisionScore: { min: 0.5 } }), strategy: baselinePlayingStrategy });
  expect(response.status).toBe(200);
  const asked: ScoredOverallHistory = await response.json();
  expect(asked.referenceStrategy).toEqual(baselinePlayingStrategy);
  await completed(f, cookie, asked.requestId);
  expect(await f.current(cookie, asked.requestId)).toMatchObject({ status: 'complete', total: 4 });
  expect(f.under(baselinePlayingStrategy).length).toBeGreaterThan(0);
  const summary = await summarize(f, cookie, { decisionScore: { min: 0.5 } }, undefined, baselinePlayingStrategy);
  expect(summary.referenceStrategy).toEqual(baselinePlayingStrategy);
  await summarized(f, cookie, summary.requestId);
  expect((await summaryNow(f, cookie, summary.requestId)).summary).toMatchObject({ status: 'complete', decisionCount: 4 });
  expect((await (await f.get('/trainer-configuration', cookie)).json()).trainerConfiguration.referenceStrategy).toEqual(highestProbabilityPlayingStrategy);
  const unsupported = await f.post('/overall-history/scored', cookie, { filter: historyFilterParams({ decisionScore: { min: 0.5 } }), strategy: { policy: { id: 'nope' } } });
  expect(unsupported.status).toBe(400);
  expect((await unsupported.json()).rejection.code).toBe('unsupported-strategy');
});
