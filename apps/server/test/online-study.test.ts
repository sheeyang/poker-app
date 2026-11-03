import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { baselinePlayingStrategy, highestProbabilityPlayingStrategy, simpleHeuristicPlayingStrategy, type DecisionAnalysis, type ObservableGameView, type ObservableTableSession, type ObservableTableUpdate, type ScoreSummary, type StrategyDescriptor } from '@poker/contracts';
import { createStrategy, type Strategy } from '@poker/strategies';
import { createServer } from '../src/server.js';
import { nameGuest } from './fixtures/guest.js';
import { ManualClock } from './fixtures/clock.js';
import { connectLive, type LiveConnection, announcedCountdown } from './fixtures/online.js';

// Online Tables always have Action Deadlines, so time moves only when a test moves it.
const clock = new ManualClock();
const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('Set TEST_DATABASE_URL to a real PostgreSQL test database.');
const schema = 'test_' + randomUUID().replaceAll('-', '');
const administration = new Pool({ connectionString: databaseUrl });
let server: Awaited<ReturnType<typeof createServer>>;
let base: string;
/**
 * Every Reference Strategy evaluation the server started, with the view it was given. There are no Bots: each is a
 * human's analysis. While `holding`, evaluations wait until `release()` (or until the server cancels them).
 */
const evaluations: { decisionId: string; participantId: string; strategy: string; view: ObservableGameView }[] = [];
const strategyName = (descriptor: StrategyDescriptor) => descriptor.policy.id + '/' + descriptor.selector.id;
let holding = false;
const held: (() => void)[] = [];
function release() { holding = false; for (const resume of held.splice(0)) resume(); }
function observed(descriptor: StrategyDescriptor): Strategy {
  const strategy = createStrategy(descriptor);
  return { actionSelector: strategy.actionSelector, policy: {
    checkCompatibility: view => strategy.policy.checkCompatibility(view),
    evaluate: async (view, options) => {
      evaluations.push({ decisionId: view.state.decisionId!, participantId: view.state.actorId!, strategy: strategyName(descriptor), view });
      if (holding) await new Promise<void>(resume => { held.push(resume); options.signal?.addEventListener('abort', () => resume(), { once: true }); });
      return strategy.policy.evaluate(view, options);
    },
  } };
}
async function startServer() {
  // Held evaluations stay pending for as long as a test needs, never reaching the computation timeout.
  server = await createServer({ clock, automaticBots: false, databaseUrl: databaseUrl!, schema, strategyFactory: observed, jobRunnerOptions: { timeoutMs: 120_000 } });
  base = await server.listen({ host: '127.0.0.1', port: 0 });
}
beforeAll(async () => { await administration.query('CREATE SCHEMA "' + schema + '"'); await startServer(); });
beforeEach(() => { release(); evaluations.length = 0; });
afterAll(async () => { await server?.close(); await administration.query('DROP SCHEMA "' + schema + '" CASCADE'); await administration.end(); });

/** Each cookie is a separate Guest. */
async function guest(name: string) {
  const cookie = (await fetch(base + '/api/identity')).headers.get('set-cookie')!.split(';')[0]!;
  await nameGuest(base, cookie, name);
  return cookie;
}
const get = (path: string, cookie: string) => fetch(base + path, { headers: { cookie } });
const post = (path: string, cookie: string, body: unknown) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(body) });
const refusal = async (response: Response) => ({ status: response.status, code: (await response.json()).rejection?.code });
const stakes = { seatCount: 3, smallBlind: 10, bigBlind: 20, minimumBuyIn: 1000, defaultBuyIn: 1000, maximumBuyIn: 1000 };

