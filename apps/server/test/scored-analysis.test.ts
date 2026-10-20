import { afterAll, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import WebSocket from 'ws';
import { baselinePlayingStrategy, highestProbabilityPlayingStrategy, type ObservableGameView, type ObservableTableSession, type StrategyDescriptor, type ServerLiveMessage } from '@poker/contracts';
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
    server = await createServer({ databaseUrl, schema, automaticBots: false, supportsStrategy: value => !!value && typeof value === 'object' && ['fixture', 'uniform-choice'].includes((value as StrategyDescriptor).policy?.id), strategyFactory: () => ({
      policy: { checkCompatibility: () => ({ compatible: true }), evaluate: (view, execution) => { const result = Promise.withResolvers<PolicyResult>(); const evaluation = { view, seed: execution.evaluationSeed, signal: execution.signal, result }; evaluations.push(evaluation); held.add(evaluation); void result.promise.then(() => held.delete(evaluation)); return result.promise; } }, actionSelector: new HighestProbabilitySelector(),
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
  return { table, decision, read, post, command, configure, request, result, connect, evaluations, schema, async restart() { await stop(); evaluations.length = 0; await start(); }, async close() { await stop(); await administration.query('DROP SCHEMA "' + schema + '" CASCADE'); } };
}
const distribution: PolicyResult = { choices: [{ action: { type: 'fold' }, probability: .25 }, { action: { type: 'call' }, probability: .25 }, { action: { type: 'raise', raiseTo: 40 }, probability: .4 }, { action: { type: 'raise', raiseTo: 100 }, probability: .1 }] };

test('an accepted human decision reuses its completed pre-action evaluation and retains a separate reproducible score after restart', async () => {
  const f = await fixture();
  try {
    const t = await f.decision();
    const evaluation = await (await f.request(t)).json();
    await expect.poll(() => f.evaluations.length).toBe(1); f.evaluations[0]!.result.resolve(distribution);
    await expect.poll(async () => (await (await f.result(t, evaluation.requestId)).json()).status).toBe('complete');
    expect(await (await f.result(t, evaluation.requestId)).json()).not.toHaveProperty('scores');
    await f.command(t, 'act', { participantId: t.human, action: { type: 'raise', raiseTo: 70 } });
    const before = await f.read(t);
    const response = await f.request(t); expect(response.status).toBe(200);
    const scored = await response.json();
    await expect.poll(async () => (await (await f.result(t, scored.requestId)).json()).status).toBe('complete');
    const complete = await (await f.result(t, scored.requestId)).json();
    expect(complete).toMatchObject({ status: 'complete', scoredDecision: { acceptedAction: { type: 'raise', raiseTo: 70 }, scoringMethodVersion: 'v1' }, scores: { decisionScore: .2, actionRankScore: 1 }, evaluationRequestId: evaluation.requestId });
    expect(complete.requestId).not.toBe(evaluation.requestId);
    expect(f.evaluations).toHaveLength(1);
    expect(await f.read(t)).toEqual(before);
    expect(await (await f.result(t, evaluation.requestId)).json()).not.toHaveProperty('scores');
    await f.restart();
    expect(await (await f.request(t)).json()).toEqual(complete);
    expect(await (await f.result(t, complete.requestId)).json()).toEqual(complete);
    expect(f.evaluations).toHaveLength(0);
  } finally { await f.close(); }
});

test('concurrent accepted requests share an in-flight evaluation and publish readable scores without a table subscription', async () => {
  const f = await fixture();
  try {
    const t = await f.decision(); const other = await f.table();
    const live = f.connect(t); const stranger = f.connect(other);
    await expect.poll(() => live.messages.some(message => message.type === 'user-channel-ready')).toBe(true);
    await expect.poll(() => stranger.messages.some(message => message.type === 'user-channel-ready')).toBe(true);
    const preAction = await (await f.request(t)).json(); await expect.poll(() => f.evaluations.length).toBe(1);
    await f.command(t, 'act', { participantId: t.human, action: { type: 'fold' } });
    const before = await f.read(t);
    const [first, second] = await Promise.all([f.request(t).then(response => response.json()), f.request(t).then(response => response.json())]);
    expect(first).toEqual(second);
    expect(first).toMatchObject({ status: 'pending', evaluationRequestId: preAction.requestId });
    expect((await f.post(t, 'analysis', { decisionId: first.decisionId }, other.cookie)).status).toBe(404);
    expect((await f.result(t, first.requestId, other.cookie)).status).toBe(404);
    const atNotification: Promise<unknown>[] = [];
    live.socket.on('message', raw => { const frame = JSON.parse(raw.toString()); if (frame.type === 'analysis-update' && frame.requestId === first.requestId) atNotification.push(f.result(t, first.requestId).then(response => response.json())); });
    f.evaluations[0]!.result.resolve(distribution);
    await expect.poll(() => live.messages.find(message => message.type === 'analysis-update' && message.requestId === first.requestId)).toMatchObject({ attemptId: first.attemptId, status: 'complete' });
    expect(await Promise.all(atNotification)).toEqual([expect.objectContaining({ status: 'complete', scores: expect.objectContaining({ decisionScore: .25, actionRankScore: 0 }) })]);
    expect(stranger.messages.some(message => message.type === 'analysis-update')).toBe(false);
    expect(f.evaluations).toHaveLength(1);
    expect(await f.read(t)).toEqual(before);
  } finally { await f.close(); }
});

test('historical scoring captures the original safe view after showdown, inspection, management and later play, with the current complete reference', async () => {
  const inputs: ObservableGameView[] = [];
  let human = '';
  const reference: StrategyDescriptor = { policy: { id: 'fixture', version: 'v1', configuration: { history: true } }, selector: highestProbabilityPlayingStrategy.selector };
  const f = await fixture({ automaticBots: true, strategyFactory: descriptor => ({ policy: { checkCompatibility: () => ({ compatible: true }), evaluate: view => {
    if (view.state.actorId === human) inputs.push(view);
    if (descriptor.policy.id === 'fixture') return distribution;
    const passive = view.state.legalActions.find(action => action.type === 'call' || action.type === 'check')!;
    return { choices: [{ action: { type: passive.type as 'call' | 'check' }, probability: 1 }] };
  } }, actionSelector: new HighestProbabilitySelector() }) });
  try {
    const t = await f.decision(); human = t.human;
    const original = (await f.read(t)).view;
    for (let count = 0; count < 8 && (await f.read(t)).view.state.status !== 'completed-hand'; count++) {
      await expect.poll(async () => { const state = (await f.read(t)).view.state; return state.actorId === t.human || state.status === 'completed-hand'; }).toBe(true);
      const state = (await f.read(t)).view.state;
      if (state.status === 'completed-hand') break;
      const passive = state.legalActions.find(action => action.type === 'call' || action.type === 'check')!;
      await f.command(t, 'act', { participantId: t.human, action: { type: passive.type } });
    }
    await expect.poll(async () => (await f.read(t)).view.state.status).toBe('completed-hand');
    expect((await f.post(t, 'inspect-hand', { handId: 'hand-1' })).status).toBe(200);
    await f.command(t, 'top-up-to', { participantId: t.human, targetStack: 1200 });
    await f.command(t, 'move-participant', { participantId: t.human, seat: 3 });
    await f.command(t, 'set-button', { seat: 3 });
    await f.command(t, 'start-hand');
    await f.configure(t, reference);
    const before = await f.read(t);
    const requested = await (await f.request(t)).json();
    await expect.poll(async () => (await (await f.result(t, requested.requestId)).json()).status).toBe('complete');
    const first = await (await f.result(t, requested.requestId)).json();
    expect(first).toMatchObject({ referenceStrategy: reference, scoredDecision: { acceptedAction: { type: 'call' } }, scores: { decisionScore: .25, actionRankScore: 0 } });
    expect(inputs).toEqual([original]);
    expect(Object.isFrozen(inputs[0]!.history)).toBe(true);
    expect(inputs[0]!.state.participants.find(participant => participant.participantId === t.bot)).not.toHaveProperty('holeCards');
    expect(await f.read(t)).toEqual(before);
    expect((await f.request(t, 'hand-1/decision-2')).status).toBe(400);
    await f.configure(t, highestProbabilityPlayingStrategy);
    const changed = await (await f.request(t)).json();
    await expect.poll(async () => (await (await f.result(t, changed.requestId)).json()).status).toBe('complete');
    expect(await (await f.result(t, changed.requestId)).json()).toMatchObject({ referenceStrategy: highestProbabilityPlayingStrategy, scores: { decisionScore: 1, actionRankScore: 1 } });
    expect(changed.requestId).not.toBe(first.requestId);
    expect(inputs).toEqual([original, original]);
    await f.configure(t, reference);
    expect(await (await f.request(t)).json()).toEqual(first);
    expect(inputs).toHaveLength(2);
  } finally { await f.close(); }
});

test('a score persistence failure retains its successful evaluation, is readable before notification, and never restarts on read', async () => {
  const f = await fixture();
  try {
    const t = await f.decision();
    const evaluation = await (await f.request(t)).json(); await expect.poll(() => f.evaluations.length).toBe(1); f.evaluations[0]!.result.resolve(distribution);
    await expect.poll(async () => (await (await f.result(t, evaluation.requestId)).json()).status).toBe('complete');
    await f.command(t, 'act', { participantId: t.human, action: { type: 'fold' } });
    const before = await f.read(t); const live = f.connect(t);
    await expect.poll(() => live.messages.some(message => message.type === 'user-channel-ready')).toBe(true);
    await administration.query('CREATE FUNCTION "' + f.schema + '".reject_score() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION \'private score diagnostic\'; END $$');
    await administration.query('CREATE TRIGGER reject_score BEFORE INSERT ON "' + f.schema + '".analysis_scores FOR EACH ROW EXECUTE FUNCTION "' + f.schema + '".reject_score()');
    const requested = await (await f.request(t)).json();
    await expect.poll(() => live.messages.find(message => message.type === 'analysis-update' && message.requestId === requested.requestId)).toMatchObject({ status: 'error' });
    const failure = await (await f.result(t, requested.requestId)).json();
    expect(failure).toMatchObject({ status: 'error', error: { code: 'persistence-unavailable' }, evaluationRequestId: evaluation.requestId });
    expect(failure).not.toHaveProperty('scores');
    expect(JSON.stringify(failure)).not.toMatch(/private|diagnostic/);
    await administration.query('DROP TRIGGER reject_score ON "' + f.schema + '".analysis_scores');
    expect(await (await f.request(t)).json()).toEqual(failure);
    expect(await (await f.result(t, evaluation.requestId)).json()).toMatchObject({ status: 'complete' });
    expect(f.evaluations).toHaveLength(1);
    expect(await f.read(t)).toEqual(before);
    await f.restart();
    const fresh = await (await f.request(t)).json();
    await expect.poll(async () => (await (await f.result(t, fresh.requestId)).json()).status).toBe('complete');
    expect(f.evaluations).toHaveLength(0);
  } finally { await f.close(); }
});

test('a failed evaluation remains a safe failed score dependency without implicit restart', async () => {
  let compatibilityChecks = 0;
  const f = await fixture({ strategyFactory: () => ({ policy: { checkCompatibility: () => { compatibilityChecks++; return { compatible: false, reasons: [{ code: 'private', message: 'private diagnostics' }] }; }, evaluate: () => { throw new Error('Unreachable'); } }, actionSelector: new HighestProbabilitySelector() }) });
  try {
    const t = await f.decision(); await f.command(t, 'act', { participantId: t.human, action: { type: 'fold' } }); const before = await f.read(t);
    const requested = await (await f.request(t)).json();
    await expect.poll(async () => (await (await f.result(t, requested.requestId)).json()).status).toBe('error');
    const failure = await (await f.result(t, requested.requestId)).json();
    expect(failure).toMatchObject({ status: 'error', error: { code: 'incompatible' } });
    expect(JSON.stringify(failure)).not.toMatch(/private|diagnostics/);
    expect(await (await f.request(t)).json()).toEqual(failure);
    expect(compatibilityChecks).toBe(1);
    expect(await f.read(t)).toEqual(before);
  } finally { await f.close(); }
});

test('shutdown releases a waiting score dependency and restart creates no work until the historical target is requested', async () => {
  const f = await fixture();
  try {
    const t = await f.decision(); await f.command(t, 'act', { participantId: t.human, action: { type: 'fold' } });
    const old = await (await f.request(t)).json(); await expect.poll(() => f.evaluations.length).toBe(1);
    await f.restart();
    expect(f.evaluations).toHaveLength(0);
    expect((await f.result(t, old.requestId)).status).toBe(404);
    const fresh = await (await f.request(t)).json(); expect(fresh.requestId).not.toBe(old.requestId);
    await expect.poll(() => f.evaluations.length).toBe(1); f.evaluations[0]!.result.resolve(distribution);
    await expect.poll(async () => (await (await f.result(t, fresh.requestId)).json()).status).toBe('complete');
  } finally { await f.close(); }
});
