import { afterAll, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import WebSocket from 'ws';
import { baselinePlayingStrategy, highestProbabilityPlayingStrategy, type HandScoreSummary, type ObservableGameView, type ObservableTableSession, type StrategyDescriptor, type ServerLiveMessage } from '@poker/contracts';
import { HighestProbabilitySelector, type PolicyResult } from '@poker/strategies';
import { createServer, type ServerOptions } from '../src/server.js';

const databaseUrl = process.env.TEST_DATABASE_URL!;
const administration = new Pool({ connectionString: databaseUrl });
afterAll(() => administration.end());
interface Evaluation { readonly view: ObservableGameView; readonly seed: string; readonly signal?: AbortSignal; readonly result: ReturnType<typeof Promise.withResolvers<PolicyResult>> }
async function fixture(options: Partial<ServerOptions> = {}) {
  const schema = 'test_' + randomUUID().replaceAll('-', '');
  await administration.query('CREATE SCHEMA "' + schema + '"');
  const evaluations: Evaluation[] = [];
  const held = new Set<Evaluation>();
  const sockets: WebSocket[] = [];
  let server: Awaited<ReturnType<typeof createServer>>;
  let base: string;
  async function start() {
    server = await createServer({ databaseUrl, schema, automaticBots: false, supportsStrategy: value => !!value && typeof value === 'object' && ['fixture', 'uniform-choice'].includes((value as StrategyDescriptor).policy?.id), strategyFactory: descriptor => ({
      policy: { checkCompatibility: () => ({ compatible: true }), evaluate: (view, execution) => { if (descriptor.policy.id === 'uniform-choice') { const action = view.state.legalActions.find(action => action.type === 'call' || action.type === 'check') ?? view.state.legalActions[0]!; return { choices: [{ action: action.type === 'bet' ? { type: 'bet', betTo: action.minimum } : action.type === 'raise' ? { type: 'raise', raiseTo: action.minimum } : { type: action.type }, probability: 1 }] }; } const result = Promise.withResolvers<PolicyResult>(); const evaluation = { view, seed: execution.evaluationSeed, signal: execution.signal, result }; evaluations.push(evaluation); held.add(evaluation); void result.promise.then(() => held.delete(evaluation), () => held.delete(evaluation)); return result.promise; } }, actionSelector: new HighestProbabilitySelector(),
    }), ...options });
    base = await server.listen({ host: '127.0.0.1', port: 0 });
  }
  await start();
  async function table() {
    const identity = await fetch(base + '/api/identity'); const cookie = identity.headers.get('set-cookie')!.split(';')[0]!;
    const response = await fetch(base + '/api/table-sessions', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ requestId: randomUUID(), configuration: { maximumBuyIn: 2000 }, bots: [{ name: 'Bot', playingStrategy: baselinePlayingStrategy }] }) });
    expect(response.status).toBe(201); const created = await response.json();
    return { id: created.tableSessionId as string, cookie, human: created.bindings[0].participantId as string, bot: created.bindings[1].participantId as string };
  }
  type Table = Awaited<ReturnType<typeof table>>;
  const read = async (t: Table): Promise<ObservableTableSession> => (await fetch(base + '/api/table-sessions/' + t.id, { headers: { cookie: t.cookie } })).json();
  const post = (t: Table, path: string, body: unknown, cookie = t.cookie) => fetch(base + '/api/table-sessions/' + t.id + '/' + path, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  async function command(t: Table, kind: string, body: object = {}) { const before = await read(t); const response = await post(t, kind, { requestId: randomUUID(), expectedPokerRevision: before.pokerRevision, ...body }); expect(response.status).toBe(200); }
  async function decision() { const t = await table(); await command(t, 'seat-participant', { participantId: t.human, seat: 1 }); await command(t, 'seat-participant', { participantId: t.bot, seat: 2 }); await command(t, 'start-hand'); return t; }
  async function configure(t: Table, referenceStrategy: StrategyDescriptor) { const before = await read(t); expect((await post(t, 'set-trainer-configuration', { requestId: randomUUID(), expectedSessionRevision: before.sessionRevision, trainerConfiguration: { referenceStrategy, liveAnalysis: false } })).status).toBe(200); }
  const request = (t: Table, decisionId = 'hand-1/decision-1') => post(t, 'analysis', { decisionId });
  const result = async (t: Table, requestId: string, cookie = t.cookie) => fetch(base + '/api/table-sessions/' + t.id + '/analysis/' + requestId, { headers: { cookie } });
  function connect(t: Table) { const socket = new WebSocket(base.replace('http:', 'ws:') + '/api/live', { headers: { cookie: t.cookie } }); sockets.push(socket); const messages: ServerLiveMessage[] = []; socket.on('error', () => {}); socket.on('message', data => messages.push(JSON.parse(data.toString()))); return { socket, messages }; }
  async function stop() { for (const socket of sockets) socket.terminate(); const closing = server.close(); await expect.poll(() => [...held].every(evaluation => evaluation.signal?.aborted)).toBe(true); for (const evaluation of held) evaluation.result.resolve({ choices: [{ action: { type: 'fold' }, probability: 1 }] }); await closing; }
  return { table, decision, read, post, command, configure, request, result, summary: (t: Table, requestId: string, cookie = t.cookie) => fetch(base + '/api/table-sessions/' + t.id + '/summaries/' + requestId, { headers: { cookie } }), connect, evaluations, schema, async restart() { await stop(); evaluations.length = 0; await start(); }, async close() { await stop(); await administration.query('DROP SCHEMA "' + schema + '" CASCADE'); } };
}