/** A table of Ann's; at an Online Table Ben joins through its Join Link. */
async function table(mode: 'practice' | 'online' = 'online') {
  const ann = await guest('Ann');
  const created = await (await post('/api/table-sessions', ann, { requestId: randomUUID(), mode, configuration: stakes })).json();
  const id = created.tableSessionId as string;
  const annId = created.bindings[0].participantId as string;
  const view = async (cookie = ann): Promise<ObservableTableSession> => (await get('/api/table-sessions/' + id, cookie)).json();
  const t = {
    id, ann, annId, view,
    async join(name: string) {
      const cookie = await guest(name);
      const joined = await (await post('/api/join-links/' + (await view()).joinToken! + '/join', cookie, { requestId: randomUUID() })).json();
      return { cookie, participantId: joined.participantId as string };
    },
    /** A poker mutation from a Guest, at the poker revision that Guest last saw. */
    async as(cookie: string, kind: string, fields: object = {}) {
      return post('/api/table-sessions/' + id + '/' + kind, cookie, { requestId: randomUUID(), expectedPokerRevision: (await view(cookie)).pokerRevision, ...fields });
    },
    /** The owner's table options change, at the session revision that Guest last saw. */
    async options(options: object, cookie = ann, requestId: string = randomUUID()) {
      return post('/api/table-sessions/' + id + '/set-table-options', cookie, { requestId, expectedSessionRevision: (await view(cookie)).sessionRevision, options });
    },
    connect: (cookie = ann) => connectLive(base, cookie, id),
    /** Analysis of a decision for the requesting Guest's own Participant; `live` asks for it as Live Analysis. */
    analyze: (cookie: string, decisionId: string, live?: true) => post('/api/table-sessions/' + id + '/analysis', cookie, { decisionId, ...(live ? { live } : {}) }),
    result: async (cookie: string, requestId: string): Promise<DecisionAnalysis> => (await get('/api/table-sessions/' + id + '/analysis/' + requestId, cookie)).json(),
    summary: async (cookie: string, path: 'hand-summaries' | 'session-summaries', body: object): Promise<ScoreSummary> => (await post('/api/table-sessions/' + id + '/' + path, cookie, body)).json(),
    summaryResult: async (cookie: string, requestId: string): Promise<ScoreSummary> => (await get('/api/table-sessions/' + id + '/summaries/' + requestId, cookie)).json(),
  };
  return t;
}
type Table = Awaited<ReturnType<typeof table>>;
/** Ann's Online Table with Ben joined; both connected and seated heads-up, so the table deals by itself. */
async function headsUp() {
  const t = await table();
  const ben = await t.join('Ben');
  await t.connect(); await t.connect(ben.cookie);
  expect((await t.as(t.ann, 'seat-participant', { participantId: t.annId, seat: 1 })).status).toBe(200);
  expect((await t.as(ben.cookie, 'seat-participant', { participantId: ben.participantId, seat: 2 })).status).toBe(200);
  const cookieOf = (participantId: string) => participantId === t.annId ? t.ann : ben.cookie;
  return { t, ben, cookieOf };
}
/** Lets the announced Next-Hand Countdown run out and the deal phase pass: the Hand's first Action Window is open. */
async function dealt(t: Table, handId: string) {
  await expect.poll(async () => (await t.view()).schedule.nextHandCountdown).toBeDefined();
  clock.advanceTo((await announcedCountdown(() => t.view())).endsAt);
  await expect.poll(async () => (await t.view()).view.state.handId).toBe(handId);
  clock.advance(1500);
  return t.view();
}
/** The acting human folds; then the payout phase and the pause between Hands pass, and the next countdown is announced. */
async function foldHand(t: Table, cookieOf: (participantId: string) => string) {
  const actor = (await t.view()).view.state.actorId!;
  expect((await t.as(cookieOf(actor), 'act', { participantId: actor, action: { type: 'fold' } })).status).toBe(200);
  clock.advance(5000);
  await expect.poll(async () => (await t.view()).schedule.nextHandCountdown).toBeDefined();
}
const updates = (connection: LiveConnection) => connection.messages.filter((message): message is ObservableTableUpdate => message.type === 'table-update');

