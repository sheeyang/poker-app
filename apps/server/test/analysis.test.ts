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
interface Evaluation { readonly view: ObservableGameView; readonly descriptor: StrategyDescriptor; readonly compatibilityView: ObservableGameView; readonly seed: string; readonly signal?: AbortSignal; readonly result: ReturnType<typeof Promise.withResolvers<PolicyResult>> }
const fixtureStrategy = (mode: string): StrategyDescriptor => ({ policy: { id: 'fixture', version: 'v1', configuration: { mode } }, selector: { id: 'highest-probability', version: 'v1', configuration: {} } });
async function fixture(options: Partial<ServerOptions> = {}) {
  const schema = 'test_' + randomUUID().replaceAll('-', '');
  await administration.query('CREATE SCHEMA "' + schema + '"');
  const evaluations: Evaluation[] = [];
  const held = new Set<Evaluation>();
  const sockets: WebSocket[] = [];
  let server: Awaited<ReturnType<typeof createServer>>;
  let base: string;
  async function start() {
    server = await createServer({ databaseUrl, schema, automaticBots: false,
      supportsStrategy: value => !!value && typeof value === 'object' && ['fixture', 'uniform-choice'].includes((value as StrategyDescriptor).policy?.id),
      strategyFactory: descriptor => {
        let compatibilityView: ObservableGameView;
        const mode = descriptor.policy.configuration.mode;
        return { policy: {
          checkCompatibility: view => { compatibilityView = view; return mode === 'incompatible' ? { compatible: false, reasons: [{ code: 'secret', message: 'private diagnostics' }] } : { compatible: true }; },
          evaluate: (view, execution) => {
            if (mode === 'throw') throw new Error('private seed diagnostic');
            if (mode === 'invalid') return { choices: [{ action: { type: 'call' }, probability: .2 }] };
            const result = Promise.withResolvers<PolicyResult>();
            const evaluation = { view, descriptor, compatibilityView: compatibilityView!, seed: execution.evaluationSeed, signal: execution.signal, result };
            evaluations.push(evaluation); held.add(evaluation); void result.promise.then(() => held.delete(evaluation), () => held.delete(evaluation));
            return result.promise;
          },
        }, actionSelector: mode === 'selector-error' ? { select() { throw new Error('private selector diagnostic'); } } : new HighestProbabilitySelector() };
      }, ...options });
    base = await server.listen({ host: '127.0.0.1', port: 0 });
  }
  await start();
  async function table() {
    const identity = await fetch(base + '/api/identity'); const cookie = identity.headers.get('set-cookie')!.split(';')[0]!;
    const response = await fetch(base + '/api/table-sessions', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ requestId: randomUUID(), bots: [{ name: 'Bot', playingStrategy: baselinePlayingStrategy }] }) });
    expect(response.status).toBe(201); const created = await response.json();
    return { id: created.tableSessionId as string, cookie, human: created.bindings[0].participantId as string, bot: created.bindings[1].participantId as string };
  }
  type Table = Awaited<ReturnType<typeof table>>;
  const read = async (t: Table): Promise<ObservableTableSession> => (await fetch(base + '/api/table-sessions/' + t.id, { headers: { cookie: t.cookie } })).json();
  const post = (t: Table, path: string, body: unknown, cookie = t.cookie) => fetch(base + '/api/table-sessions/' + t.id + '/' + path, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  async function command(t: Table, kind: string, body: object = {}) { const before = await read(t); const response = await post(t, kind, { requestId: randomUUID(), expectedPokerRevision: before.pokerRevision, ...body }); expect(response.status).toBe(200); }
  async function decision() { const t = await table(); await command(t, 'seat-participant', { participantId: t.human, seat: 1 }); await command(t, 'seat-participant', { participantId: t.bot, seat: 2 }); await command(t, 'start-hand'); return t; }
  async function configure(t: Table, referenceStrategy: StrategyDescriptor) { const before = await read(t); expect((await post(t, 'set-trainer-configuration', { requestId: randomUUID(), expectedSessionRevision: before.sessionRevision, trainerConfiguration: { referenceStrategy, liveAnalysis: false } })).status).toBe(200); }
  const request = async (t: Table) => post(t, 'analysis', { decisionId: (await read(t)).view.state.decisionId });
  const result = async (t: Table, requestId: string, cookie = t.cookie) => fetch(base + '/api/table-sessions/' + t.id + '/analysis/' + requestId, { headers: { cookie } });
  function connect(t: Table) { const socket = new WebSocket(base.replace('http:', 'ws:') + '/api/live', { headers: { cookie: t.cookie } }); sockets.push(socket); const messages: ServerLiveMessage[] = []; socket.on('message', data => messages.push(JSON.parse(data.toString()))); return { socket, messages }; }
  async function stop() { for (const socket of sockets) { if (socket.readyState === WebSocket.CONNECTING) await new Promise(resolve => { socket.once('open', resolve); socket.once('error', resolve); }); socket.terminate(); } const closing = server.close(); await expect.poll(() => [...held].every(evaluation => evaluation.signal?.aborted)).toBe(true); for (const evaluation of held) evaluation.result.resolve({ choices: [{ action: { type: 'fold' }, probability: 1 }] }); await closing; }
  return { table, decision, read, post, command, configure, request, result, connect, evaluations, schema, get base() { return base; }, async restart() { await stop(); evaluations.length = 0; await start(); }, async close() { await stop(); await administration.query('DROP SCHEMA "' + schema + '" CASCADE'); } };
}
const distribution: PolicyResult = { choices: [{ action: { type: 'raise', raiseTo: 100 }, probability: .25 }, { action: { type: 'call' }, probability: .75 }] };