const reference: StrategyDescriptor = { policy: { id: 'fixture', version: 'v1', configuration: {} }, selector: highestProbabilityPlayingStrategy.selector };

test('an empty Hand summary freezes committed metadata and schedules no analysis', async () => {
  const f = await fixture();
  try {
    const t = await f.decision();
    const before = await f.read(t);
    const response = await f.post(t, 'hand-summaries', { handId: 'hand-1' });
    expect(response.status).toBe(200);
    const summary = await response.json();
    expect(summary).toMatchObject({ ok: true, tableSessionId: t.id, handId: 'hand-1', status: 'empty', capturedPokerRevision: before.pokerRevision, decisionCount: 0, decisionIds: [], referenceStrategy: before.trainerConfiguration.referenceStrategy, requestId: expect.any(String), attemptId: expect.any(String) });
    expect(summary).not.toHaveProperty('averages');
    expect(f.evaluations).toHaveLength(0);
    expect(await f.read(t)).toEqual(before);
    expect((await f.post(t, 'hand-summaries', { handId: 'hand-99' })).status).toBe(400);
  } finally { await f.close(); }
});

test('a Hand summary evaluates its accepted human decisions and publishes readable complete means without a live subscription', async () => {
  const f = await fixture();
  try {
    const t = await f.decision(); const stranger = await f.table();
    await f.command(t, 'act', { participantId: t.human, action: { type: 'fold' } });
    await f.configure(t, reference);
    const before = await f.read(t); const live = f.connect(t); const other = f.connect(stranger);
    await expect.poll(() => live.messages.some(frame => frame.type === 'user-channel-ready')).toBe(true);
    const summary = await (await f.post(t, 'hand-summaries', { handId: 'hand-1' })).json();
    expect(summary).toMatchObject({ status: 'pending', decisionIds: ['hand-1/decision-1'], decisionCount: 1, capturedPokerRevision: before.pokerRevision });
    expect(summary).not.toHaveProperty('averages');
    const readableAtNotification: Promise<HandScoreSummary>[] = [];
    live.socket.on('message', raw => { const frame = JSON.parse(raw.toString()); if (frame.resource === 'summary' && frame.requestId === summary.requestId) readableAtNotification.push(f.summary(t, summary.requestId).then(response => response.json())); });
    await expect.poll(() => f.evaluations.length).toBe(1);
    f.evaluations[0]!.result.resolve({ choices: [{ action: { type: 'fold' }, probability: .25 }, { action: { type: 'call' }, probability: .25 }, { action: { type: 'raise', raiseTo: 40 }, probability: .5 }] });
    await expect.poll(() => live.messages.find(frame => frame.type === 'analysis-update' && frame.resource === 'summary' && frame.requestId === summary.requestId)).toMatchObject({ status: 'complete', attemptId: summary.attemptId });
    const complete = await (await f.summary(t, summary.requestId)).json();
    expect(complete).toMatchObject({ status: 'complete', averages: { decisionScore: .25, actionRankScore: 0 } });
    expect(await Promise.all(readableAtNotification)).toEqual([expect.objectContaining({ status: 'complete', averages: { decisionScore: .25, actionRankScore: 0 } })]);
    expect(other.messages.some(frame => frame.type === 'analysis-update')).toBe(false);
    const frame = live.messages.find(frame => frame.type === 'analysis-update' && frame.resource === 'summary');
    expect(frame).not.toHaveProperty('averages');
    expect((await f.summary(t, summary.requestId, stranger.cookie)).status).toBe(404);
    expect(await f.read(t)).toEqual(before);
  } finally { await f.close(); }
});