test('Allow Live Analysis is an Online Table option, on by default and visible to everyone, that only the owner changes, and only between Hands', async () => {
  const t = await table();
  const ben = await t.join('Ben');
  for (const cookie of [t.ann, ben.cookie]) expect((await t.view(cookie)).options).toEqual({ actionTimeLimitSeconds: 30, allowLiveAnalysis: true });
  const benLive = await t.connect(ben.cookie);

  // Only the Table Owner changes table options, with a valid partial options object, at the revision they saw.
  expect(await refusal(await t.options({ allowLiveAnalysis: false }, ben.cookie))).toEqual({ status: 403, code: 'table-owner-required' });
  for (const options of [{}, { allowLiveAnalysis: 'no' }, { allowLiveAnalysis: null }, { liveAnalysis: false }, []])
    expect(await refusal(await t.options(options))).toEqual({ status: 400, code: 'invalid-table-options' });
  const stale = await post('/api/table-sessions/' + t.id + '/set-table-options', t.ann, { requestId: randomUUID(), expectedSessionRevision: (await t.view()).sessionRevision - 1, options: { allowLiveAnalysis: false } });
  expect(await refusal(stale)).toEqual({ status: 409, code: 'stale-session-revision' });
  expect((await t.view()).options.allowLiveAnalysis).toBe(true);

  const before = await t.view();
  const changed = await t.options({ allowLiveAnalysis: false }, t.ann, 'disallow');
  expect(changed.status).toBe(200);
  expect(await changed.json()).toEqual({ ok: true, tableSessionId: t.id, pokerRevision: before.pokerRevision, sessionRevision: before.sessionRevision + 1 });
  // Everyone sees the table's setting, in their views and live.
  for (const cookie of [t.ann, ben.cookie]) expect((await t.view(cookie)).options).toEqual({ actionTimeLimitSeconds: 30, allowLiveAnalysis: false });
  await expect.poll(() => updates(benLive).at(-1)?.options).toEqual({ actionTimeLimitSeconds: 30, allowLiveAnalysis: false });
  // A retry returns the remembered outcome; setting the current value again changes nothing.
  expect(await (await post('/api/table-sessions/' + t.id + '/set-table-options', t.ann, { requestId: 'disallow', expectedSessionRevision: before.sessionRevision, options: { allowLiveAnalysis: false } })).json()).toMatchObject({ ok: true, sessionRevision: before.sessionRevision + 1 });
  const unchanged = await t.view();
  expect(await (await t.options({ allowLiveAnalysis: false })).json()).toEqual({ ok: true, tableSessionId: t.id, pokerRevision: unchanged.pokerRevision, sessionRevision: unchanged.sessionRevision });
  expect(await t.view()).toEqual(unchanged);

  // Not during a Hand, until its payout phase ends.
  await t.connect();
  expect((await t.as(t.ann, 'seat-participant', { participantId: t.annId, seat: 1 })).status).toBe(200);
  expect((await t.as(ben.cookie, 'seat-participant', { participantId: ben.participantId, seat: 2 })).status).toBe(200);
  clock.advanceTo((await announcedCountdown(() => t.view())).endsAt);
  await expect.poll(async () => (await t.view()).view.state.status).toBe('active-hand');
  expect(await refusal(await t.options({ allowLiveAnalysis: true }))).toEqual({ status: 400, code: 'active-hand' });
  clock.advance(1500);
  const actor = (await t.view()).view.state.actorId!;
  expect((await t.as(actor === t.annId ? t.ann : ben.cookie, 'act', { participantId: actor, action: { type: 'fold' } })).status).toBe(200);
  expect(await refusal(await t.options({ allowLiveAnalysis: true }))).toEqual({ status: 400, code: 'active-hand' });
  clock.advance(2000);
  expect((await t.options({ allowLiveAnalysis: true })).status).toBe(200);
  expect((await t.view(ben.cookie)).options.allowLiveAnalysis).toBe(true);

  // A Practice Table has no such option to change.
  const practice = await table('practice');
  expect(await refusal(await practice.options({ allowLiveAnalysis: false }))).toEqual({ status: 403, code: 'unavailable-at-practice-tables' });
});