test('explicit evaluation freezes the current human decision, returns numerical output separately from play, and persists exact matching reuse', async () => {
  const f = await fixture();
  try {
    const t = await f.decision(); const before = await f.read(t);
    const response = await f.request(t); expect(response.status).toBe(200);
    const pending = await response.json(); expect(pending).toMatchObject({ ok: true, status: 'pending', tableSessionId: t.id, decisionId: 'hand-1/decision-1', referenceStrategy: baselinePlayingStrategy });
    await expect.poll(() => f.evaluations.length).toBe(1);
    const evaluation = f.evaluations[0]!;
    expect(evaluation.view).toBe(evaluation.compatibilityView);
    expect(Object.isFrozen(evaluation.view.state.participants[0])).toBe(true);
    expect(evaluation.view.state.participants.find(p => p.participantId === t.human)?.holeCards).toHaveLength(2);
    expect(evaluation.view.state.participants.find(p => p.participantId === t.bot)).not.toHaveProperty('holeCards');
    expect(JSON.stringify(evaluation.view)).not.toMatch(/"(?:seed|pokerRevision|sessionRevision|commands|deck|burns|trainerConfiguration)"\s*:/);
    expect(await (await f.request(t)).json()).toEqual(pending);
    evaluation.result.resolve(distribution);
    await expect.poll(async () => (await (await f.result(t, pending.requestId)).json()).status).toBe('complete');
    const complete = await (await f.result(t, pending.requestId)).json();
    expect(complete).toMatchObject({ ...pending, status: 'complete', evaluation: { policyResult: { choices: [{ action: { type: 'call' }, probability: .75 }, { action: { type: 'raise', raiseTo: 100 }, probability: .25 }] }, selectedAction: { type: 'call' } } });
    expect(complete).not.toHaveProperty('scores');
    expect(await f.read(t)).toEqual(before);
    expect(await (await f.request(t)).json()).toEqual(complete);
    expect(f.evaluations).toHaveLength(1);
    await f.restart();
    expect(await (await f.request(t)).json()).toEqual(complete);
    expect(await (await f.result(t, pending.requestId)).json()).toEqual(complete);
    expect(f.evaluations).toHaveLength(0);
  } finally { await f.close(); }
});