test('concurrent overlapping summary requests share a global outstanding bound and continue after completion without reads', async () => {
  const f = await fixture({ jobRunnerOptions: { concurrency: 4, maximumQueued: 16 } });
  try {
    const tables: Awaited<ReturnType<typeof f.decision>>[] = [];
    for (let count = 0; count < 3; count++) {
      const t = await f.decision(); await f.command(t, 'act', { participantId: t.human, action: { type: 'fold' } }); await f.configure(t, reference); tables.push(t);
    }
    const summaries = await Promise.all([...tables, tables[0]!].map(t => f.post(t, 'hand-summaries', { handId: 'hand-1' }).then(response => response.json())));
    await expect.poll(() => f.evaluations.length).toBe(2);
    expect(f.evaluations).toHaveLength(2);
    f.evaluations[0]!.result.resolve({ choices: [{ action: { type: 'fold' }, probability: 1 }] });
    await expect.poll(() => f.evaluations.length).toBe(3);
    for (const evaluation of f.evaluations.slice(1)) evaluation.result.resolve({ choices: [{ action: { type: 'fold' }, probability: 1 }] });
    for (let index = 0; index < summaries.length; index++) {
      const t = index < 3 ? tables[index]! : tables[0]!;
      await expect.poll(async () => (await (await f.summary(t, summaries[index].requestId)).json()).status).toBe('complete');
    }
    expect(f.evaluations).toHaveLength(3);
  } finally { await f.close(); }
});

