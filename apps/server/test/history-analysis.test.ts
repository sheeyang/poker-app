import { afterAll, beforeAll, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { baselinePlayingStrategy, defaultTrainerConfiguration, highestProbabilityPlayingStrategy, type ConcreteAction, type DecisionAnalysis, type ObservableGameView, type ObservableTableSession, type StrategyDescriptor, type TableHandReplay } from '@poker/contracts';
import { HighestProbabilitySelector, type PolicyResult } from '@poker/strategies';
import { createServer } from '../src/server.js';
import type { TableSessionControllerCommands } from '../src/mutations.js';
import { InstantClock } from './fixtures/clock.js';
import { nameGuest } from './fixtures/guest.js';
import { connectLive } from './fixtures/online.js';

// Analysis of the reader's own decisions in a replay, scheduled as `history-analysis` (ADR-0041). Not a timing test.
const clock = new InstantClock();
const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('Set TEST_DATABASE_URL to a real PostgreSQL test database.');
const administration = new Pool({ connectionString: databaseUrl });
/** Fixtures a test made: each is closed after every test, before the pool ends. */
const fixtures: { close(): Promise<void> }[] = [];
afterAll(async () => { await Promise.all(fixtures.map(fixture => fixture.close())); await administration.end(); });

/** One Reference Strategy Evaluation the fake Strategy was asked for: which decision, under which Strategy. */
interface Evaluation { readonly decisionId: string; readonly descriptor: StrategyDescriptor; readonly view: ObservableGameView; readonly result: ReturnType<typeof Promise.withResolvers<PolicyResult>>; answered: boolean }
/** Any one passive legal action, with all the probability. */
const settle = (view: ObservableGameView): PolicyResult => {
  const action = view.state.legalActions.find(legal => legal.type === 'check' || legal.type === 'call') ?? view.state.legalActions[0]!;
  return { choices: [{ action: { type: action.type } as ConcreteAction, probability: 1 }] };
};

/**
 * A server whose fake Strategy answers at once, until `hold` makes it wait for `release`; `fail` makes the next
 * evaluations fail instead. `concurrency` is the JobRunner's.
 */
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
  /** A Practice Table with the human on the button and the Bot in the big blind. */
  async function practice() {
    const cookie = await guest();
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
  /** A Hand checked down to showdown, whoever has the button: four decisions of the human's, one on each street. */
  async function checkDown(t: Table) {
    await command(t, 'start-hand');
    for (let state = (await read(t)).view.state; state.status === 'active-hand'; state = (await read(t)).view.state) {
      if (state.actorId === t.human) { await humanAct(t, { type: state.legalActions.some(action => action.type === 'check') ? 'check' : 'call' }); continue; }
      // The Bot completes the small blind preflop and checks after that.
      const bot = state.participants.find(participant => participant.participantId === t.bot)!, human = state.participants.find(participant => participant.participantId === t.human)!;
      await botAct(t, { type: (bot.wager ?? 0) < (human.wager ?? 0) ? 'call' : 'check' });
    }
  }
  const replay = async (t: Table, handId = 'hand-1'): Promise<TableHandReplay> => (await get('/table-sessions/' + t.id + '/history/' + handId, t.cookie)).json();
  /** The human's own decisions in a replayed Hand, as its steps mark them. */
  const ownDecisions = async (t: Table, handId = 'hand-1') => (await replay(t, handId)).steps.flatMap(step => step.viewerDecisionId ? [step.viewerDecisionId] : []);
  const submitAnalysis = (t: Table, decisionId: string, options: object) => post('/table-sessions/' + t.id + '/analysis', t.cookie, { decisionId, ...options });
  const analyze = (t: Table, decisionId: string, cookie = t.cookie) => post('/table-sessions/' + t.id + '/analysis', cookie, { decisionId, history: true });
  const analyzed = async (t: Table, decisionId: string): Promise<DecisionAnalysis> => { const response = await analyze(t, decisionId); expect(response.status).toBe(200); return response.json(); };
  const result = async (t: Table, requestId: string): Promise<DecisionAnalysis> => (await get('/table-sessions/' + t.id + '/analysis/' + requestId, t.cookie)).json();
  const retry = async (t: Table, requestId: string): Promise<DecisionAnalysis> => (await post('/table-sessions/' + t.id + '/analysis/' + requestId + '/retry', t.cookie, {})).json();
  const configure = (t: Table, referenceStrategy: StrategyDescriptor) => fetch(base + '/api/trainer-configuration', { method: 'PUT', headers: { cookie: t.cookie, 'content-type': 'application/json' }, body: JSON.stringify({ requestId: randomUUID(), trainerConfiguration: { ...defaultTrainerConfiguration, referenceStrategy } }) });
  /** Every evaluation asked for so far has answered. */
  const idle = () => expect.poll(() => evaluations.every(evaluation => evaluation.answered)).toBe(true);
  /** The evaluations asked for under `descriptor` and still waiting for an answer. */
  const waiting = (descriptor: StrategyDescriptor) => evaluations.filter(evaluation => !evaluation.answered && evaluation.descriptor.policy.id === descriptor.policy.id && evaluation.descriptor.selector.id === descriptor.selector.id);
  return { base, evaluations, guest, practice, read, command, humanAct, botAct, checkDown, replay, ownDecisions, submitAnalysis, analyze, analyzed, result, retry, configure, idle, waiting, answer,
    hold() { holding = true; },
    /** Lets every held evaluation answer, and the ones asked for later answer at once. */
    release() { holding = false; for (const evaluation of evaluations) if (!evaluation.answered) answer(evaluation); },
    fail(count: number) { failing = count; },
    async close() { holding = false; await server.close(); await administration.query('DROP SCHEMA "' + schema + '" CASCADE'); },
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
let f: Fixture;
beforeAll(async () => { f = await fixture(); fixtures.push(f); });
const complete = (f: Fixture, t: { id: string; cookie: string }, requestId: string) => expect.poll(async () => (await f.result(t as never, requestId)).status).toBe('complete');

test('the reader\'s own decision in a replay shows its scored analysis under their Reference Strategy, reusing the cached result without a new job', async () => {
  const t = await f.practice();
  await f.checkDown(t);
  const decisions = await f.ownDecisions(t);
  expect(decisions).toHaveLength(4);
  // Post-action analysis has already evaluated every one of them.
  await expect.poll(() => f.evaluations.filter(evaluation => decisions.includes(evaluation.decisionId)).length).toBe(4);
  await f.idle();
  const asked = f.evaluations.length;
  const state = await f.analyzed(t, decisions[1]!);
  await complete(f, t, state.requestId);
  expect(await f.result(t, state.requestId)).toMatchObject({ tableSessionId: t.id, participantId: t.human, handId: 'hand-1', decisionId: decisions[1], referenceStrategy: defaultTrainerConfiguration.referenceStrategy, scoredDecision: { acceptedAction: { type: 'check' } }, status: 'complete', scores: { decisionScore: expect.any(Number), actionRankScore: expect.any(Number) }, evaluation: { selectedAction: expect.any(Object), actionProbabilities: expect.any(Array) } });
  expect(f.evaluations).toHaveLength(asked);
});

test('after the Reference Strategy changes, the same decision is analyzed under the new one, and the Guest is notified when it is ready', async () => {
  const t = await f.practice();
  await f.checkDown(t);
  const [decisionId] = await f.ownDecisions(t);
  await f.idle();
  const before = await f.analyzed(t, decisionId!);
  await complete(f, t, before.requestId);
  const live = await connectLive(f.base, t.cookie, t.id);
  expect((await f.configure(t, highestProbabilityPlayingStrategy)).status).toBe(200);
  f.hold();
  const after = await f.analyzed(t, decisionId!);
  expect(after).toMatchObject({ status: 'pending', decisionId, referenceStrategy: highestProbabilityPlayingStrategy });
  expect(after.requestId).not.toBe(before.requestId);
  await expect.poll(() => f.waiting(highestProbabilityPlayingStrategy).map(evaluation => evaluation.decisionId)).toEqual([decisionId]);
  f.release();
  await expect.poll(() => live.messages.some(message => message.type === 'analysis-update' && message.requestId === after.requestId && message.status === 'complete')).toBe(true);
  expect(await f.result(t, after.requestId)).toMatchObject({ status: 'complete', referenceStrategy: highestProbabilityPlayingStrategy, scores: { decisionScore: expect.any(Number) } });
  // The earlier request keeps the Strategy it captured.
  expect(await f.result(t, before.requestId)).toMatchObject({ status: 'complete', referenceStrategy: defaultTrainerConfiguration.referenceStrategy });
});

test('analysis can\'t be asked for from history for a Bot\'s decision, a decision not yet taken, or by a Guest who never played at the table', async () => {
  const t = await f.practice();
  await f.checkDown(t);
  const steps = (await f.replay(t)).steps;
  const botDecision = steps.find(step => step.kind === 'decision' && step.state.actorId === t.bot)!.state.decisionId!;
  const response = await f.analyze(t, botDecision);
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ ok: false, rejection: { code: 'decision-unavailable' } });
  // In the next Hand the Bot has the button; then the human's check is not yet taken: history analyzes only accepted decisions.
  await f.command(t, 'start-hand');
  await f.botAct(t, { type: 'call' });
  const current = (await f.read(t)).view.state;
  expect(current.actorId).toBe(t.human);
  expect((await f.analyze(t, current.decisionId!)).status).toBe(400);
  // Someone who was never a Participant learns nothing about the table.
  const stranger = await f.guest('Ben');
  const refused = await f.analyze(t, (await f.ownDecisions(t))[0]!, stranger);
  expect(refused.status).toBe(404);
  expect(await refused.json()).toMatchObject({ ok: false, rejection: { code: 'not-found' } });
});

test('a failed history analysis shows Error, and Retry analyzes it again', async () => {
  const t = await f.practice();
  await f.checkDown(t);
  const [decisionId] = await f.ownDecisions(t);
  await f.idle();
  expect((await f.configure(t, baselinePlayingStrategy)).status).toBe(200);
  f.fail(1);
  const failed = await f.analyzed(t, decisionId!);
  await expect.poll(async () => (await f.result(t, failed.requestId)).status).toBe('error');
  const retried = await f.retry(t, failed.requestId);
  expect(retried).toMatchObject({ requestId: failed.requestId, referenceStrategy: baselinePlayingStrategy });
  expect(retried.attemptId).not.toBe(failed.attemptId);
  await complete(f, t, failed.requestId);
});

test('a Guest never has more than 8 history-analysis jobs outstanding: the rest are held without a capacity error, and every one completes', async () => {
  // Enough running slots that every submitted job runs at once, so the jobs waiting on the fake Strategy are all the outstanding ones.
  const g = await fixture(32);
  fixtures.push(g);
  const t = await g.practice();
  for (let hand = 0; hand < 3; hand++) await g.checkDown(t);
  const decisions = (await Promise.all(['hand-1', 'hand-2', 'hand-3'].map(hand => g.ownDecisions(t, hand)))).flat();
  expect(decisions).toHaveLength(12);
  await g.idle();
  expect((await g.configure(t, highestProbabilityPlayingStrategy)).status).toBe(200);
  g.hold();
  const requests = await Promise.all(decisions.map(decisionId => g.analyzed(t, decisionId)));
  expect(requests.map(request => request.status)).toEqual(Array(12).fill('pending'));
  await expect.poll(() => g.waiting(highestProbabilityPlayingStrategy).length).toBe(8);
  await new Promise(resolve => setTimeout(resolve, 50));
  expect(g.waiting(highestProbabilityPlayingStrategy)).toHaveLength(8);
  // One finishing lets the next held one in: its scores and the next evaluation share the freed place in turn.
  g.answer(g.waiting(highestProbabilityPlayingStrategy)[0]!);
  await expect.poll(() => g.evaluations.filter(evaluation => evaluation.descriptor.selector.id === 'highest-probability').length).toBe(9);
  expect(g.waiting(highestProbabilityPlayingStrategy).length).toBeLessThanOrEqual(8);
  g.release();
  for (const request of requests) await complete(g, t, request.requestId);
  expect(g.evaluations.filter(evaluation => evaluation.descriptor.selector.id === 'highest-probability').map(evaluation => evaluation.decisionId).sort()).toEqual([...decisions].sort());
});

test('Live Analysis and post-action analysis run ahead of queued history-analysis work', async () => {
  const g = await fixture(1);
  fixtures.push(g);
  const t = await g.practice();
  await g.checkDown(t);
  const decisions = await g.ownDecisions(t);
  await g.idle();
  expect((await g.configure(t, highestProbabilityPlayingStrategy)).status).toBe(200);
  g.hold();
  for (const decisionId of decisions.slice(0, 3)) await g.analyzed(t, decisionId);
  // One history evaluation runs in the only slot; two more wait behind it.
  await expect.poll(() => g.waiting(highestProbabilityPlayingStrategy).map(evaluation => evaluation.decisionId)).toEqual([decisions[0]]);
  // Hand 2: the Bot has the button and completes the small blind; the human's check is the current decision.
  await g.command(t, 'start-hand');
  await g.botAct(t, { type: 'call' });
  const current = (await g.read(t)).view.state.decisionId!;
  expect((await g.submitAnalysis(t, current, { live: true })).status).toBe(200);
  const next = async () => {
    const running = g.waiting(highestProbabilityPlayingStrategy)[0]!;
    g.answer(running);
    await expect.poll(() => g.waiting(highestProbabilityPlayingStrategy)[0]?.decisionId).not.toBe(running.decisionId);
    return g.waiting(highestProbabilityPlayingStrategy)[0]!.decisionId;
  };
  // Live Analysis of the current decision goes ahead of both history jobs still queued.
  expect(await next()).toBe(current);
  await g.humanAct(t, { type: 'check' });
  // Post-flop the human acts first, and their check starts post-action analysis: it too goes ahead of them.
  const flop = (await g.read(t)).view.state.decisionId!;
  await g.humanAct(t, { type: 'check' });
  // Asking for it again waits until that post-action work is queued, and reuses it at its own priority.
  expect((await g.submitAnalysis(t, flop, {})).status).toBe(200);
  expect(await next()).toBe(flop);
  expect(await next()).toBe(decisions[1]);
  expect(await next()).toBe(decisions[2]);
  g.release();
});