test('Live Analysis of a decision whose Action Window opened while the table disallowed it is refused, while post-action analysis and scoring continue', async () => {
  const { t, ben, cookieOf } = await headsUp();
  // Allowed: the acting human may evaluate their current decision before acting.
  let hand = await dealt(t, 'hand-1');
  expect(hand.schedule.actionWindow).not.toHaveProperty('liveAnalysisDisallowed');
  expect((await t.analyze(cookieOf(hand.view.state.actorId!), hand.view.state.decisionId!, true)).status).toBe(200);
  await foldHand(t, cookieOf);

  // Disallowed between Hands: from the next decision on, every window captures it, and everyone sees that.
  expect((await t.options({ allowLiveAnalysis: false })).status).toBe(200);
  hand = await dealt(t, 'hand-2');
  const actor = hand.view.state.actorId!, decisionId = hand.view.state.decisionId!;
  expect(hand.schedule.actionWindow).toMatchObject({ participantId: actor, decisionId, liveAnalysisDisallowed: true });
  expect((await t.view(ben.cookie)).schedule.actionWindow).toMatchObject({ decisionId, liveAnalysisDisallowed: true });
  for (const live of [true, undefined] as const)
    expect(await refusal(await t.analyze(cookieOf(actor), decisionId, live))).toEqual({ status: 403, code: 'live-analysis-disallowed' });
  // The captured value is durable: a restart restores the window as it opened.
  await server.close(); await startServer();
  await t.connect(); await t.connect(ben.cookie);
  expect((await t.view()).schedule.actionWindow).toMatchObject({ decisionId, liveAnalysisDisallowed: true });
  expect(await refusal(await t.analyze(cookieOf(actor), decisionId, true))).toEqual({ status: 403, code: 'live-analysis-disallowed' });
  expect(evaluations.some(evaluation => evaluation.decisionId === decisionId)).toBe(false);

  // Once the decision is accepted, post-action analysis starts by itself and is scored.
  await foldHand(t, cookieOf);
  await expect.poll(() => evaluations.some(evaluation => evaluation.decisionId === decisionId)).toBe(true);
  const scored = await (await t.analyze(cookieOf(actor), decisionId)).json() as DecisionAnalysis;
  expect(scored).toMatchObject({ participantId: actor, decisionId, scoredDecision: { acceptedAction: { type: 'fold' } } });
  await expect.poll(async () => (await t.result(cookieOf(actor), scored.requestId)).status).toBe('complete');
  expect(await t.result(cookieOf(actor), scored.requestId)).toMatchObject({ scores: { decisionScore: expect.any(Number), actionRankScore: expect.any(Number) } });

  // Allowed again between Hands: it applies from the next decision.
  expect((await t.options({ allowLiveAnalysis: true })).status).toBe(200);
  hand = await dealt(t, 'hand-3');
  expect(hand.schedule.actionWindow).not.toHaveProperty('liveAnalysisDisallowed');
  expect((await t.analyze(cookieOf(hand.view.state.actorId!), hand.view.state.decisionId!, true)).status).toBe(200);
});

test('an Online Timeout Action is scored as the humanâ€™s own decision, in Decision Scores and in Hand and Session summaries', async () => {
  const { t, cookieOf } = await headsUp();
  const hand = await dealt(t, 'hand-1');
  const { participantId: actor, decisionId, deadlineAt } = hand.schedule.actionWindow!;
  clock.advanceTo(deadlineAt! + 1);
  await expect.poll(async () => (await t.view()).view.history[0]?.decisions.at(-1)?.action).toEqual({ participantId: actor, action: { type: 'fold' } });
  // Post-action analysis starts by itself, as for an action the human chose, and only for that human.
  await expect.poll(() => evaluations.filter(evaluation => evaluation.decisionId === decisionId).map(evaluation => evaluation.participantId)).toEqual([actor]);
  const scored = await (await t.analyze(cookieOf(actor), decisionId)).json() as DecisionAnalysis;
  expect(scored).toMatchObject({ participantId: actor, decisionId, scoredDecision: { acceptedAction: { type: 'fold' } } });
  await expect.poll(async () => (await t.result(cookieOf(actor), scored.requestId)).status).toBe('complete');
  expect(await t.result(cookieOf(actor), scored.requestId)).toMatchObject({ scores: { decisionScore: expect.any(Number), actionRankScore: expect.any(Number) } });
  clock.advance(2000);
  for (const [path, body] of [['hand-summaries', { handId: 'hand-1' }], ['session-summaries', {}]] as const) {
    const summary = await t.summary(cookieOf(actor), path, body);
    expect(summary).toMatchObject({ decisionIds: [decisionId], decisionCount: 1 });
    await expect.poll(async () => (await t.summaryResult(cookieOf(actor), summary.requestId)).status).toBe('complete');
  }
});