test('failure outranks pending and explicit Retry preserves a frozen active-Hand snapshot while reusing active and successful members', async () => {
  const f = await fixture({ automaticBots: true });
  try {
    const t = await f.decision();
    const humanTurn = () => expect.poll(async () => (await f.read(t)).view.state.actorId).toBe(t.human);
    await f.command(t, 'act', { participantId: t.human, action: { type: 'call' } }); await humanTurn();
    await f.command(t, 'act', { participantId: t.human, action: { type: 'check' } }); await humanTurn();
    await f.configure(t, reference); const before = await f.read(t);
    const summary = await (await f.post(t, 'hand-summaries', { handId: 'hand-1' })).json();
    expect(summary).toMatchObject({ status: 'pending', decisionCount: 2, capturedPokerRevision: before.pokerRevision, referenceStrategy: reference });
    await expect.poll(() => f.evaluations.length).toBe(2);
    const originalViews = f.evaluations.map(evaluation => evaluation.view); const originalSeeds = f.evaluations.map(evaluation => evaluation.seed);
    f.evaluations[0]!.result.reject(new Error('Private Strategy diagnostics'));
    await expect.poll(async () => (await (await f.summary(t, summary.requestId)).json()).status).toBe('error');
    const failed = await (await f.summary(t, summary.requestId)).json();
    expect(failed).toMatchObject({ error: { code: 'failed' } }); expect(failed).not.toHaveProperty('averages'); expect(JSON.stringify(failed)).not.toContain('Private');
    await f.configure(t, highestProbabilityPlayingStrategy);
    await f.command(t, 'act', { participantId: t.human, action: { type: 'check' } }); await humanTurn();
    expect(await (await f.summary(t, summary.requestId)).json()).toEqual(failed);
    expect(f.evaluations).toHaveLength(2);
    const [retried, duplicate] = await Promise.all([f.post(t, 'summaries/' + summary.requestId + '/retry', {}).then(response => response.json()), f.post(t, 'summaries/' + summary.requestId + '/retry', {}).then(response => response.json())]);
    expect(retried).toEqual(duplicate);
    expect(retried).toMatchObject({ requestId: summary.requestId, decisionIds: summary.decisionIds, decisionCount: 2, capturedPokerRevision: before.pokerRevision, referenceStrategy: reference, status: 'pending' });
    expect(retried.attemptId).not.toBe(summary.attemptId);
    await expect.poll(() => f.evaluations.length).toBe(3);
    expect(f.evaluations[2]!.view).toEqual(originalViews[0]); expect(f.evaluations[2]!.seed).toBe(originalSeeds[0]);
    f.evaluations[1]!.result.resolve({ choices: [{ action: { type: 'fold' }, probability: .6 }, { action: { type: 'check' }, probability: .3 }, { action: { type: 'bet', betTo: 20 }, probability: .1 }] });
    expect((await (await f.summary(t, summary.requestId)).json()).status).toBe('pending');
    f.evaluations[2]!.result.resolve({ choices: [{ action: { type: 'call' }, probability: 1 }] });
    await expect.poll(async () => (await (await f.summary(t, summary.requestId)).json()).status).toBe('complete');
    const complete = await (await f.summary(t, summary.requestId)).json();
    expect(complete.averages.decisionScore).toBeCloseTo(.65, 14); expect(complete.averages.actionRankScore).toBe(.75);
    const same = await (await f.post(t, 'summaries/' + summary.requestId + '/retry', {})).json(); expect(same).toEqual(complete); expect(f.evaluations).toHaveLength(3);
  } finally { await f.close(); }
});

test('shared runner capacity is an explicit readable summary error and missing work starts only on explicit Retry', async () => {
  const f = await fixture({ jobRunnerOptions: { concurrency: 1, maximumQueued: 0 } });
  try {
    const blocker = await f.decision(); await f.configure(blocker, reference); await f.request(blocker); await expect.poll(() => f.evaluations.length).toBe(1);
    const t = await f.decision(); await f.command(t, 'act', { participantId: t.human, action: { type: 'fold' } }); await f.configure(t, reference);
    const response = await f.post(t, 'hand-summaries', { handId: 'hand-1' }); expect(response.status).toBe(503);
    const failed = await response.json(); expect(failed).toMatchObject({ status: 'error', error: { code: 'capacity' } }); expect(failed).not.toHaveProperty('averages');
    expect(await (await f.summary(t, failed.requestId)).json()).toEqual(failed); expect(f.evaluations).toHaveLength(1);
    f.evaluations[0]!.result.resolve({ choices: [{ action: { type: 'fold' }, probability: 1 }] });
    const retry = await (await f.post(t, 'summaries/' + failed.requestId + '/retry', {})).json(); expect(retry.requestId).toBe(failed.requestId); expect(retry.attemptId).not.toBe(failed.attemptId);
    await expect.poll(() => f.evaluations.length).toBe(2); f.evaluations[1]!.result.resolve({ choices: [{ action: { type: 'fold' }, probability: 1 }] });
    await expect.poll(async () => (await (await f.summary(t, failed.requestId)).json()).status).toBe('complete');
  } finally { await f.close(); }
});