test('concurrent consumers share work and only the owner receives readable completion without a live table subscription', async () => {
  const f = await fixture();
  try {
    const t = await f.decision(); const stranger = await f.table();
    const ownerLive = f.connect(t); const otherLive = f.connect(stranger);
    await expect.poll(() => ownerLive.messages.some(m => m.type === 'user-channel-ready')).toBe(true);
    await expect.poll(() => otherLive.messages.some(m => m.type === 'user-channel-ready')).toBe(true);
    const [one, two] = await Promise.all([f.request(t).then(r => r.json()), f.request(t).then(r => r.json())]);
    expect(one).toEqual(two); await expect.poll(() => f.evaluations.length).toBe(1);
    expect((await f.post(t, 'analysis', { decisionId: one.decisionId }, stranger.cookie)).status).toBe(404);
    expect((await f.result(t, one.requestId, stranger.cookie)).status).toBe(404);
    expect((await f.result(t, one.requestId, '')).status).toBe(401);
    const atNotification: Promise<unknown>[] = [];
    ownerLive.socket.on('message', data => { const frame = JSON.parse(data.toString()); if (frame.type === 'analysis-update' && frame.requestId === one.requestId) atNotification.push(f.result(t, frame.requestId).then(r => r.json())); });
    await f.command(t, 'act', { participantId: t.human, action: { type: 'fold' } });
    await f.configure(t, highestProbabilityPlayingStrategy);
    const advanced = await f.read(t);
    f.evaluations[0]!.result.resolve(distribution);
    await expect.poll(() => ownerLive.messages.find(m => m.type === 'analysis-update')).toEqual({ type: 'analysis-update', resource: 'analysis', tableSessionId: t.id, requestId: one.requestId, attemptId: one.attemptId, status: 'complete' });
    expect(await Promise.all(atNotification)).toEqual([expect.objectContaining({ status: 'complete', requestId: one.requestId, referenceStrategy: baselinePlayingStrategy })]);
    expect(otherLive.messages.some(m => m.type === 'analysis-update')).toBe(false);
    expect(await f.read(t)).toEqual(advanced);
    await f.restart();
    expect(await (await f.result(t, one.requestId)).json()).toMatchObject({ status: 'complete', requestId: one.requestId, referenceStrategy: baselinePlayingStrategy });
    expect(f.evaluations).toHaveLength(0);
  } finally { await f.close(); }
});

test('full shared capacity is an explicit admission error and a timed-out evaluation keeps capacity until its underlying Strategy settles', async () => {
  const f = await fixture({ jobRunnerOptions: { concurrency: 1, maximumQueued: 0, timeoutMs: 100 } });
  try {
    const t = await f.decision(); const other = await f.decision();
    const pending = await (await f.request(t)).json(); await expect.poll(() => f.evaluations.length).toBe(1);
    const rejected = await f.request(other); expect(rejected.status).toBe(503);
    const capacity = await rejected.json(); expect(capacity).toMatchObject({ status: 'error', error: { code: 'capacity' } });
    await expect.poll(async () => (await (await f.result(t, pending.requestId)).json()).error?.code).toBe('timeout');
    expect(f.evaluations[0]!.signal?.aborted).toBe(true);
    const third = await f.decision(); const afterTimeout = await f.request(third); expect(afterTimeout.status).toBe(503);
    expect(await afterTimeout.json()).toMatchObject({ status: 'error', error: { code: 'capacity' } });
    expect(f.evaluations).toHaveLength(1);
    f.evaluations[0]!.result.resolve(distribution);
    expect(await (await f.result(t, pending.requestId)).json()).toMatchObject({ status: 'error', error: { code: 'timeout' } });
    expect(await (await f.request(other)).json()).toEqual(capacity);
    expect(await f.read(t)).toMatchObject({ pokerRevision: 3, sessionRevision: 3, view: { state: { actorId: t.human } } });
  } finally { await f.close(); }
});

