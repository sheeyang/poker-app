import { afterAll, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Client, Pool } from 'pg';
import { baselinePlayingStrategy, defaultPlayingStrategy, highestProbabilityPlayingStrategy, type DecisionAnalysis, type ObservableGameView, type ObservableTableSession, type StrategyDescriptor } from '@poker/contracts';
import { HighestProbabilitySelector, type PolicyResult } from '@poker/strategies';
import { createServer, type ServerOptions } from '../src/server.js';

const databaseUrl = process.env.TEST_DATABASE_URL!;
const administration = new Pool({ connectionString: databaseUrl });
afterAll(() => administration.end());
interface Evaluation { view: ObservableGameView; descriptor: StrategyDescriptor; seed: string; signal?: AbortSignal; result: ReturnType<typeof Promise.withResolvers<PolicyResult>> }
async function fixture(options: Partial<ServerOptions> = {}) {
  const schema = 'test_' + randomUUID().replaceAll('-', '');
  await administration.query('CREATE SCHEMA "' + schema + '"');
  const evaluations: Evaluation[] = [];
  const held = new Set<Evaluation>();
  let heldId: string | undefined;
  let terminal: ReturnType<typeof Promise.withResolvers<'COMMIT' | 'ROLLBACK'>> | undefined;
  const targets = new Set<Promise<void>>();
  let server: Awaited<ReturnType<typeof createServer>>;
  let base = '';
  async function start() {
    server = await createServer({ databaseUrl, schema, automaticBots: false,
      mutationTransactionFaults: {
        openClient: async context => {
          if (context.requestId !== heldId) return;
          const client = new Client({ connectionString: databaseUrl, options: '-c search_path=' + schema });
          await client.connect(); return { client, release() {} };
        },
        terminalCommit: async (client, context) => {
          if (context.requestId !== heldId) { await client.query('COMMIT'); return; }
          terminal = Promise.withResolvers<'COMMIT' | 'ROLLBACK'>();
          const target = terminal.promise.then(async sql => { try { await client.query(sql); } finally { await client.end(); } });
          targets.add(target); void target.finally(() => targets.delete(target));
          throw new Error('Controlled missing COMMIT acknowledgement while PostgreSQL transaction remains unresolved.');
        },
      },
      strategyFactory: descriptor => ({ policy: { checkCompatibility: () => ({ compatible: true }), evaluate: (view, execution) => {
        const result = Promise.withResolvers<PolicyResult>();
        const evaluation = { view, descriptor, seed: execution.evaluationSeed, signal: execution.signal, result };
        evaluations.push(evaluation); held.add(evaluation); void result.promise.then(() => held.delete(evaluation), () => held.delete(evaluation));
        return result.promise;
      } }, actionSelector: new HighestProbabilitySelector() }), ...options });
    base = await server.listen({ host: '127.0.0.1', port: 0 });
  }
  await start();
  const post = (cookie: string, path: string, body: unknown) => fetch(base + '/api' + path, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  async function table() {
    const identity = await fetch(base + '/api/identity'); const cookie = identity.headers.get('set-cookie')!.split(';')[0]!;
    const response = await post(cookie, '/table-sessions', { requestId: randomUUID(), bots: [{ name: 'Bot', playingStrategy: baselinePlayingStrategy }] });
    expect(response.status).toBe(201); const created = await response.json();
    return { id: created.tableSessionId as string, cookie, human: created.bindings[0].participantId as string, bot: created.bindings[1].participantId as string };
  }
  type Table = Awaited<ReturnType<typeof table>>;
  const read = async (t: Table): Promise<ObservableTableSession> => (await fetch(base + '/api/table-sessions/' + t.id, { headers: { cookie: t.cookie } })).json();
  const submit = (t: Table, kind: string, body: unknown) => post(t.cookie, '/table-sessions/' + t.id + '/' + kind, body);
  async function command(t: Table, kind: string, body: object = {}) { const before = await read(t); const response = await submit(t, kind, { requestId: randomUUID(), expectedPokerRevision: before.pokerRevision, ...body }); expect(response.status).toBe(200); return response.json(); }
  async function decision() { const t = await table(); await command(t, 'seat-participant', { participantId: t.human, seat: 1 }); await command(t, 'seat-participant', { participantId: t.bot, seat: 2 }); await command(t, 'start-hand'); return t; }
  const request = async (t: Table, decisionId = 'hand-1/decision-1'): Promise<DecisionAnalysis> => (await submit(t, 'analysis', { decisionId })).json();
  const result = async (t: Table, requestId: string): Promise<DecisionAnalysis> => (await fetch(base + '/api/table-sessions/' + t.id + '/analysis/' + requestId, { headers: { cookie: t.cookie } })).json();
  async function stop() { const closing = server.close(); await expect.poll(() => [...held].every(evaluation => evaluation.signal?.aborted)).toBe(true); for (const evaluation of held) evaluation.result.resolve({ choices: [{ action: { type: 'fold' }, probability: 1 }] }); await closing; }
  return { table, decision, read, submit, command, request, result, evaluations, schema,
    hold(requestId: string) { heldId = requestId; },
    async resolve(sql: 'COMMIT' | 'ROLLBACK') { terminal!.resolve(sql); await Promise.all([...targets]); heldId = undefined; },
    async restart() { await stop(); evaluations.length = 0; await start(); },
    async close() { terminal?.resolve('ROLLBACK'); await Promise.allSettled([...targets]); await stop(); await administration.query('DROP SCHEMA "' + schema + '" CASCADE'); },
  };
}

test('accepted human play starts analysis with Live Analysis off and no browser connection, without awaiting its result', async () => {
  const f = await fixture();
  try {
    const t = await f.decision();
    expect((await f.read(t)).trainerConfiguration.liveAnalysis).toBe(false);
    expect(f.evaluations).toHaveLength(0);
    await f.command(t, 'act', { participantId: t.human, action: { type: 'fold' } });
    expect(await f.read(t)).toMatchObject({ pokerRevision: 4, sessionRevision: 4, view: { state: { status: 'completed-hand' } } });
    await expect.poll(() => f.evaluations.length).toBe(1);
    const pending = await f.request(t);
    expect(pending).toMatchObject({ status: 'pending', scoredDecision: { acceptedAction: { type: 'fold' }, scoringMethodVersion: 'v1' } });
    f.evaluations[0]!.result.resolve({ choices: [{ action: { type: 'fold' }, probability: .25 }, { action: { type: 'call' }, probability: .75 }] });
    await expect.poll(async () => (await f.result(t, pending.requestId)).status).toBe('complete');
    expect(await f.result(t, pending.requestId)).toMatchObject({ scores: { decisionScore: .25, actionRankScore: .5 } });
    expect(f.evaluations).toHaveLength(1);
  } finally { await f.close(); }
});

test('live recovery starts one accepted analysis after proving COMMIT without a browser retry, and duplicate acknowledgements never capture later preferences', async () => {
  const f = await fixture();
  try {
    const t = await f.decision();
    const body = { requestId: 'unknown-human', expectedPokerRevision: 3, participantId: t.human, action: { type: 'fold' } };
    f.hold(body.requestId);
    expect((await f.submit(t, 'act', body)).status).toBe(503);
    expect(await f.read(t)).toMatchObject({ pokerRevision: 3, runtimeStatus: { phase: 'recovering' } });
    expect(f.evaluations).toHaveLength(0);
    await f.resolve('COMMIT');
    await expect.poll(() => f.evaluations.length).toBe(1);
    const automatic = await f.request(t);
    expect(automatic).toMatchObject({ scoredDecision: { acceptedAction: { type: 'fold' } }, referenceStrategy: defaultPlayingStrategy });
    f.evaluations[0]!.result.resolve({ choices: [{ action: { type: 'fold' }, probability: 1 }] });
    await expect.poll(async () => (await f.result(t, automatic.requestId)).status).toBe('complete');
    const before = await f.read(t);
    expect((await f.submit(t, 'set-trainer-configuration', { requestId: randomUUID(), expectedSessionRevision: before.sessionRevision, trainerConfiguration: { referenceStrategy: highestProbabilityPlayingStrategy, liveAnalysis: false } })).status).toBe(200);
    expect(await (await f.submit(t, 'act', body)).json()).toMatchObject({ ok: true, pokerRevision: 4, sessionRevision: 4 });
    expect(f.evaluations).toHaveLength(1);
    expect(await f.result(t, automatic.requestId)).toMatchObject({ referenceStrategy: defaultPlayingStrategy, status: 'complete' });
  } finally { await f.close(); }
});

test('interactive matches share queued automatic work without promoting its original priority', async () => {
  const f = await fixture({ jobRunnerOptions: { concurrency: 1, maximumQueued: 8, timeoutMs: 10000 } });
  try {
    const blocker = await f.decision(); const automatic = await f.decision(); const interactive = await f.decision();
    await f.request(blocker); await expect.poll(() => f.evaluations.length).toBe(1);
    await f.command(automatic, 'act', { participantId: automatic.human, action: { type: 'fold' } });
    const pending = await f.request(automatic); expect(await f.request(automatic)).toEqual(pending);
    await f.request(interactive);
    f.evaluations[0]!.result.resolve({ choices: [{ action: { type: 'fold' }, probability: 1 }] });
    await expect.poll(() => f.evaluations.length).toBe(2);
    expect(f.evaluations[1]!.view.state.actorId).toBe(interactive.human);
    f.evaluations[1]!.result.resolve({ choices: [{ action: { type: 'fold' }, probability: 1 }] });
    await expect.poll(() => f.evaluations.length).toBe(3);
    expect(f.evaluations[2]!.view.state.actorId).toBe(automatic.human);
    f.evaluations[2]!.result.resolve({ choices: [{ action: { type: 'fold' }, probability: 1 }] });
    await expect.poll(async () => (await f.result(automatic, pending.requestId)).status).toBe('complete');
    expect(f.evaluations).toHaveLength(3);
  } finally { await f.close(); }
});

test('held or failed automatic analysis leaves accepted human play and admitted Bot progression independent', async () => {
  const f = await fixture({ automaticBots: true, jobRunnerOptions: { concurrency: 2, timeoutMs: 10000 } });
  try {
    const t = await f.decision();
    await f.command(t, 'act', { participantId: t.human, action: { type: 'call' } });
    await expect.poll(() => f.evaluations.length).toBe(2);
    expect(f.evaluations.map(evaluation => evaluation.view.state.actorId)).toEqual([t.bot, t.human]);
    const pending = await f.request(t);
    f.evaluations[0]!.result.resolve({ choices: [{ action: { type: 'fold' }, probability: 1 }] });
    await expect.poll(async () => (await f.read(t)).pokerRevision).toBe(5);
    expect(await f.result(t, pending.requestId)).toMatchObject({ status: 'pending' });
    f.evaluations[1]!.result.resolve({ choices: [{ action: { type: 'call' }, probability: .2 }] });
    await expect.poll(async () => (await f.result(t, pending.requestId)).status).toBe('error');
    expect(await f.result(t, pending.requestId)).toMatchObject({ scoredDecision: { acceptedAction: { type: 'call' } }, error: { code: 'invalid-policy' } });
    expect(await f.read(t)).toMatchObject({ pokerRevision: 5, sessionRevision: 5, view: { state: { status: 'completed-hand' } } });
  } finally { await f.close(); }
});

test('no automatic target exists before durable commit or for rejected submissions, and matching acknowledgements do not resubmit it', async () => {
  const entered = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
  const f = await fixture({ mutationTransactionFaults: { beforeCommit: async context => { if (context.requestId === 'held-human') { entered.resolve(); await release.promise; } } } });
  try {
    const t = await f.decision();
    expect((await f.submit(t, 'act', { requestId: 'wrong-controller', expectedPokerRevision: 3, participantId: t.bot, action: { type: 'fold' } })).status).toBe(403);
    expect((await f.submit(t, 'act', { requestId: 'illegal-check', expectedPokerRevision: 3, participantId: t.human, action: { type: 'check' } })).status).toBe(400);
    expect((await f.submit(t, 'act', { requestId: 'stale', expectedPokerRevision: 2, participantId: t.human, action: { type: 'fold' } })).status).toBe(409);
    const body = { requestId: 'held-human', expectedPokerRevision: 3, participantId: t.human, action: { type: 'fold' } };
    const response = f.submit(t, 'act', body); await entered.promise;
    expect(await f.read(t)).toMatchObject({ pokerRevision: 3, sessionRevision: 3 });
    expect(f.evaluations).toHaveLength(0);
    release.resolve(); expect((await response).status).toBe(200);
    await expect.poll(() => f.evaluations.length).toBe(1);
    expect((await f.submit(t, 'act', body)).status).toBe(200);
    expect(f.evaluations).toHaveLength(1);
  } finally { release.resolve(); await f.close(); }
});

test('confirmed noncommit discards the unaccepted target and permits analysis only after a deliberate new accepted attempt', async () => {
  const f = await fixture();
  try {
    const t = await f.decision();
    const body = { requestId: 'aborted-human', expectedPokerRevision: 3, participantId: t.human, action: { type: 'fold' } };
    f.hold(body.requestId); expect((await f.submit(t, 'act', body)).status).toBe(503);
    await f.resolve('ROLLBACK');
    expect(await (await f.submit(t, 'act', body)).json()).toMatchObject({ rejection: { code: 'commit-not-applied' } });
    expect(await f.read(t)).toMatchObject({ pokerRevision: 3, sessionRevision: 3 });
    expect(f.evaluations).toHaveLength(0);
    expect((await f.submit(t, 'act', { ...body, requestId: 'new-human-attempt' })).status).toBe(200);
    await expect.poll(() => f.evaluations.length).toBe(1);
  } finally { await f.close(); }
});

test('restart restores an uncertain accepted action without creating a durable analysis obligation or historical sweep', async () => {
  const f = await fixture();
  try {
    const t = await f.decision();
    const body = { requestId: 'restart-human', expectedPokerRevision: 3, participantId: t.human, action: { type: 'fold' } };
    f.hold(body.requestId); expect((await f.submit(t, 'act', body)).status).toBe(503);
    await f.restart(); await f.resolve('COMMIT');
    await expect.poll(async () => (await f.read(t)).runtimeStatus?.phase).toBe('idle');
    expect(await f.read(t)).toMatchObject({ pokerRevision: 4, sessionRevision: 4 });
    expect(f.evaluations).toHaveLength(0);
    expect((await f.submit(t, 'act', body)).status).toBe(200);
    expect(f.evaluations).toHaveLength(0);
    expect(await f.request(t)).toMatchObject({ status: 'pending', scoredDecision: { acceptedAction: { type: 'fold' } } });
    await expect.poll(() => f.evaluations.length).toBe(1);
  } finally { await f.close(); }
});

test('automatic capacity failure is readable rather than phantom pending and cannot change the accepted poker outcome', async () => {
  const f = await fixture({ jobRunnerOptions: { concurrency: 1, maximumQueued: 0, timeoutMs: 10000 } });
  try {
    const blocker = await f.decision(); await f.request(blocker); await expect.poll(() => f.evaluations.length).toBe(1);
    const t = await f.decision(); await f.command(t, 'act', { participantId: t.human, action: { type: 'fold' } });
    await expect.poll(async () => (await f.request(t)).status).toBe('error');
    const failure = await f.request(t);
    expect(failure).toMatchObject({ status: 'error', scoredDecision: { acceptedAction: { type: 'fold' } }, error: { code: 'capacity' } });
    expect(await f.result(t, failure.requestId)).toEqual(failure);
    expect(await f.read(t)).toMatchObject({ pokerRevision: 4, sessionRevision: 4, view: { state: { status: 'completed-hand' } } });
    expect(f.evaluations).toHaveLength(1);
  } finally { await f.close(); }
});

test('automatic score calculation keeps priority 2 behind later interactive evaluation after its dependency succeeds', async () => {
  const f = await fixture({ jobRunnerOptions: { concurrency: 1, maximumQueued: 8, timeoutMs: 10000 } });
  try {
    const t = await f.decision(); await f.command(t, 'act', { participantId: t.human, action: { type: 'fold' } });
    await expect.poll(() => f.evaluations.length).toBe(1); const pending = await f.request(t);
    const blocker = await f.decision(); const interactive = await f.decision();
    await f.request(blocker);
    f.evaluations[0]!.result.resolve({ choices: [{ action: { type: 'fold' }, probability: 1 }] });
    await expect.poll(() => f.evaluations.length).toBe(2);
    await expect.poll(async () => (await f.result(t, pending.evaluationRequestId!)).status).toBe('complete');
    await f.request(interactive);
    f.evaluations[1]!.result.resolve({ choices: [{ action: { type: 'fold' }, probability: 1 }] });
    await expect.poll(() => f.evaluations.length).toBe(3);
    expect(f.evaluations[2]!.view.state.actorId).toBe(interactive.human);
    expect(await f.result(t, pending.requestId)).toMatchObject({ status: 'pending' });
    f.evaluations[2]!.result.resolve({ choices: [{ action: { type: 'fold' }, probability: 1 }] });
    await expect.poll(async () => (await f.result(t, pending.requestId)).status).toBe('complete');
  } finally { await f.close(); }
});

test('explicit Retry preserves automatic dependency priority, accepted action, original reference and seeds after preferences change', async () => {
  const f = await fixture({ jobRunnerOptions: { concurrency: 1, maximumQueued: 8, timeoutMs: 10000 } });
  try {
    const t = await f.decision(); await f.command(t, 'act', { participantId: t.human, action: { type: 'fold' } });
    await expect.poll(() => f.evaluations.length).toBe(1); const original = f.evaluations[0]!;
    const pending = await f.request(t); original.result.resolve({ choices: [{ action: { type: 'fold' }, probability: .2 }] });
    await expect.poll(async () => (await f.result(t, pending.requestId)).status).toBe('error');
    const before = await f.read(t);
    expect((await f.submit(t, 'set-trainer-configuration', { requestId: randomUUID(), expectedSessionRevision: before.sessionRevision, trainerConfiguration: { referenceStrategy: highestProbabilityPlayingStrategy, liveAnalysis: false } })).status).toBe(200);
    const blocker = await f.decision(); await f.request(blocker); await expect.poll(() => f.evaluations.length).toBe(2);
    const retried: DecisionAnalysis = await (await f.submit(t, 'analysis/' + pending.requestId + '/retry', {})).json();
    expect(retried).toMatchObject({ status: 'pending', requestId: pending.requestId, referenceStrategy: defaultPlayingStrategy, scoredDecision: { acceptedAction: { type: 'fold' }, scoringMethodVersion: 'v1' } });
    expect(retried.attemptId).not.toBe(pending.attemptId);
    const interactive = await f.decision(); await f.request(interactive);
    f.evaluations[1]!.result.resolve({ choices: [{ action: { type: 'fold' }, probability: 1 }] });
    await expect.poll(() => f.evaluations.length).toBe(3);
    expect(f.evaluations[2]!.view.state.actorId).toBe(interactive.human);
    f.evaluations[2]!.result.resolve({ choices: [{ action: { type: 'fold' }, probability: 1 }] });
    await expect.poll(() => f.evaluations.length).toBe(4);
    expect(f.evaluations[3]).toMatchObject({ view: original.view, seed: original.seed, descriptor: original.descriptor });
    f.evaluations[3]!.result.resolve({ choices: [{ action: { type: 'fold' }, probability: .25 }, { action: { type: 'call' }, probability: .75 }] });
    await expect.poll(async () => (await f.result(t, pending.requestId)).status).toBe('complete');
    expect(await f.result(t, pending.requestId)).toMatchObject({ attemptId: retried.attemptId, scores: { decisionScore: .25, actionRankScore: .5 } });
  } finally { await f.close(); }
});

test('an automatic accepted score shares a running Live Analysis evaluation and accepts its valid late historical result', async () => {
  const f = await fixture();
  try {
    const t = await f.decision(); const before = await f.read(t);
    expect((await f.submit(t, 'set-trainer-configuration', { requestId: randomUUID(), expectedSessionRevision: before.sessionRevision, trainerConfiguration: { referenceStrategy: baselinePlayingStrategy, liveAnalysis: true } })).status).toBe(200);
    const live: DecisionAnalysis = await (await f.submit(t, 'analysis', { decisionId: 'hand-1/decision-1', live: true })).json();
    await expect.poll(() => f.evaluations.length).toBe(1);
    await f.command(t, 'act', { participantId: t.human, action: { type: 'fold' } });
    const automatic = await f.request(t);
    expect(automatic).toMatchObject({ status: 'pending', evaluationRequestId: live.requestId, scoredDecision: { acceptedAction: { type: 'fold' } } });
    expect(f.evaluations).toHaveLength(1);
    f.evaluations[0]!.result.resolve({ choices: [{ action: { type: 'fold' }, probability: 1 }] });
    await expect.poll(async () => (await f.result(t, automatic.requestId)).status).toBe('complete');
    expect(await f.result(t, automatic.requestId)).toMatchObject({ scores: { decisionScore: 1, actionRankScore: 1 }, evaluationRequestId: live.requestId });
    expect(await f.result(t, live.requestId)).not.toHaveProperty('scoredDecision');
    expect(f.evaluations).toHaveLength(1);
  } finally { await f.close(); }
});