test('logical timeout and repeated Retry retain the global summary budget until old physical attempts settle', async () => {
  const f = await fixture({ jobRunnerOptions: { concurrency: 4, maximumQueued: 16, timeoutMs: 1000 } });
  try {
    const tables: Awaited<ReturnType<typeof f.decision>>[] = [];
    for (let index = 0; index < 3; index++) { const t = await f.decision(); await f.command(t, 'act', { participantId: t.human, action: { type: 'fold' } }); await f.configure(t, reference); tables.push(t); }
    const summaries: HandScoreSummary[] = [];
    for (const t of tables) summaries.push(await (await f.post(t, 'hand-summaries', { handId: 'hand-1' })).json());
    await expect.poll(() => f.evaluations.length).toBe(2);
    await expect.poll(() => f.evaluations[0]!.signal?.aborted, { timeout: 3000 }).toBe(true);
    await expect.poll(async () => (await (await f.summary(tables[0]!, summaries[0].requestId)).json()).status).toBe('error');
    await expect.poll(async () => (await (await f.summary(tables[1]!, summaries[1].requestId)).json()).status).toBe('error');
    expect(f.evaluations).toHaveLength(2);
    const retried = await (await f.post(tables[0]!, 'summaries/' + summaries[0].requestId + '/retry', {})).json();
    expect(retried.status).toBe('pending');
    for (let index = 0; index < 3; index++) expect((await (await f.post(tables[0]!, 'summaries/' + summaries[0].requestId + '/retry', {})).json()).attemptId).toBe(retried.attemptId);
    expect(f.evaluations).toHaveLength(2);
    expect((await (await f.summary(tables[2]!, summaries[2].requestId)).json()).status).toBe('pending');
    f.evaluations[0]!.result.resolve({ choices: [{ action: { type: 'fold' }, probability: 1 }] });
    await expect.poll(() => f.evaluations.length).toBe(3);
    f.evaluations[1]!.result.resolve({ choices: [{ action: { type: 'fold' }, probability: 1 }] });
    await expect.poll(() => f.evaluations.length).toBe(4);
    for (const evaluation of f.evaluations.slice(2)) evaluation.result.resolve({ choices: [{ action: { type: 'fold' }, probability: 1 }] });
    await expect.poll(async () => (await (await f.summary(tables[0]!, summaries[0].requestId)).json()).status).toBe('complete');
    await expect.poll(async () => (await (await f.summary(tables[2]!, summaries[2].requestId)).json()).status).toBe('complete');
    expect(f.evaluations[3]!.seed).toBe(f.evaluations[0]!.seed);
  } finally { await f.close(); }
});

test('restart loses exact transient summaries and an explicit new snapshot reuses persisted successful member scores', async () => {
  const f = await fixture();
  try {
    const t = await f.decision(); await f.command(t, 'act', { participantId: t.human, action: { type: 'fold' } }); await f.configure(t, reference);
    const original = await (await f.post(t, 'hand-summaries', { handId: 'hand-1' })).json();
    await expect.poll(() => f.evaluations.length).toBe(1); f.evaluations[0]!.result.resolve({ choices: [{ action: { type: 'fold' }, probability: 1 }] });
    await expect.poll(async () => (await (await f.summary(t, original.requestId)).json()).status).toBe('complete');
    const before = await f.read(t); await f.restart();
    expect((await f.summary(t, original.requestId)).status).toBe(404);
    expect((await f.post(t, 'summaries/' + original.requestId + '/retry', {})).status).toBe(404);
    const fresh = await (await f.post(t, 'hand-summaries', { handId: 'hand-1' })).json();
    expect(fresh.requestId).not.toBe(original.requestId); expect(fresh).toMatchObject({ decisionCount: 1, capturedPokerRevision: before.pokerRevision, referenceStrategy: reference });
    await expect.poll(async () => (await (await f.summary(t, fresh.requestId)).json()).status).toBe('complete');
    expect((await (await f.summary(t, fresh.requestId)).json()).averages).toEqual({ decisionScore: 1, actionRankScore: 1 });
    expect(f.evaluations).toHaveLength(0); expect(await f.read(t)).toEqual(before);
  } finally { await f.close(); }
});