test.each([['incompatible', 'incompatible'], ['throw', 'failed'], ['invalid', 'invalid-policy'], ['selector-error', 'selection-failed']] as const)('%s is a safe readable failure and ordinary reads never restart it', async (mode, code) => {
  const f = await fixture();
  try {
    const t = await f.decision(); await f.configure(t, fixtureStrategy(mode)); const before = await f.read(t);
    const live = f.connect(t); await expect.poll(() => live.messages.some(m => m.type === 'user-channel-ready')).toBe(true);
    const requested = await (await f.request(t)).json();
    if (mode === 'selector-error') { await expect.poll(() => f.evaluations.length).toBe(1); f.evaluations[0]!.result.resolve(distribution); }
    await expect.poll(() => live.messages.find(m => m.type === 'analysis-update')).toMatchObject({ requestId: requested.requestId, attemptId: requested.attemptId, status: 'error' });
    const failure = await (await f.result(t, requested.requestId)).json();
    expect(failure).toMatchObject({ status: 'error', error: { code } });
    expect(JSON.stringify([failure, live.messages])).not.toMatch(/private|secret|diagnostic/);
    expect(await (await f.request(t)).json()).toEqual(failure);
    expect(await f.read(t)).toEqual(before);
    expect(f.evaluations).toHaveLength(mode === 'selector-error' ? 1 : 0);
    await f.restart();
    expect((await f.result(t, requested.requestId)).status).toBe(404);
    const fresh = await (await f.request(t)).json(); expect(fresh.requestId).not.toBe(requested.requestId);
  } finally { await f.close(); }
});

test('complete Policy and selector descriptors distinguish evaluations while matching descriptors survive configuration revisions', async () => {
  const f = await fixture();
  try {
    const t = await f.decision();
    const descriptors: StrategyDescriptor[] = [baselinePlayingStrategy, highestProbabilityPlayingStrategy, fixtureStrategy('hold'), { ...fixtureStrategy('hold'), policy: { ...fixtureStrategy('hold').policy, version: 'v2' } }, { ...fixtureStrategy('hold'), policy: { ...fixtureStrategy('hold').policy, configuration: { mode: 'hold', precision: 2 } } }, { ...fixtureStrategy('hold'), selector: { ...fixtureStrategy('hold').selector, version: 'v2' } }, { ...fixtureStrategy('hold'), selector: { ...fixtureStrategy('hold').selector, configuration: { tie: 'first' } } }];
    const requests: string[] = [];
    for (const [index, reference] of descriptors.entries()) {
      await f.configure(t, reference);
      const pending = await (await f.request(t)).json(); requests.push(pending.requestId);
      expect(pending.referenceStrategy).toEqual(reference);
      await expect.poll(() => f.evaluations.length).toBe(index + 1);
      f.evaluations[index]!.result.resolve(distribution);
      await expect.poll(async () => (await (await f.result(t, pending.requestId)).json()).status).toBe('complete');
    }
    expect(new Set(requests).size).toBe(descriptors.length);
    await f.configure(t, baselinePlayingStrategy);
    expect(await (await f.request(t)).json()).toMatchObject({ status: 'complete', requestId: requests[0] });
    expect(f.evaluations).toHaveLength(descriptors.length);
    const other = await f.decision(); const otherRequest = await (await f.request(other)).json();
    expect(requests).not.toContain(otherRequest.requestId);
    await expect.poll(() => f.evaluations.length).toBe(descriptors.length + 1);
    expect(otherRequest.inputFingerprint).not.toBe((await (await f.result(t, requests[0]!)).json()).inputFingerprint);
  } finally { await f.close(); }
});

