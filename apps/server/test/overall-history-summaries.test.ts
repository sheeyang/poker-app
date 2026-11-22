import { afterAll, beforeAll, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { baselinePlayingStrategy, defaultTrainerConfiguration, highestProbabilityPlayingStrategy, supportedStrategies, historyFilterParams, type ConcreteAction, type HistoryBreakdown, type HistoryFilter, type ObservableGameView, type ObservableTableSession, type OverallHistorySummary, type StrategyDescriptor } from '@poker/contracts';
import { HighestProbabilitySelector, type PolicyResult } from '@poker/strategies';
import { createServer } from '../src/server.js';
import type { TableSessionControllerCommands } from '../src/mutations.js';
import { InstantClock } from './fixtures/clock.js';
import { nameGuest } from './fixtures/guest.js';

// Score Summaries over Overall History's filtered decisions, and their breakdowns (ADR-0041). Not a timing test.
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
  let holding = false, failing = 0, failingUnder: StrategyDescriptor | undefined, holdingUnder: StrategyDescriptor | undefined;
  const is = (a: StrategyDescriptor | undefined, b: StrategyDescriptor) => !!a && a.policy.id === b.policy.id && a.selector.id === b.selector.id;
  let controller!: TableSessionControllerCommands;
  const answer = (evaluation: Evaluation) => { evaluation.answered = true; evaluation.result.resolve(settle(evaluation.view)); };
  const server = await createServer({ clock, databaseUrl: databaseUrl!, schema, automaticBots: false, jobRunnerOptions: { concurrency, maximumQueued: 16 },
    onControllerCommandsReady: commands => { controller = commands; },
    strategyFactory: descriptor => ({ policy: { checkCompatibility: () => ({ compatible: true }), evaluate: view => {
      const evaluation: Evaluation = { decisionId: view.state.decisionId!, descriptor, view, result: Promise.withResolvers<PolicyResult>(), answered: false };
      evaluations.push(evaluation);
      if (is(failingUnder, descriptor)) { evaluation.answered = true; evaluation.result.reject(new Error('Controlled Strategy failure.')); }
      else if (failing > 0) { failing--; evaluation.answered = true; evaluation.result.reject(new Error('Controlled Strategy failure.')); }
      else if (!holding && !is(holdingUnder, descriptor)) answer(evaluation);
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
  /** Asks for a Score Summary over the decisions `filter` declares, broken down by `breakdown` when it is given. */
  const request = (cookie: string, filter: HistoryFilter = {}, breakdown?: HistoryBreakdown, strategy?: unknown) => post('/overall-history/summaries', cookie, { filter: historyFilterParams(filter), ...(breakdown ? { breakdown } : {}), ...(strategy !== undefined ? { strategy } : {}) });
  async function summarize(cookie: string, filter: HistoryFilter = {}, breakdown?: HistoryBreakdown, strategy?: StrategyDescriptor): Promise<OverallHistorySummary> {
    const response = await request(cookie, filter, breakdown, strategy);
    expect(response.status).toBe(200);
    return response.json();
  }
  const readSummary = (cookie: string, requestId: string) => get('/overall-history/summaries/' + requestId, cookie);
  const current = async (cookie: string, requestId: string): Promise<OverallHistorySummary> => { const response = await readSummary(cookie, requestId); expect(response.status).toBe(200); return response.json(); };
  const retry = (cookie: string, requestId: string) => post('/overall-history/summaries/' + requestId + '/retry', cookie, {});
  /** Every evaluation asked for so far has answered. */
  const idle = () => expect.poll(() => evaluations.every(evaluation => evaluation.answered)).toBe(true);
  /** The evaluations asked for under `descriptor`, and those of them still waiting for an answer. */
  const under = (descriptor: StrategyDescriptor) => evaluations.filter(evaluation => evaluation.descriptor.policy.id === descriptor.policy.id && evaluation.descriptor.selector.id === descriptor.selector.id);
  const waiting = (descriptor: StrategyDescriptor) => under(descriptor).filter(evaluation => !evaluation.answered);
  return { base, evaluations, guest, practice, read, checkDown, foldPreflop, configure, request, summarize, readSummary, current, retry, idle, under, waiting, answer,
    hold() { holding = true; },
    release() { holding = false; holdingUnder = undefined; for (const evaluation of evaluations) if (!evaluation.answered) answer(evaluation); },
    fail(count: number) { failing = count; },
    failUnder(descriptor: StrategyDescriptor | undefined) { failingUnder = descriptor; },
    holdUnder(descriptor: StrategyDescriptor | undefined) { holdingUnder = descriptor; },
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
const completed = (fixture: Fixture, cookie: string, requestId: string) => expect.poll(async () => (await fixture.current(cookie, requestId)).summary.status).toBe('complete');

test('a Score Summary over the filtered decisions across several tables completes with both means once every analysis has succeeded', async () => {
  const { cookie } = await twoTables();
  const asked = await f.summarize(cookie);
  expect(asked).toMatchObject({ ok: true, filter: {}, referenceStrategy: highestProbabilityPlayingStrategy, summary: { decisionCount: 5 } });
  await completed(f, cookie, asked.requestId);
  // Four decisions scoring 1 and one scoring 0.
  expect((await f.current(cookie, asked.requestId)).summary).toEqual({ status: 'complete', decisionCount: 5, progress: { succeeded: 5, total: 5 }, averages: { decisionScore: 0.8, actionRankScore: 0.8 } });
  // A filter narrows the set: only the preflop decisions, the call (1) and the fold (0).
  const preflop = await f.summarize(cookie, { street: ['preflop'] });
  await completed(f, cookie, preflop.requestId);
  expect((await f.current(cookie, preflop.requestId)).summary).toMatchObject({ decisionCount: 2, averages: { decisionScore: 0.5, actionRankScore: 0.5 } });
});

test('a running summary reports how many of its analyses have succeeded, out of the whole set', async () => {
  const { cookie } = await twoTables();
  f.hold();
  try {
    const asked = await f.summarize(cookie);
    expect(asked.summary).toEqual({ status: 'pending', decisionCount: 5, progress: { succeeded: 0, total: 5 } });
    // Four of the five evaluations answer, one at a time as each starts; the fifth stays waiting.
    for (let answered = 0; answered < 4; answered++) {
      await expect.poll(() => f.waiting(highestProbabilityPlayingStrategy).length).toBeGreaterThan(0);
      f.answer(f.waiting(highestProbabilityPlayingStrategy)[0]!);
    }
    await expect.poll(async () => (await f.current(cookie, asked.requestId)).summary.progress).toEqual({ succeeded: 4, total: 5 });
    expect((await f.current(cookie, asked.requestId)).summary).not.toHaveProperty('averages');
    expect(f.waiting(highestProbabilityPlayingStrategy)).toHaveLength(1);
  } finally { f.release(); }
  await completed(f, cookie, (await f.summarize(cookie)).requestId);
});

test('a failed analysis makes the summary an Error, which stays until a Retry succeeds; there is never a partial mean', async () => {
  const { cookie } = await twoTables();
  f.fail(1);
  const asked = await f.summarize(cookie);
  await expect.poll(async () => (await f.current(cookie, asked.requestId)).summary.status).toBe('error');
  await f.idle();
  const failed = await f.current(cookie, asked.requestId);
  expect(failed.summary).not.toHaveProperty('averages');
  await expect.poll(async () => (await f.current(cookie, asked.requestId)).summary.progress).toEqual({ succeeded: 4, total: 5 });
  // The other analyses all succeeded, but nothing changes without a Retry.
  await new Promise(resolve => setTimeout(resolve, 50));
  expect((await f.current(cookie, asked.requestId)).summary.status).toBe('error');
  const evaluated = f.under(highestProbabilityPlayingStrategy).length;
  const retried = await f.retry(cookie, asked.requestId);
  expect(retried.status).toBe(200);
  const retrying: typeof failed = await retried.json();
  expect(retrying.requestId).toBe(asked.requestId);
  expect(retrying.attemptId).not.toBe(failed.attemptId);
  await completed(f, cookie, asked.requestId);
  expect((await f.current(cookie, asked.requestId)).summary).toMatchObject({ progress: { succeeded: 5, total: 5 }, averages: { decisionScore: 0.8, actionRankScore: 0.8 } });
  // Only the failed analysis ran again.
  expect(f.under(highestProbabilityPlayingStrategy).length).toBe(evaluated + 1);
});

test('a set with no decisions has no score', async () => {
  const { cookie } = await twoTables();
  // The Guest never folded on the river.
  const asked = await f.summarize(cookie, { street: ['river'], action: ['fold'] });
  expect(asked.summary).toEqual({ status: 'empty', decisionCount: 0, progress: { succeeded: 0, total: 0 } });
  expect(await f.current(cookie, asked.requestId)).toEqual(asked);
  // A Guest who never played has none either.
  const nobody = await f.summarize(await f.guest('Zed'), {}, 'street');
  expect(nobody).toMatchObject({ breakdown: 'street', summary: { status: 'empty', decisionCount: 0 }, buckets: [] });
});

/** A bucket's value, how many decisions it has, and its means, once complete. */
const buckets = (summary: OverallHistorySummary) => summary.buckets!.map(bucket => [bucket.value, bucket.summary.decisionCount, bucket.summary.status === 'complete' ? bucket.summary.averages.decisionScore : bucket.summary.status, bucket.summary.status === 'complete' ? bucket.summary.averages.actionRankScore : bucket.summary.status] as const);
async function brokenDown(cookie: string, breakdown: HistoryBreakdown, filter: HistoryFilter = {}) {
  const asked = await f.summarize(cookie, filter, breakdown);
  expect(asked.breakdown).toBe(breakdown);
  await expect.poll(async () => { const now = await f.current(cookie, asked.requestId); return [now.summary.status, ...now.buckets!.map(bucket => bucket.summary.status)].every(status => status === 'complete'); }).toBe(true);
  return f.current(cookie, asked.requestId);
}

test('each breakdown gives one complete summary per bucket the set has, in declared order, reusing the analyses already done', async () => {
  const { cookie } = await twoTables();
  const before = f.under(highestProbabilityPlayingStrategy).length;
  await completed(f, cookie, (await f.summarize(cookie)).requestId);
  const evaluated = f.under(highestProbabilityPlayingStrategy).length;
  expect(evaluated - before).toBe(5);
  const street = await brokenDown(cookie, 'street');
  expect(street.summary).toMatchObject({ decisionCount: 5, averages: { decisionScore: 0.8, actionRankScore: 0.8 } });
  expect(buckets(street)).toEqual([['preflop', 2, 0.5, 0.5], ['flop', 1, 1, 1], ['turn', 1, 1, 1], ['river', 1, 1, 1]]);
  expect(buckets(await brokenDown(cookie, 'action'))).toEqual([['fold', 1, 0, 0], ['check', 3, 1, 1], ['call', 1, 1, 1]]);
  // Heads-up, the Guest on the button is BTN/SB.
  expect(buckets(await brokenDown(cookie, 'position'))).toEqual([['BTN/SB', 5, 0.8, 0.8]]);
  expect(buckets(await brokenDown(cookie, 'mode'))).toEqual([['practice', 5, 0.8, 0.8]]);
  // A breakdown of a filtered set buckets only that set.
  expect(buckets(await brokenDown(cookie, 'action', { street: ['preflop'] }))).toEqual([['fold', 1, 0, 0], ['call', 1, 1, 1]]);
  expect(f.under(highestProbabilityPlayingStrategy)).toHaveLength(evaluated);
});

test('a summary under the Strategy post-action analysis already used completes from those cached results, with no new evaluation', async () => {
  const cookie = await f.guest();
  const t = await f.practice(cookie);
  await f.checkDown(t);
  await f.idle();
  // Post-action analysis ran under the default Reference Strategy, the one this Guest still has.
  const before = f.evaluations.length;
  const asked = await f.summarize(cookie);
  await completed(f, cookie, asked.requestId);
  expect((await f.current(cookie, asked.requestId)).summary).toMatchObject({ decisionCount: 4, averages: { decisionScore: 1, actionRankScore: 1 } });
  expect(f.evaluations).toHaveLength(before);
});

test("a summary is only its Guest's: another Guest can't read or retry it, and a request names only a filter and a breakdown", async () => {
  const { cookie } = await twoTables();
  const asked = await f.summarize(cookie);
  const other = await f.guest('Zed');
  expect((await f.readSummary(other, asked.requestId)).status).toBe(404);
  expect((await f.retry(other, asked.requestId)).status).toBe(404);
  expect((await fetch(f.base + '/api/overall-history/summaries/' + asked.requestId)).status).toBe(401);
  expect((await fetch(f.base + '/api/overall-history/summaries', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(401);
  for (const body of [{ breakdown: 'hand' }, { filter: { street: ['flop'] } }, { filter: 'street=flop' }, { other: 1 }])
    expect((await fetch(f.base + '/api/overall-history/summaries', { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(body) })).status).toBe(400);
  await completed(f, cookie, asked.requestId);
});

test('a large summary never has more than 8 history-analysis jobs outstanding for its Guest, while another Guest\'s summary proceeds, and both complete', async () => {
  // Enough running slots that every submitted job runs at once, so the jobs waiting on the fake Strategy are all the outstanding ones.
  const g = await fixture(32);
  fixtures.push(g);
  const heavy = await g.guest('Ann'), light = await g.guest('Ben');
  const tables = [await g.practice(heavy), await g.practice(heavy)];
  for (const t of tables) for (let hand = 0; hand < 3; hand++) await g.checkDown(t);
  const other = await g.practice(light);
  for (let hand = 0; hand < 3; hand++) await g.checkDown(other);
  await g.idle();
  await g.configure(heavy, highestProbabilityPlayingStrategy);
  await g.configure(light, highestProbabilityPlayingStrategy);
  g.hold();
  const large = await g.summarize(heavy);
  expect(large.summary).toMatchObject({ status: 'pending', decisionCount: 24, progress: { succeeded: 0, total: 24 } });
  const small = await g.summarize(light);
  expect(small.summary).toMatchObject({ status: 'pending', decisionCount: 12 });
  const of = (guestTables: { human: string }[]) => () => g.waiting(highestProbabilityPlayingStrategy).filter(evaluation => guestTables.some(t => t.human === evaluation.view.state.actorId)).length;
  await expect.poll(of(tables)).toBe(8);
  await expect.poll(of([other])).toBe(8);
  await new Promise(resolve => setTimeout(resolve, 50));
  expect(of(tables)()).toBe(8);
  // As jobs finish, the rest of the set goes in, never past the bound.
  for (let round = 0; round < 6; round++) {
    g.answer(g.waiting(highestProbabilityPlayingStrategy).find(evaluation => tables.some(t => t.human === evaluation.view.state.actorId))!);
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(of(tables)()).toBeLessThanOrEqual(8);
  }
  g.release();
  await completed(g, heavy, large.requestId);
  await completed(g, light, small.requestId);
  expect((await g.current(heavy, large.requestId)).summary).toMatchObject({ progress: { succeeded: 24, total: 24 }, averages: { decisionScore: 1, actionRankScore: 1 } });
});

test('a summary names a supported Strategy, and an unsupported one is refused', async () => {
  const { cookie } = await twoTables();
  const uniform = supportedStrategies[2]!;
  const asked = await f.summarize(cookie, {}, undefined, uniform);
  expect(asked).toMatchObject({ ok: true, referenceStrategy: uniform, summary: { decisionCount: 5 } });
  await completed(f, cookie, asked.requestId);
  // Naming the Reference Strategy is asking for none: the same request.
  const evaluated = f.evaluations.length;
  expect((await f.summarize(cookie, {}, undefined, highestProbabilityPlayingStrategy)).referenceStrategy).toEqual(highestProbabilityPlayingStrategy);
  await completed(f, cookie, (await f.summarize(cookie)).requestId);
  expect(f.evaluations.length - evaluated).toBe(5);
  for (const strategy of [{}, null, 'uniform-choice', { ...uniform, policy: { ...uniform.policy, id: 'unknown' } }, { policy: uniform.policy }]) {
    const refused = await f.request(cookie, {}, undefined, strategy);
    expect(refused.status, JSON.stringify(strategy)).toBe(400);
    expect(await refused.json()).toMatchObject({ ok: false, rejection: { code: 'unsupported-strategy' } });
  }
});

test('one set summarized under several Strategies uses the same frozen decisions, completes independently and leaves the Trainer Configuration unchanged', async () => {
  // Enough runner capacity that the held Reference Strategy's evaluations don't occupy every slot.
  const g = await fixture(8);
  fixtures.push(g);
  const { cookie } = await twoTables(g);
  const configuration = async () => (await (await fetch(g.base + '/api/trainer-configuration', { headers: { cookie } })).json());
  const before = await configuration();
  const compared = [highestProbabilityPlayingStrategy, supportedStrategies[1]!, supportedStrategies[2]!];
  g.holdUnder(compared[0]);
  const asked: OverallHistorySummary[] = [];
  try {
    for (const strategy of compared) asked.push(await g.summarize(cookie, {}, 'street', strategy));
    expect(new Set(asked.map(summary => summary.requestId)).size).toBe(3);
    expect(asked.map(summary => summary.referenceStrategy)).toEqual(compared);
    expect(asked.map(summary => summary.summary.decisionCount)).toEqual([5, 5, 5]);
    // The others complete while the Reference Strategy's evaluations are held.
    await completed(g, cookie, asked[1]!.requestId);
    await completed(g, cookie, asked[2]!.requestId);
    expect((await g.current(cookie, asked[0]!.requestId)).summary.status).toBe('pending');
  } finally { g.release(); }
  await completed(g, cookie, asked[0]!.requestId);
  // Every Strategy analyzed the same five frozen decisions.
  const decisionIds = (strategy: StrategyDescriptor) => g.under(strategy).map(evaluation => evaluation.decisionId).sort();
  const ids = decisionIds(compared[1]!);
  expect(ids).toHaveLength(5);
  expect(decisionIds(compared[2]!)).toEqual(ids);
  expect(decisionIds(compared[0]!)).toEqual(ids);
  expect(await configuration()).toEqual(before);
});

test("one Strategy's Error and Retry don't touch the summaries under other Strategies", async () => {
  const { cookie } = await twoTables();
  // Not the default Strategy, which post-action analysis already ran under.
  const failing = supportedStrategies[2]!;
  f.failUnder(failing);
  try {
    const bad = await f.summarize(cookie, {}, undefined, failing);
    const good = await f.summarize(cookie);
    await completed(f, cookie, good.requestId);
    await expect.poll(async () => (await f.current(cookie, bad.requestId)).summary.status).toBe('error');
    expect((await f.current(cookie, bad.requestId)).summary).not.toHaveProperty('averages');
    const evaluated = f.under(highestProbabilityPlayingStrategy).length;
    f.failUnder(undefined);
    expect((await f.retry(cookie, bad.requestId)).status).toBe(200);
    await completed(f, cookie, bad.requestId);
    expect((await f.current(cookie, bad.requestId)).summary).toMatchObject({ averages: { decisionScore: 0.8 } });
    expect((await f.current(cookie, good.requestId)).summary).toMatchObject({ status: 'complete', averages: { decisionScore: 0.8 } });
    expect(f.under(highestProbabilityPlayingStrategy).length).toBe(evaluated);
  } finally { f.failUnder(undefined); }
});