test('a new Hand summary reuses a member successfully retried through individual decision analysis', async () => {
  const f = await fixture();
  try {
    const t = await f.decision(); await f.command(t, 'act', { participantId: t.human, action: { type: 'fold' } }); await f.configure(t, reference);
    const first = await (await f.post(t, 'hand-summaries', { handId: 'hand-1' })).json();
    await expect.poll(() => f.evaluations.length).toBe(1); f.evaluations[0]!.result.reject(new Error('Controlled external failure'));
    await expect.poll(async () => (await (await f.summary(t, first.requestId)).json()).status).toBe('error');
    const member = await (await f.request(t)).json(); expect(member.status).toBe('error');
    await f.post(t, 'analysis/' + member.requestId + '/retry', {});
    await expect.poll(() => f.evaluations.length).toBe(2); f.evaluations[1]!.result.resolve({ choices: [{ action: { type: 'fold' }, probability: 1 }] });
    await expect.poll(async () => (await (await f.result(t, member.requestId)).json()).status).toBe('complete');
    const fresh = await (await f.post(t, 'hand-summaries', { handId: 'hand-1' })).json();
    await expect.poll(async () => (await (await f.summary(t, fresh.requestId)).json()).status).toBe('complete');
    expect((await (await f.summary(t, fresh.requestId)).json()).averages).toEqual({ decisionScore: 1, actionRankScore: 1 });
    expect(f.evaluations).toHaveLength(2);
  } finally { await f.close(); }
});

test('a new summary follows an active individual Retry without releasing the older physical attempt budget', async () => {
  const f = await fixture({ jobRunnerOptions: { concurrency: 4, maximumQueued: 16, timeoutMs: 1000 } });
  try {
    const t = await f.decision(); await f.command(t, 'act', { participantId: t.human, action: { type: 'fold' } }); await f.configure(t, reference);
    const first = await (await f.post(t, 'hand-summaries', { handId: 'hand-1' })).json();
    await expect.poll(() => f.evaluations.length).toBe(1); await expect.poll(() => f.evaluations[0]!.signal?.aborted, { timeout: 3000 }).toBe(true);
    await expect.poll(async () => (await (await f.summary(t, first.requestId)).json()).status).toBe('error');
    const member = await (await f.request(t)).json(); await f.post(t, 'analysis/' + member.requestId + '/retry', {});
    await expect.poll(() => f.evaluations.length).toBe(2);
    const fresh = await (await f.post(t, 'hand-summaries', { handId: 'hand-1' })).json(); expect(fresh.status).toBe('pending');
    f.evaluations[1]!.result.resolve({ choices: [{ action: { type: 'fold' }, probability: 1 }] });
    await expect.poll(async () => (await (await f.summary(t, fresh.requestId)).json()).status).toBe('complete');
    for (let index = 0; index < 2; index++) { const other = await f.decision(); await f.command(other, 'act', { participantId: other.human, action: { type: 'fold' } }); await f.configure(other, reference); await f.post(other, 'hand-summaries', { handId: 'hand-1' }); }
    await expect.poll(() => f.evaluations.length).toBe(3);
    expect(f.evaluations).toHaveLength(3);
    f.evaluations[0]!.result.resolve({ choices: [{ action: { type: 'fold' }, probability: 1 }] });
    await expect.poll(() => f.evaluations.length).toBe(4);
    for (const evaluation of f.evaluations.slice(2)) evaluation.result.resolve({ choices: [{ action: { type: 'fold' }, probability: 1 }] });
  } finally { await f.close(); }
});