test('a real PostgreSQL result-write failure is readable before error notification and never claims durable success', async () => {
  const f = await fixture();
  try {
    const t = await f.decision(); const live = f.connect(t); await expect.poll(() => live.messages.some(m => m.type === 'user-channel-ready')).toBe(true);
    // Dependency fault only: application state is still observed through HTTP and WS.
    await administration.query('CREATE FUNCTION "' + f.schema + '".reject_analysis() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION \'private database diagnostic\'; END $$');
    await administration.query('CREATE TRIGGER reject_analysis BEFORE INSERT ON "' + f.schema + '".analysis_evaluations FOR EACH ROW EXECUTE FUNCTION "' + f.schema + '".reject_analysis()');
    const pending = await (await f.request(t)).json(); await expect.poll(() => f.evaluations.length).toBe(1); f.evaluations[0]!.result.resolve(distribution);
    await expect.poll(() => live.messages.find(m => m.type === 'analysis-update')).toMatchObject({ requestId: pending.requestId, attemptId: pending.attemptId, status: 'error' });
    const failure = await (await f.result(t, pending.requestId)).json(); expect(failure).toMatchObject({ status: 'error', error: { code: 'persistence-unavailable' } });
    expect(JSON.stringify(failure)).not.toMatch(/private|diagnostic/);
    expect(failure).not.toHaveProperty('evaluation');
    await administration.query('DROP TRIGGER reject_analysis ON "' + f.schema + '".analysis_evaluations');
    expect(await (await f.request(t)).json()).toEqual(failure);
    expect(f.evaluations).toHaveLength(1);
    await f.restart();
    expect((await f.result(t, pending.requestId)).status).toBe(404);
    const fresh = await (await f.request(t)).json(); expect(fresh).toMatchObject({ status: 'pending' }); expect(fresh.requestId).not.toBe(pending.requestId);
    await expect.poll(() => f.evaluations.length).toBe(1); f.evaluations[0]!.result.resolve(distribution);
    await expect.poll(async () => (await (await f.result(t, fresh.requestId)).json()).status).toBe('complete');
  } finally { await f.close(); }
});

test('shutdown discards late old-lifecycle work and restart schedules genuinely missing analysis only when requested', async () => {
  const f = await fixture();
  try {
    const t = await f.decision(); const before = await f.read(t);
    const old = await (await f.request(t)).json(); await expect.poll(() => f.evaluations.length).toBe(1);
    await f.restart();
    expect(f.evaluations).toHaveLength(0);
    expect((await f.result(t, old.requestId)).status).toBe(404);
    const fresh = await (await f.request(t)).json();
    expect(fresh).toMatchObject({ status: 'pending', inputFingerprint: old.inputFingerprint, evaluationSeed: old.evaluationSeed, selectionSeed: old.selectionSeed });
    expect(fresh.requestId).not.toBe(old.requestId); expect(fresh.attemptId).not.toBe(old.attemptId);
    await expect.poll(() => f.evaluations.length).toBe(1); f.evaluations[0]!.result.resolve(distribution);
    await expect.poll(async () => (await (await f.result(t, fresh.requestId)).json()).status).toBe('complete');
    expect(await f.read(t)).toEqual(before);
  } finally { await f.close(); }
});


