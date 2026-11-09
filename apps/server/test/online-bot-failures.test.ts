import { afterAll, beforeAll, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import type { ConcreteAction, ObservableGameView, ObservableTableSession, StrategyDescriptor, TableRuntimeStatus } from '@poker/contracts';
import { createStrategy, HighestProbabilitySelector, type Strategy } from '@poker/strategies';
import { createServer } from '../src/server.js';
import { nameGuest } from './fixtures/guest.js';
import { ManualClock } from './fixtures/clock.js';
import { connectLive, type LiveConnection, announcedCountdown } from './fixtures/online.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('Set TEST_DATABASE_URL to a real PostgreSQL test database.');
const schema = 'test_' + randomUUID().replaceAll('-', '');
const administration = new Pool({ connectionString: databaseUrl });
const clock = new ManualClock();
let server: Awaited<ReturnType<typeof createServer>>;
let base: string;
/** What the fixture Strategy does at each evaluation, in order: fail, or choose an action. Afterwards it checks or calls. */
const plans: ('fail' | ConcreteAction)[] = [];
/** Every evaluation the Bot was asked for: its input view and seed. */
const evaluations: { view: ObservableGameView; seed: string }[] = [];
const fixture: StrategyDescriptor = { policy: { id: 'fixture', version: 'v1', configuration: {} }, selector: { id: 'highest-probability', version: 'v1', configuration: {} } };
/** While `holdingAnalysis`, every other Strategy's evaluation (a human's analysis here) waits until `releaseAnalyses()`. */
let holdingAnalysis = false;
const heldAnalyses: (() => void)[] = [];
function releaseAnalyses() { holdingAnalysis = false; for (const resume of heldAnalyses.splice(0)) resume(); }
function held(strategy: Strategy): Strategy {
  return { actionSelector: strategy.actionSelector, policy: {
    checkCompatibility: view => strategy.policy.checkCompatibility(view),
    evaluate: async (view, options) => {
      if (holdingAnalysis) await new Promise<void>(resume => { heldAnalyses.push(resume); options.signal?.addEventListener('abort', () => resume(), { once: true }); });
      return strategy.policy.evaluate(view, options);
    },
  } };
}
beforeAll(async () => {
  await administration.query('CREATE SCHEMA "' + schema + '"');
  // Bots act by themselves here, through the controllable fixture Strategy. Analysis may run one job at a time and
  // queue none, so a single held analysis fills the computation it may use.
  server = await createServer({ clock, databaseUrl: databaseUrl!, schema, jobRunnerOptions: { concurrency: 1, maximumQueued: 0, timeoutMs: 60_000 },
    supportsStrategy: value => !!value && typeof value === 'object' && ['fixture', 'uniform-choice', 'simple-heuristic'].includes((value as StrategyDescriptor).policy?.id),
    strategyFactory: descriptor => descriptor.policy.id !== 'fixture' ? held(createStrategy(descriptor)) : {
      policy: {
        checkCompatibility: () => ({ compatible: true }),
        evaluate: (view, execution) => {
          evaluations.push({ view, seed: execution.evaluationSeed });
          const plan = plans.shift();
          if (plan === 'fail') throw new Error('untrusted Strategy failure');
          const action = plan ?? (view.state.legalActions.some(legal => legal.type === 'check') ? { type: 'check' } : { type: 'call' });
          return { choices: [{ action, probability: 1 }] };
        },
      },
      actionSelector: new HighestProbabilitySelector(),
    } });
  base = await server.listen({ host: '127.0.0.1', port: 0 });
});
afterAll(async () => { releaseAnalyses(); await server?.close(); await administration.query('DROP SCHEMA "' + schema + '" CASCADE'); await administration.end(); });

async function guest(name: string) {
  const cookie = (await fetch(base + '/api/identity')).headers.get('set-cookie')!.split(';')[0]!;
  await nameGuest(base, cookie, name);
  return cookie;
}
const post = (path: string, cookie: string, body: unknown) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(body) });
const statuses = (connection: LiveConnection) => connection.messages.filter((message): message is TableRuntimeStatus => message.type === 'table-status').map(message => message.status);

/**
 * An Online Table of Ann with the fixture Bot Rex in seat 1, the button, and Ann in seat 2, both connected. Ben
 * watches, connected too. The countdown has run out and the deal phase passed: Rex's first Action Window is open.
 */
async function botToAct() {
  const ann = await guest('Ann');
  const created = await (await post('/api/table-sessions', ann, { requestId: randomUUID(), mode: 'online', configuration: { seatCount: 2 }, bots: [{ name: 'Rex', playingStrategy: fixture }] })).json();
  const id = created.tableSessionId as string;
  const [annId, rex] = created.bindings.map((binding: { participantId: string }) => binding.participantId) as [string, string];
  const view = async (cookie = ann): Promise<ObservableTableSession> => (await fetch(base + '/api/table-sessions/' + id, { headers: { cookie } })).json();
  const as = async (cookie: string, kind: string, fields: object) => post('/api/table-sessions/' + id + '/' + kind, cookie, { requestId: randomUUID(), expectedPokerRevision: (await view(cookie)).pokerRevision, ...fields });
  const ben = await guest('Ben');
  await post('/api/table-sessions/' + id + '/join-table', ben, { requestId: randomUUID() });
  const annLive = await connectLive(base, ann, id), benLive = await connectLive(base, ben, id);
  expect((await as(ann, 'seat-participant', { participantId: rex, seat: 1 })).status).toBe(200);
  expect((await as(ann, 'seat-participant', { participantId: annId, seat: 2 })).status).toBe(200);
  clock.advanceTo((await announcedCountdown(() => view())).endsAt);
  await expect.poll(async () => (await view()).view.state.handId).toBe('hand-1');
  clock.advance(1500);
  return { id, ann, annId, rex, ben, view, as, annLive, benLive };
}