test('held analysis never delays an action, an Action Deadline or the next deal', async () => {
  const t = await table();
  const ben = await t.join('Ben'), cy = await t.join('Cy');
  const cookieOf = (participantId: string) => participantId === t.annId ? t.ann : participantId === ben.participantId ? ben.cookie : cy.cookie;
  for (const [cookie, participantId, seat] of [[t.ann, t.annId, 1], [ben.cookie, ben.participantId, 2], [cy.cookie, cy.participantId, 3]] as const) {
    await t.connect(cookie);
    expect((await t.as(cookie, 'seat-participant', { participantId, seat })).status).toBe(200);
  }
  holding = true;
  const hand = await dealt(t, 'hand-1');
  // The first to act asks for Live Analysis, which stays pending, and acts anyway: the action is accepted at once.
  const first = hand.view.state.actorId!;
  const live = await (await t.analyze(cookieOf(first), hand.view.state.decisionId!, true)).json() as DecisionAnalysis;
  await expect.poll(() => evaluations.length).toBe(1);
  expect((await t.as(cookieOf(first), 'act', { participantId: first, action: { type: 'fold' } })).status).toBe(200);
  expect(await t.result(cookieOf(first), live.requestId)).toMatchObject({ status: 'pending' });
  // The next human's Live Analysis is pending too, and their Action Deadline still plays the Timeout Action on time.
  const waiting = await t.view();
  const second = waiting.view.state.actorId!, deadlineAt = waiting.schedule.actionWindow!.deadlineAt!;
  const secondLive = await (await t.analyze(cookieOf(second), waiting.view.state.decisionId!, true)).json() as DecisionAnalysis;
  clock.advanceTo(deadlineAt);
  expect((await t.view()).pokerRevision).toBe(waiting.pokerRevision);
  clock.advance(1);
  await expect.poll(async () => (await t.view()).view.state.status).toBe('completed-hand');
  expect((await t.view()).view.history[0]!.decisions.map(decision => decision.action)).toEqual([{ participantId: first, action: { type: 'fold' } }, { participantId: second, action: { type: 'fold' } }]);
  // The next Hand is announced after the payout and the pause, and dealt when its countdown runs out.
  clock.advance(5000);
  await expect.poll(async () => (await t.view()).schedule.nextHandCountdown).toBeDefined();
  clock.advanceTo((await announcedCountdown(() => t.view())).endsAt);
  await expect.poll(async () => (await t.view()).view.state.handId).toBe('hand-2');
  for (const [cookie, requestId] of [[cookieOf(first), live.requestId], [cookieOf(second), secondLive.requestId]] as const)
    expect(await t.result(cookie, requestId)).toMatchObject({ status: 'pending' });
  // Released, the analysis completes for each human's own decision.
  release();
  for (const [cookie, requestId] of [[cookieOf(first), live.requestId], [cookieOf(second), secondLive.requestId]] as const)
    await expect.poll(async () => (await t.result(cookie, requestId)).status).toBe('complete');
});