test('failed-only Retry preserves its immutable request while concurrent consumers reuse one new attempt', async () => {
  const f = await fixture();
  try {
    const t = await f.decision(); const stranger = await f.table();
    await f.configure(t, fixtureStrategy('hold'));
    const pending = await (await f.request(t)).json();
    await expect.poll(() => f.evaluations.length).toBe(1);
    const original = f.evaluations[0]!;
    original.result.resolve({ choices: [{ action: { type: 'call' }, probability: .2 }] });
    await expect.poll(async () => (await (await f.result(t, pending.requestId)).json()).status).toBe('error');
    const failed = await (await f.result(t, pending.requestId)).json();
    expect(await (await f.request(t)).json()).toEqual(failed);
    await f.configure(t, highestProbabilityPlayingStrategy);
    await f.command(t, 'act', { participantId: t.human, action: { type: 'fold' } });
    const before = await f.read(t);
    const retry = () => f.post(t, 'analysis/' + pending.requestId + '/retry', {});
    expect((await f.post(t, 'analysis/' + pending.requestId + '/retry', {}, stranger.cookie)).status).toBe(404);
    expect((await f.post(t, 'analysis/' + pending.requestId + '/retry', {}, '')).status).toBe(401);
    expect((await f.post(t, 'analysis/' + pending.requestId + '/retry', { referenceStrategy: baselinePlayingStrategy })).status).toBe(400);
    const responses = await Promise.all([retry(), retry(), retry()]);
    expect(responses.map(response => response.status)).toEqual([200, 200, 200]);
    const states = await Promise.all(responses.map(response => response.json()));
    expect(states[1]).toEqual(states[0]); expect(states[2]).toEqual(states[0]);
    expect(states[0]).toMatchObject({ ...pending, status: 'pending', attemptId: expect.any(String) });
    expect(states[0].attemptId).not.toBe(pending.attemptId);
    expect(states[0]).not.toHaveProperty('error');
    await expect.poll(() => f.evaluations.length).toBe(3);
    const retryEvaluation = f.evaluations.find(evaluation => evaluation !== original && evaluation.descriptor.policy.id === 'fixture')!;
    expect(retryEvaluation.view).toEqual(original.view); expect(retryEvaluation.seed).toBe(original.seed);
    expect(await (await retry()).json()).toEqual(states[0]);
    const live = f.connect(t); await expect.poll(() => live.messages.some(message => message.type === 'user-channel-ready')).toBe(true);
    for (const evaluation of f.evaluations) evaluation.result.resolve(distribution);
    await expect.poll(() => live.messages.find(message => message.type === 'analysis-update' && message.requestId === pending.requestId)).toMatchObject({ requestId: pending.requestId, attemptId: states[0].attemptId, status: 'complete' });
    const complete = await (await f.result(t, pending.requestId)).json();
    expect(complete).toMatchObject({ ...states[0], status: 'complete' });
    expect(await (await retry()).json()).toEqual(complete);
    expect(f.evaluations).toHaveLength(3); expect(await f.read(t)).toEqual(before);
    await f.restart();
    expect(await (await retry()).json()).toEqual(complete);
    expect(f.evaluations).toHaveLength(0);
  } finally { await f.close(); }
});


test.each(['success', 'error'] as const)('timed-out old %s cannot replace a retry attempt while underlying work retains its runner capacity', async late => {
  const f = await fixture({ jobRunnerOptions: { concurrency: 2, maximumQueued: 0, timeoutMs: 600 } });
  try {
    const t = await f.decision(); const before = await f.read(t);
    const live = f.connect(t); await expect.poll(() => live.messages.some(message => message.type === 'user-channel-ready')).toBe(true);
    const original = await (await f.request(t)).json(); await expect.poll(() => f.evaluations.length).toBe(1);
    await expect.poll(async () => (await (await f.result(t, original.requestId)).json()).error?.code, { timeout: 3000 }).toBe('timeout');
    const retried = await (await f.post(t, 'analysis/' + original.requestId + '/retry', {})).json();
    expect(retried).toMatchObject({ status: 'pending', requestId: original.requestId });
    expect(retried.attemptId).not.toBe(original.attemptId);
    await expect.poll(() => f.evaluations.length).toBe(2);
    expect(f.evaluations[1]!.seed).toBe(f.evaluations[0]!.seed); expect(f.evaluations[1]!.view).toEqual(f.evaluations[0]!.view);
    if (late === 'success') f.evaluations[0]!.result.resolve(distribution);
    else f.evaluations[0]!.result.reject(new Error('private obsolete Strategy error'));
    expect(await (await f.result(t, original.requestId)).json()).toEqual(retried);
    f.evaluations[1]!.result.resolve({ choices: [{ action: { type: 'fold' }, probability: 1 }] });
    await expect.poll(async () => (await (await f.result(t, original.requestId)).json()).status).toBe('complete');
    expect(await (await f.result(t, original.requestId)).json()).toMatchObject({ attemptId: retried.attemptId, evaluation: { selectedAction: { type: 'fold' } } });
    await expect.poll(() => live.messages.filter(message => message.type === 'analysis-update' && message.status === 'complete')).toEqual([expect.objectContaining({ attemptId: retried.attemptId })]);
    expect(await f.read(t)).toEqual(before);
  } finally { await f.close(); }
});