test('at an Online Table a failed Bot decision is retried once with identical inputs and seeds, and play continues when the retry succeeds', async () => {
  plans.splice(0, Infinity, 'fail', { type: 'call' }); evaluations.length = 0;
  const t = await botToAct();
  await expect.poll(async () => (await t.view()).view.state.actorId).toBe(t.annId);
  expect(evaluations).toHaveLength(2);
  expect(evaluations[1]!.view).toEqual(evaluations[0]!.view);
  expect(evaluations[1]!.seed).toBe(evaluations[0]!.seed);
  const played = await t.view();
  expect(played.view.history[0]!.decisions.map(decision => decision.action)).toEqual([{ participantId: t.rex, action: { type: 'call' } }]);
  expect(played.pendingChanges).toEqual([]);
  // The failure was handled without being shown: nobody saw a failed status.
  expect(statuses(t.benLive).some(status => status.phase === 'failed')).toBe(false);
});

test('when the retry fails too, the server plays the Bot’s Timeout Action, sits it out after the Hand, and shows the failure to everyone at the table', async () => {
  plans.splice(0, Infinity, 'fail', 'fail'); evaluations.length = 0;
  const t = await botToAct();
  // Facing the big blind, the Bot cannot check, so its Timeout Action folds and the Hand is over.
  await expect.poll(async () => (await t.view()).view.state.status).toBe('completed-hand');
  expect(evaluations).toHaveLength(2);
  const failed = await t.view(t.ben);
  expect(failed.view.history[0]!.decisions.map(decision => decision.action)).toEqual([{ participantId: t.rex, action: { type: 'fold' } }]);
  expect(failed.pendingChanges).toEqual([{ participantId: t.rex, change: 'sit-out' }]);
  for (const connection of [t.annLive, t.benLive]) await expect.poll(() => statuses(connection).at(-1)).toMatchObject({ phase: 'failed', participantId: t.rex, code: 'failed', message: expect.stringContaining('Timeout Action') });
  expect(failed.runtimeStatus).toMatchObject({ phase: 'failed', participantId: t.rex });
  expect(JSON.stringify(t.benLive.messages)).not.toContain('untrusted');
  // Practice's explicit Retry is not offered: the server has already handled the failure.
  const retry = await post('/api/table-sessions/' + t.id + '/retry-bot', t.ann, { requestId: randomUUID(), expectedSessionRevision: (await t.view()).sessionRevision, participantId: t.rex });
  expect({ status: retry.status, code: (await retry.json()).rejection?.code }).toEqual({ status: 403, code: 'unavailable-at-online-tables' });
  // After the payout phase the Bot sits out, so Ann alone cannot be dealt a Hand.
  clock.advanceTo(failed.schedule.phases.find(phase => phase.kind === 'payout')!.endsAt);
  await expect.poll(async () => (await t.view()).view.state.participants.find(p => p.participantId === t.rex)?.sittingOut).toBe(true);
  clock.advance(60_000);
  const idle = await t.view();
  expect(idle).toMatchObject({ pendingChanges: [], view: { state: { status: 'completed-hand', handId: 'hand-1' } } });
  expect(idle.schedule.nextHandCountdown).toBeUndefined();
  // The owner resumes the Bot, and the table deals again; the failure notice ends with the Hand it happened in.
  expect((await t.as(t.ann, 'set-sitting-out', { participantId: t.rex, sittingOut: false })).status).toBe(200);
  clock.advance(5000);
  await expect.poll(async () => (await t.view()).view.state.handId).toBe('hand-2');
  await expect.poll(() => statuses(t.benLive).at(-1)?.phase).toBe('idle');
  expect((await t.view(t.ben)).runtimeStatus).toEqual({ phase: 'idle' });
});

test('analysis never delays or fails a Bot decision, even when it fills all the computation analysis may use', async () => {
  plans.splice(0, Infinity, { type: 'call' }, { type: 'bet', betTo: 60 }); evaluations.length = 0;
  const t = await botToAct();
  await expect.poll(async () => (await t.view()).view.state.actorId).toBe(t.annId);
  // Ann's Live Analysis of her decision is held: it takes the one job analysis may run, and nothing may queue behind it.
  holdingAnalysis = true;
  try {
    const decisionId = (await t.view()).view.state.decisionId!;
    expect((await post('/api/table-sessions/' + t.id + '/analysis', t.ann, { decisionId, live: true })).status).toBe(200);
    await expect.poll(() => heldAnalyses.length).toBe(1);
    expect((await t.as(t.ann, 'act', { participantId: t.annId, action: { type: 'check' } })).status).toBe(200);
    clock.advance(1000);
    expect((await t.as(t.ann, 'act', { participantId: t.annId, action: { type: 'check' } })).status).toBe(200);
    // Rex's decision runs at once and plays what its Strategy chose: no failure, no Timeout Action, no sit-out.
    await expect.poll(async () => (await t.view()).view.history[0]!.decisions.at(-1)!.action).toEqual({ participantId: t.rex, action: { type: 'bet', betTo: 60 } });
    expect(heldAnalyses).toHaveLength(1);
    expect((await t.view()).pendingChanges).toEqual([]);
    expect(statuses(t.benLive).some(status => status.phase === 'failed')).toBe(false);
  } finally { releaseAnalyses(); }
});