test('two humans in one Hand study privately, from what each observed at the decision: later streets, the showdown and later Hands never reach the analysis', async () => {
  const { t, ben, cookieOf } = await headsUp();
  const annLive = await t.connect(), benLive = await t.connect(ben.cookie);
  const study = async (cookie: string, referenceStrategy: StrategyDescriptor) => {
    const response = await post('/api/table-sessions/' + t.id + '/set-trainer-configuration', cookie, { requestId: randomUUID(), expectedSessionRevision: (await t.view(cookie)).sessionRevision, trainerConfiguration: { referenceStrategy, liveAnalysis: true } });
    expect(response.status).toBe(200);
  };
  await study(ben.cookie, baselinePlayingStrategy);
  // Both humans check Hand 1 down to a showdown, each recording the view they had at each of their decisions.
  await dealt(t, 'hand-1');
  const seen = new Map<string, { participantId: string; view: ObservableGameView }>();
  for (let current = await t.view(); current.view.state.status === 'active-hand'; current = await t.view()) {
    const window = current.schedule.actionWindow!;
    if (clock.now() < window.opensAt) clock.advanceTo(window.opensAt);
    const actor = window.participantId, own = await t.view(cookieOf(actor));
    seen.set(window.decisionId, { participantId: actor, view: own.view });
    const action = own.view.state.legalActions.some(legal => legal.type === 'check') ? 'check' : 'call';
    expect((await t.as(cookieOf(actor), 'act', { participantId: actor, action: { type: action } })).status).toBe(200);
  }
  expect([...seen.values()].map(entry => entry.view.state.street)).toEqual(['preflop', 'preflop', 'flop', 'flop', 'turn', 'turn', 'river', 'river']);
  // The showdown has since revealed each human's cards to the other, and a later Hand has been dealt.
  const shown = (await t.view(ben.cookie)).view.history[0]!.result!.participants.find(participant => participant.participantId === t.annId)!;
  expect(shown.holeCards).toHaveLength(2);
  clock.advance(7000);
  await dealt(t, 'hand-2');
  const later = await t.view();
  expect((await t.as(cookieOf(later.view.state.actorId!), 'act', { participantId: later.view.state.actorId!, action: { type: 'fold' } })).status).toBe(200);

  // A new Reference Strategy analyzes each Hand 1 decision afresh, for its own human only.
  const reference = { [t.annId]: highestProbabilityPlayingStrategy, [ben.participantId]: simpleHeuristicPlayingStrategy };
  await study(t.ann, reference[t.annId]!); await study(ben.cookie, reference[ben.participantId]!);
  const requested: { cookie: string; requestId: string }[] = [];
  for (const [decisionId, { participantId }] of seen) {
    const cookie = cookieOf(participantId), other = participantId === t.annId ? ben.cookie : t.ann;
    // Nobody captures another human's decision.
    expect(await refusal(await t.analyze(other, decisionId))).toEqual({ status: 400, code: 'decision-unavailable' });
    const analysis = await (await t.analyze(cookie, decisionId)).json() as DecisionAnalysis;
    expect(analysis).toMatchObject({ participantId, decisionId, referenceStrategy: reference[participantId] });
    requested.push({ cookie, requestId: analysis.requestId });
    for (const path of ['/analysis/' + analysis.requestId, '/analysis/' + analysis.requestId + '/retry'])
      expect((await (path.endsWith('retry') ? post('/api/table-sessions/' + t.id + path, other, {}) : get('/api/table-sessions/' + t.id + path, other))).status).toBe(404);
  }
  for (const { cookie, requestId } of requested) await expect.poll(async () => (await t.result(cookie, requestId)).status).toBe('complete');
  // Each evaluation saw exactly what its human observed at that decision: no later street, no opponent's cards.
  const fresh = evaluations.filter(evaluation => evaluation.strategy === strategyName(reference[evaluation.participantId]!));
  expect(fresh.map(evaluation => [evaluation.decisionId, evaluation.participantId])).toEqual([...seen].map(([decisionId, entry]) => [decisionId, entry.participantId]));
  for (const evaluation of fresh) {
    expect(evaluation.view).toEqual(seen.get(evaluation.decisionId)!.view);
    const others = evaluation.view.state.participants.filter(participant => participant.participantId !== evaluation.participantId);
    expect(others.every(participant => participant.holeCards === undefined)).toBe(true);
    expect(evaluation.view.state.board).toHaveLength({ preflop: 0, flop: 3, turn: 4, river: 5 }[evaluation.view.state.street!]);
    expect(evaluation.view.history.every(entry => entry.handId === 'hand-1')).toBe(true);
  }
  // Responses carry no cards, deck or seed of the game, and each human is told only of their own analysis.
  for (const { cookie, requestId } of requested)
    expect(JSON.stringify(await t.result(cookie, requestId))).not.toMatch(/"(?:holeCards|board|deck|burns|seed|commands|view|history)"\s*:/);
  const notified = (connection: LiveConnection) => connection.messages.flatMap(message => message.type === 'analysis-update' ? [message.requestId] : []);
  await expect.poll(() => requested.every(({ cookie, requestId }) => notified(cookie === t.ann ? annLive : benLive).includes(requestId))).toBe(true);
  for (const [connection, cookie] of [[annLive, t.ann], [benLive, ben.cookie]] as const)
    expect(notified(connection).filter(requestId => requested.some(entry => entry.requestId === requestId && entry.cookie !== cookie))).toEqual([]);
});