test('Retry reports capacity honestly until timed-out underlying work settles, then reuses the same frozen request', async () => {
  const f = await fixture({ jobRunnerOptions: { concurrency: 1, maximumQueued: 0, timeoutMs: 150 } });
  try {
    const t = await f.decision(); const original = await (await f.request(t)).json();
    await expect.poll(async () => (await (await f.result(t, original.requestId)).json()).error?.code).toBe('timeout');
    const rejected = await f.post(t, 'analysis/' + original.requestId + '/retry', {});
    expect(rejected.status).toBe(503);
    const capacity = await rejected.json(); expect(capacity).toMatchObject({ status: 'error', requestId: original.requestId, error: { code: 'capacity' } });
    expect(await (await f.result(t, original.requestId)).json()).toEqual(capacity);
    expect(await (await f.request(t)).json()).toEqual(capacity); expect(f.evaluations).toHaveLength(1);
    f.evaluations[0]!.result.resolve(distribution);
    // A public HTTP round trip observes the retained error while the released Strategy settles.
    expect(await (await f.result(t, original.requestId)).json()).toEqual(capacity);
    const retried = await f.post(t, 'analysis/' + original.requestId + '/retry', {}); expect(retried.status).toBe(200);
    const pending = await retried.json(); expect(pending).toMatchObject({ status: 'pending', requestId: original.requestId });
    await expect.poll(() => f.evaluations.length).toBe(2); f.evaluations[1]!.result.resolve(distribution);
    await expect.poll(async () => (await (await f.result(t, original.requestId)).json()).status).toBe('complete');
  } finally { await f.close(); }
});


test('Retry after a real PostgreSQL result failure saves a new attempt and makes success readable before notification', async () => {
  const f = await fixture();
  try {
    const t = await f.decision(); const before = await f.read(t);
    await administration.query('CREATE FUNCTION "' + f.schema + '".retry_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION $fault$private database failure$fault$; END $$');
    await administration.query('CREATE TRIGGER retry_failure BEFORE INSERT ON "' + f.schema + '".analysis_evaluations FOR EACH ROW EXECUTE FUNCTION "' + f.schema + '".retry_failure()');
    const original = await (await f.request(t)).json(); await expect.poll(() => f.evaluations.length).toBe(1); f.evaluations[0]!.result.resolve(distribution);
    await expect.poll(async () => (await (await f.result(t, original.requestId)).json()).error?.code).toBe('persistence-unavailable');
    await administration.query('DROP TRIGGER retry_failure ON "' + f.schema + '".analysis_evaluations');
    const retried = await (await f.post(t, 'analysis/' + original.requestId + '/retry', {})).json();
    expect(retried.attemptId).not.toBe(original.attemptId);
    await expect.poll(() => f.evaluations.length).toBe(2);
    expect(f.evaluations[1]!.seed).toBe(f.evaluations[0]!.seed);
    const live = f.connect(t); await expect.poll(() => live.messages.some(message => message.type === 'user-channel-ready')).toBe(true);
    const reads: Promise<any>[] = []; live.socket.on('message', data => { const message = JSON.parse(data.toString()); if (message.type === 'analysis-update') reads.push(f.result(t, message.requestId).then(response => response.json())); });
    f.evaluations[1]!.result.resolve(distribution);
    await expect.poll(() => reads.length).toBe(1);
    expect(await Promise.all(reads)).toEqual([expect.objectContaining({ status: 'complete', requestId: original.requestId, attemptId: retried.attemptId })]);
    expect(await f.read(t)).toEqual(before);
    await f.restart(); expect(await (await f.result(t, original.requestId)).json()).toMatchObject({ status: 'complete', attemptId: retried.attemptId });
  } finally { await f.close(); }
});