test('new summary members use priority 2 while a later interactive request keeps priority 1', async () => {
  const f = await fixture({ jobRunnerOptions: { concurrency: 1, maximumQueued: 8 } });
  try {
    const target = await f.decision(); await f.command(target, 'act', { participantId: target.human, action: { type: 'fold' } });
    const automatic = await (await f.request(target)).json(); await expect.poll(async () => (await (await f.result(target, automatic.requestId)).json()).status).toBe('complete'); await f.configure(target, reference);
    const blocker = await f.decision(); await f.configure(blocker, reference); await f.request(blocker); await expect.poll(() => f.evaluations.length).toBe(1);
    const summary = await (await f.post(target, 'hand-summaries', { handId: 'hand-1' })).json();
    const interactive = await f.decision(); await f.configure(interactive, reference); await f.request(interactive);
    f.evaluations[0]!.result.resolve({ choices: [{ action: { type: 'fold' }, probability: 1 }] });
    await expect.poll(() => f.evaluations.length).toBe(2);
    expect(f.evaluations[1]!.view.state.actorId).toBe(interactive.human);
    f.evaluations[1]!.result.resolve({ choices: [{ action: { type: 'fold' }, probability: 1 }] });
    await expect.poll(() => f.evaluations.length).toBe(3); expect(f.evaluations[2]!.view.state.actorId).toBe(target.human);
    f.evaluations[2]!.result.resolve({ choices: [{ action: { type: 'fold' }, probability: 1 }] });
    await expect.poll(async () => (await (await f.summary(target, summary.requestId)).json()).status).toBe('complete');
  } finally { await f.close(); }
});

test('an already failed member beyond the admission batch immediately outranks two held matching members', async () => {
  const f = await fixture({ automaticBots: true });
  try {
    const t = await f.decision();
    for (const type of ['call', 'check', 'check'] as const) {
      await f.command(t, 'act', { participantId: t.human, action: { type } });
      await expect.poll(async () => (await f.read(t)).view.state.actorId).toBe(t.human);
    }
    await f.configure(t, reference);
    const decisions = (await f.read(t)).view.history.flatMap(hand => hand.decisions.filter(decision => decision.action.participantId === t.human));
    expect(decisions).toHaveLength(3);
    const failed = await (await f.request(t, decisions[2]!.decisionId)).json();
    await expect.poll(() => f.evaluations.length).toBe(1); f.evaluations[0]!.result.reject(new Error('Controlled existing failure'));
    await expect.poll(async () => (await (await f.result(t, failed.requestId)).json()).status).toBe('error');
    await f.request(t, decisions[0]!.decisionId); await f.request(t, decisions[1]!.decisionId);
    await expect.poll(() => f.evaluations.length).toBe(3);
    const summary = await (await f.post(t, 'hand-summaries', { handId: 'hand-1' })).json();
    expect(summary).toMatchObject({ status: 'error', decisionCount: 3, error: { code: 'failed' } });
    expect(summary).not.toHaveProperty('averages'); expect(f.evaluations).toHaveLength(3);
    expect((await (await f.result(t, failed.requestId)).json()).attemptId).toBe(failed.attemptId);
  } finally { await f.close(); }
});


test('a later matching member failure is observed while two missing members occupy the summary budget', async () => {
  const f = await fixture({ automaticBots: true, jobRunnerOptions: { concurrency: 3 } });
  try {
    const t = await f.decision();
    for (const type of ['call', 'check', 'check'] as const) {
      await f.command(t, 'act', { participantId: t.human, action: { type } });
      await expect.poll(async () => (await f.read(t)).view.state.actorId).toBe(t.human);
    }
    await f.configure(t, reference);
    const decisions = (await f.read(t)).view.history.flatMap(hand => hand.decisions.filter(decision => decision.action.participantId === t.human));
    const existing = await (await f.request(t, decisions[2]!.decisionId)).json();
    await expect.poll(() => f.evaluations.length).toBe(1);
    const summary = await (await f.post(t, 'hand-summaries', { handId: 'hand-1' })).json();
    expect(summary.status).toBe('pending');
    await expect.poll(() => f.evaluations.length).toBe(3);
    f.evaluations[0]!.result.reject(new Error('Controlled failure after snapshot'));
    await expect.poll(async () => (await (await f.summary(t, summary.requestId)).json()).status).toBe('error');
    const failed = await (await f.summary(t, summary.requestId)).json();
    expect(failed).toMatchObject({ error: { code: 'failed' }, decisionCount: 3 });
    expect(failed).not.toHaveProperty('averages'); expect(f.evaluations).toHaveLength(3);
    expect((await (await f.result(t, existing.requestId)).json()).attemptId).toBe(existing.attemptId);
  } finally { await f.close(); }
});
