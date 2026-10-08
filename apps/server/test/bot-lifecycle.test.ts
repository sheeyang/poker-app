import { expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import WebSocket from 'ws';
import { baselinePlayingStrategy, type ConcreteAction, type ObservableGameView, type ObservableTableSession, type StrategyDescriptor, type TableLiveMessage } from '@poker/contracts';
import { HighestProbabilitySelector, ProbabilitySelector, type PolicyResult } from '@poker/strategies';
import { createServer, type ServerOptions } from '../src/server.js';
import type { TableSessionControllerCommands } from '../src/mutations.js';

const databaseUrl = process.env.TEST_DATABASE_URL!;
const administration = new Pool({ connectionString: databaseUrl });
interface Evaluation { view: ObservableGameView; seed: string; descriptor: StrategyDescriptor; compatibilityView: ObservableGameView; signal?: AbortSignal; result: ReturnType<typeof Promise.withResolvers<PolicyResult>> }
const descriptor = (mode = 'hold', selector = 'highest-probability'): StrategyDescriptor => ({ policy: { id: 'fixture', version: 'v1', configuration: { mode } }, selector: { id: selector, version: 'v1', configuration: {} } });
async function fixture(options: Partial<ServerOptions> = {}) {
  const schema = 'test_' + randomUUID().replaceAll('-', '');
  await administration.query('CREATE SCHEMA "' + schema + '"');
  const evaluations: Evaluation[] = [];
  const futureAnswers: PolicyResult[] = [];
  let commands: TableSessionControllerCommands;
  let server: Awaited<ReturnType<typeof createServer>>;
  let base: string;
  const start = async (automaticBots = true) => {
    server = await createServer({ databaseUrl, schema, automaticBots, jobRunnerOptions: { timeoutMs: 2000 },
      supportsStrategy: value => !!value && typeof value === 'object' && ['fixture', 'uniform-choice'].includes((value as StrategyDescriptor).policy?.id),
      strategyFactory: configured => {
        let compatibilityView: ObservableGameView;
        const mode = configured.policy.configuration.mode;
        return {
          policy: {
            checkCompatibility: view => { compatibilityView = view; return mode === 'incompatible' ? { compatible: false, reasons: [{ code: 'secret', message: 'untrusted compatibility secret' }] } : { compatible: true }; },
            evaluate: (view, execution) => {
              if (mode === 'throw') throw new Error('untrusted error: seed/private cards');
              if (mode === 'invalid') return { choices: [{ action: { type: 'call' }, probability: .2 }], diagnostics: { private: 'untrusted diagnostic' } };
              if (mode === 'selector-error') return { choices: [{ action: view.state.legalActions.some(a => a.type === 'call') ? { type: 'call' } : { type: 'check' }, probability: 1 }] };
              const result = Promise.withResolvers<PolicyResult>();
              evaluations.push({ view, descriptor: configured, compatibilityView: compatibilityView!, seed: execution.evaluationSeed, signal: execution.signal, result });
              if (futureAnswers.length) result.resolve(futureAnswers.shift()!);
              return result.promise;
            },
          },
          actionSelector: mode === 'selector-error' ? { select() { throw new Error('untrusted selection diagnostic'); } } : configured.selector.id === 'seeded-sampling' ? new ProbabilitySelector() : new HighestProbabilitySelector(),
        };
      }, ...options, onControllerCommandsReady: ready => { commands = ready; } });
    base = await server.listen({ host: '127.0.0.1', port: 0 });
  };
  await start();
  async function table(strategy = descriptor()) {
    const identity = await fetch(base + '/api/identity'); const cookie = identity.headers.get('set-cookie')!.split(';')[0]!;
    const response = await fetch(base + '/api/table-sessions', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ requestId: randomUUID(), bots: [{ name: 'Bot', playingStrategy: strategy }] }) });
    expect(response.status).toBe(201); const created = await response.json();
    return { id: created.tableSessionId as string, cookie, human: created.bindings[0].participantId as string, bot: created.bindings[1].participantId as string };
  }
  type Table = Awaited<ReturnType<typeof table>>;
  const read = async (t: Table): Promise<ObservableTableSession> => (await fetch(base + '/api/table-sessions/' + t.id, { headers: { cookie: t.cookie } })).json();
  const submit = (t: Table, kind: string, body: unknown, cookie = t.cookie) => fetch(base + '/api/table-sessions/' + t.id + '/' + kind, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  async function command(t: Table, kind: string, contents: object = {}) { const before = await read(t); const response = await submit(t, kind, { requestId: randomUUID(), expectedPokerRevision: before.pokerRevision, ...contents }); expect(response.status).toBe(200); return response.json(); }
  async function configure(t: Table, kind: string, contents: object = {}, requestId: string = randomUUID()) { const before = await read(t); return submit(t, kind, { requestId, expectedSessionRevision: before.sessionRevision, participantId: t.bot, ...contents }); }
  async function botDecision(t: Table) { await command(t, 'seat-participant', { participantId: t.human, seat: 1 }); await command(t, 'seat-participant', { participantId: t.bot, seat: 2 }); await command(t, 'start-hand'); await command(t, 'act', { participantId: t.human, action: { type: 'call' } }); }
  function connect(t: Table) { const socket = new WebSocket(base.replace('http:', 'ws:') + '/api/table-sessions/' + t.id + '/live', { headers: { cookie: t.cookie } }); const messages: TableLiveMessage[] = []; socket.on('message', data => messages.push(JSON.parse(data.toString()))); return { socket, messages }; }
  return { table, read, submit, command, configure, botDecision, connect, evaluations, answerNext: (value: PolicyResult) => futureAnswers.push(value), get commands() { return commands!; }, stop: () => server.close(), async restart(automatic = true) { for (const item of evaluations) item.result.resolve({ choices: [{ action: { type: 'fold' }, probability: 1 }] }); await server.close(); evaluations.length = 0; await start(automatic); }, async close() { for (const item of evaluations) item.result.resolve({ choices: [{ action: { type: 'fold' }, probability: 1 }] }); await server?.close(); await administration.query('DROP SCHEMA "' + schema + '" CASCADE'); } };
}
const answer = (action: ConcreteAction): PolicyResult => ({ choices: [{ action, probability: 1 }], diagnostics: { information: 'not public' } });

test('Bot inputs are the same frozen participant-safe view for compatibility/evaluation and accepted provenance is durable through replacement/restart', async () => {
  const f = await fixture();
  try {
    const t = await f.table(); await f.botDecision(t);
    await expect.poll(() => f.evaluations.length).toBe(1);
    const evaluation = f.evaluations[0]!;
    expect(evaluation.view).toBe(evaluation.compatibilityView);
    expect(Object.isFrozen(evaluation.view.history)).toBe(true);
    expect(Object.isFrozen(evaluation.view.state.participants[0])).toBe(true);
    expect(evaluation.view.state.participants.find(p => p.participantId === t.bot)?.holeCards).toHaveLength(2);
    expect(evaluation.view.state.participants.find(p => p.participantId === t.human)).not.toHaveProperty('holeCards');
    expect(JSON.stringify(evaluation.view)).not.toMatch(/"(?:seed|pokerRevision|sessionRevision|evaluationRequestId|playingStrategy|deck|burns|commands)"\s*:/);
    expect(() => { (evaluation.view.state.board as string[]).push('As'); }).toThrow();
    evaluation.result.resolve(answer({ type: 'fold' }));
    await expect.poll(async () => (await f.read(t)).pokerRevision).toBe(5);
    const accepted = await f.commands.readPersistedSession(t.id);
    expect(accepted?.pokerRecord.commands[4]).toEqual({ type: 'act', participantId: t.bot, action: { type: 'fold' } });
    expect(accepted?.botProvenance).toEqual([expect.objectContaining({ commandIndex: 4, participantId: t.bot, handId: 'hand-1', decisionId: evaluation.view.state.decisionId, playingStrategy: descriptor(), evaluationSeed: evaluation.seed, selectionSeed: expect.stringMatching(/^[a-f0-9]{64}$/) })]);
    expect(Object.isFrozen(accepted?.botProvenance?.[0]?.playingStrategy.policy.configuration)).toBe(true);
    expect((await f.configure(t, 'set-playing-strategy', { playingStrategy: descriptor('incompatible', 'seeded-sampling') })).status).toBe(200);
    expect(await f.read(t)).toMatchObject({ pokerRevision: 5, sessionRevision: 6 });
    await f.restart();
    expect(await f.commands.readPersistedSession(t.id)).toMatchObject({ botProvenance: accepted?.botProvenance, pokerRecord: accepted?.pokerRecord });
    expect(f.evaluations).toEqual([]); // Restoration replays the ConcreteAction, never historical Policy work.
    expect(await f.read(t)).toMatchObject({ pokerRevision: 5, sessionRevision: 6, view: { state: { status: 'completed-hand', handId: 'hand-1' } } });
  } finally { await f.close(); }
});

test.each([['incompatible', 'incompatible'], ['throw', 'failed'], ['invalid', 'invalid-policy'], ['selector-error', 'selection-failed']] as const)('%s produces a sanitized explicit failure without fallback action or revisions', async (mode, code) => {
  const f = await fixture();
  let socket: WebSocket | undefined;
  try {
    const t = await f.table(descriptor(mode)); const live = f.connect(t); socket = live.socket;
    await expect.poll(() => live.messages.length).toBe(1); await f.botDecision(t);
    await expect.poll(() => live.messages.find(m => m.type === 'table-status' && m.status.phase === 'failed')).toMatchObject({ status: { phase: 'failed', participantId: t.bot, code } });
    expect(await f.read(t)).toMatchObject({ pokerRevision: 4, sessionRevision: 4, view: { state: { actorId: t.bot, status: 'active-hand' } } });
    expect((await f.commands.readPersistedSession(t.id))?.botProvenance).toEqual([]);
    expect(JSON.stringify(live.messages)).not.toMatch(/untrusted|private cards|diagnostic|evaluationSeed|selectionSeed/);
    const reconnect = f.connect(t); try { await expect.poll(() => reconnect.messages.find(m => m.type === 'table-status')).toMatchObject({ status: { phase: 'failed', code } }); } finally { reconnect.socket.terminate(); }
  } finally { socket?.terminate(); await f.close(); }
});

test('retry installs a fresh request identity with identical inputs/seeds and discards the older result and failure', async () => {
  const f = await fixture();
  try {
    const t = await f.table(); await f.botDecision(t); await expect.poll(() => f.evaluations.length).toBe(1);
    const old = f.evaluations[0]!;
    expect((await f.configure(t, 'retry-bot')).status).toBe(200); await expect.poll(() => f.evaluations.length).toBe(2);
    const fresh = f.evaluations[1]!;
    expect(fresh.view).toEqual(old.view); expect(fresh.seed).toBe(old.seed); expect(old.signal?.aborted).toBe(true);
    fresh.result.resolve(answer({ type: 'fold' })); await expect.poll(async () => (await f.read(t)).pokerRevision).toBe(5);
    old.result.reject(new Error('untrusted late exception'));
    expect(await f.read(t)).toMatchObject({ pokerRevision: 5, sessionRevision: 5 });
    expect((await f.commands.readPersistedSession(t.id))?.botProvenance).toHaveLength(1);
  } finally { await f.close(); }
});

test('changing away and back to the same descriptor rejects old work even with the same poker decision and seeds', async () => {
  const f = await fixture();
  try {
    const t = await f.table(); await f.botDecision(t); await expect.poll(() => f.evaluations.length).toBe(1);
    const old = f.evaluations[0]!;
    expect((await f.configure(t, 'set-playing-strategy', { playingStrategy: descriptor('hold', 'seeded-sampling') })).status).toBe(200);
    expect((await f.configure(t, 'set-playing-strategy', { playingStrategy: descriptor() })).status).toBe(200);
    old.result.resolve(answer({ type: 'fold' }));
    await expect.poll(() => f.evaluations.length).toBeGreaterThanOrEqual(2);
    expect(await f.read(t)).toMatchObject({ pokerRevision: 4, sessionRevision: 6, view: { state: { actorId: t.bot } } });
    const current = f.evaluations.at(-1)!; expect(current.view).toEqual(old.view); expect(current.seed).toBe(old.seed);
    current.result.resolve(answer({ type: 'fold' })); await expect.poll(async () => (await f.read(t)).pokerRevision).toBe(5);
    const persisted = await f.commands.readPersistedSession(t.id);
    expect(persisted?.botProvenance?.[0]?.assignmentId).toBe(persisted?.bindings[1]?.assignmentId);
    expect(await f.read(t)).toMatchObject({ pokerRevision: 5, sessionRevision: 7 });
  } finally { await f.close(); }
});

test('a queued trusted poker command supersedes returning Bot work and browser requests cannot impersonate a Bot', async () => {
  const f = await fixture();
  try {
    const t = await f.table(); await f.botDecision(t); await expect.poll(() => f.evaluations.length).toBe(1);
    const denied = await f.submit(t, 'act', { requestId: randomUUID(), expectedPokerRevision: 4, participantId: t.bot, action: { type: 'fold' } }); expect(denied.status).toBe(403);
    const current = f.evaluations[0]!;
    expect(await f.commands.submitAction(t.id, { requestId: randomUUID(), expectedPokerRevision: 4, participantId: t.bot, action: { type: 'fold' } })).toMatchObject({ ok: true, pokerRevision: 5 });
    current.result.resolve(answer({ type: 'check' }));
    expect(await f.read(t)).toMatchObject({ pokerRevision: 5, sessionRevision: 5, view: { state: { status: 'completed-hand' } } });
    expect((await f.commands.readPersistedSession(t.id))?.botProvenance).toEqual([]);
  } finally { await f.close(); }
});

test('timeouts retain executing capacity until late work settles, bounded retries queue, and late results cannot act', async () => {
  const f = await fixture({ jobRunnerOptions: { concurrency: 1, maximumQueued: 1, timeoutMs: 60 } });
  let socket: WebSocket | undefined;
  try {
    const t = await f.table(); const live = f.connect(t); socket = live.socket; await f.botDecision(t);
    await expect.poll(() => live.messages.find(m => m.type === 'table-status' && m.status.code === 'timeout')).toBeDefined();
    const old = f.evaluations[0]!; expect(old.signal?.aborted).toBe(true);
    for (let attempt = 0; attempt < 3; attempt++) expect((await f.configure(t, 'retry-bot')).status).toBe(200);
    expect(f.evaluations.map(e => e.view.state.decisionId)).toEqual([old.view.state.decisionId]);
    const other = await f.table(); const secondLive = f.connect(other);
    try {
      await f.botDecision(other);
      await expect.poll(() => secondLive.messages.find(m => m.type === 'table-status' && m.status.code === 'capacity')).toBeDefined();
      expect(await f.read(other)).toMatchObject({ pokerRevision: 4 });
      f.answerNext(answer({ type: 'fold' }));
      old.result.resolve(answer({ type: 'check' })); await expect.poll(() => f.evaluations.length).toBe(2);
      const fresh = f.evaluations[1]!; expect(fresh.seed).toBe(old.seed);
      await expect.poll(async () => (await f.read(t)).pokerRevision).toBe(5);
      expect(await f.read(t)).toMatchObject({ view: { state: { status: 'completed-hand' } } });
      expect((await f.commands.readPersistedSession(t.id))?.pokerRecord.commands[4]).toEqual({ type: 'act', participantId: t.bot, action: { type: 'fold' } });
    } finally { secondLive.socket.terminate(); }
  } finally { socket?.terminate(); await f.close(); }
});

test('startup resumes only the current Bot without a browser and human decisions continue to wait', async () => {
  const f = await fixture();
  try {
    const t = await f.table();
    await f.command(t, 'seat-participant', { participantId: t.human, seat: 1 }); await f.command(t, 'seat-participant', { participantId: t.bot, seat: 2 }); await f.command(t, 'start-hand');
    expect(f.evaluations).toEqual([]);
    await f.restart(false);
    await f.command(t, 'act', { participantId: t.human, action: { type: 'call' } });
    const current = await f.read(t); expect(current).toMatchObject({ pokerRevision: 4, view: { state: { actorId: t.bot } } });
    await f.restart(); await expect.poll(() => f.evaluations.length).toBe(1);
    expect(f.evaluations[0]?.view.state.decisionId).toBe(current.view.state.decisionId);
    f.evaluations[0]!.result.resolve(answer({ type: 'fold' })); await expect.poll(async () => (await f.read(t)).pokerRevision).toBe(5);
  } finally { await f.close(); }
});

test('Bot provenance and play stay invisible while real PostgreSQL commit is held, then promote atomically', async () => {
  const entered = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
  const f = await fixture({ mutationTransactionFaults: { beforeCommit: async context => { if (context.requestId.startsWith('bot:')) { entered.resolve(); await release.promise; } } } });
  let socket: WebSocket | undefined;
  try {
    const t = await f.table(); const live = f.connect(t); socket = live.socket; await f.botDecision(t); await expect.poll(() => f.evaluations.length).toBe(1);
    f.evaluations[0]!.result.resolve(answer({ type: 'fold' })); await entered.promise;
    expect(await f.read(t)).toMatchObject({ pokerRevision: 4, sessionRevision: 4, view: { state: { actorId: t.bot } } });
    expect(await f.commands.readPersistedSession(t.id)).toMatchObject({ pokerRevision: 4, sessionRevision: 4, botProvenance: [] });
    expect(live.messages.filter(m => m.type === 'table-update').map(m => m.pokerRevision)).not.toContain(5);
    release.resolve(); await expect.poll(async () => (await f.read(t)).pokerRevision).toBe(5);
    expect(await f.commands.readPersistedSession(t.id)).toMatchObject({ pokerRevision: 5, sessionRevision: 5, botProvenance: [expect.objectContaining({ commandIndex: 4 })] });
  } finally { release.resolve(); socket?.terminate(); await f.close(); }
});

// A shared real database administration connection is never used to read application facts.
import { afterAll } from 'vitest';
afterAll(async () => { await administration.end(); });

test('closing the server cancels pending work and a late successful computation cannot submit to the old lifecycle', async () => {
  const f = await fixture();
  try {
    const t = await f.table(); await f.botDecision(t); await expect.poll(() => f.evaluations.length).toBe(1);
    const pending = f.evaluations[0]!; const closing = f.stop();
    await expect.poll(() => pending.signal?.aborted).toBe(true);
    pending.result.resolve(answer({ type: 'fold' })); await closing;
    await f.restart(false);
    expect(await f.commands.readPersistedSession(t.id)).toMatchObject({ pokerRevision: 4, sessionRevision: 4, botProvenance: [] });
    expect(await f.read(t)).toMatchObject({ view: { state: { actorId: t.bot, status: 'active-hand' } } });
  } finally { await f.close(); }
});

test('owner-only controller changes retain definitive request outcomes and exact configured identity while current work runs', async () => {
  const f = await fixture();
  try {
    const t = await f.table(); const stranger = await f.table(); await f.botDecision(t); await expect.poll(() => f.evaluations.length).toBe(1);
    const request = { requestId: 'owner-assignment', expectedSessionRevision: 4, participantId: t.bot, playingStrategy: descriptor('throw') };
    expect((await f.submit(t, 'set-playing-strategy', request, stranger.cookie)).status).toBe(404);
    expect((await f.submit(t, 'set-playing-strategy', request, '')).status).toBe(401);
    expect((await f.submit(t, 'set-playing-strategy', request)).status).toBe(200);
    expect(await f.read(t)).toMatchObject({ pokerRevision: 4, sessionRevision: 5 });
    expect((await f.submit(t, 'set-playing-strategy', request)).status).toBe(200);
    expect((await f.submit(t, 'set-playing-strategy', { ...request, playingStrategy: descriptor() })).status).toBe(409);
    expect((await f.submit(t, 'set-playing-strategy', { ...request, requestId: 'stale-assignment' })).status).toBe(409);
    f.evaluations[0]!.result.resolve(answer({ type: 'fold' }));
    expect(await f.read(t)).toMatchObject({ pokerRevision: 4, sessionRevision: 5, view: { state: { actorId: t.bot } } });
    expect((await f.commands.readPersistedSession(t.id))?.botProvenance).toEqual([]);
  } finally { await f.close(); }
});

test('a held Bot never blocks another table’s legal human decision, and reads/subscriptions cannot implicitly retry', async () => {
  const f = await fixture(); let socket: WebSocket | undefined;
  try {
    const t = await f.table(); await f.botDecision(t); await expect.poll(() => f.evaluations.length).toBe(1);
    for (let index = 0; index < 3; index++) await f.read(t);
    const live = f.connect(t); socket = live.socket; await expect.poll(() => live.messages.find(m => m.type === 'table-status')).toMatchObject({ status: { phase: 'thinking' } });
    const other = await f.table(); await f.command(other, 'seat-participant', { participantId: other.human, seat: 1 }); await f.command(other, 'seat-participant', { participantId: other.bot, seat: 2 }); await f.command(other, 'start-hand');
    await f.command(other, 'act', { participantId: other.human, action: { type: 'fold' } });
    expect(await f.read(other)).toMatchObject({ pokerRevision: 4, view: { state: { status: 'completed-hand' } } });
    expect(f.evaluations.map(e => e.view.state.decisionId)).toEqual(['hand-1/decision-2']);
    expect(await f.read(t)).toMatchObject({ pokerRevision: 4, view: { state: { actorId: t.bot } } });
  } finally { socket?.terminate(); await f.close(); }
});

test('recovery takes precedence over a cancelled computation’s late error and resumes its committed assignment after restart', async () => {
  const f = await fixture({ mutationTransactionFaults: { afterCommit: async context => { if (context.requestId === 'lost-assignment') throw new Error('controlled lost controller COMMIT confirmation'); } } });
  let socket: WebSocket | undefined;
  try {
    const t = await f.table(); const live = f.connect(t); socket = live.socket; await f.botDecision(t); await expect.poll(() => f.evaluations.length).toBe(1);
    const old = f.evaluations[0]!;
    expect((await f.configure(t, 'set-playing-strategy', { playingStrategy: descriptor('throw') }, 'lost-assignment')).status).toBe(503);
    old.result.reject(new Error('untrusted late failure in recovery'));
    await expect.poll(() => live.messages.at(-1)).toMatchObject({ type: 'table-status', status: { phase: 'recovering' } });
    expect(await f.read(t)).toMatchObject({ pokerRevision: 4, sessionRevision: 4 });
    expect((await f.configure(t, 'retry-bot')).status).toBe(503);
    socket.terminate(); socket = undefined; await f.restart(false);
    expect(await f.read(t)).toMatchObject({ pokerRevision: 4, sessionRevision: 5, bindings: [expect.anything(), expect.objectContaining({ controller: { kind: 'bot', playingStrategy: descriptor('throw') } })] });
    expect((await f.commands.readPersistedSession(t.id))?.botProvenance).toEqual([]);
  } finally { socket?.terminate(); await f.close(); }
});

test('confirmed Bot-action rollback exposes a safe persistence failure and retry retains the decision and seeds', async () => {
  let failOnce = true;
  let failedEvaluationId: string | undefined;
  const f = await fixture({ mutationTransactionFaults: { beforeCommit: async context => {
    if (context.requestId.startsWith('bot:') && failOnce) { failOnce = false; failedEvaluationId = context.requestId.slice(4); throw new Error('untrusted PostgreSQL/private input failure'); }
  } } });
  let socket: WebSocket | undefined;
  try {
    const t = await f.table(); const live = f.connect(t); socket = live.socket; await f.botDecision(t);
    await expect.poll(() => f.evaluations.length).toBe(1);
    const failed = f.evaluations[0]!; failed.result.resolve(answer({ type: 'fold' }));
    await expect.poll(() => live.messages.at(-1)).toMatchObject({ type: 'table-status', status: {
      phase: 'failed', participantId: t.bot, code: 'persistence-unavailable',
      message: 'The Bot action could not be saved. Retry this decision.',
    } });
    expect(await f.commands.readPersistedSession(t.id)).toMatchObject({ pokerRevision: 4, sessionRevision: 4, botProvenance: [] });
    expect(JSON.stringify(live.messages)).not.toMatch(/untrusted|PostgreSQL|private input|evaluationSeed|selectionSeed/);
    expect((await f.configure(t, 'retry-bot')).status).toBe(200);
    await expect.poll(() => f.evaluations.length).toBe(2);
    const retried = f.evaluations[1]!; expect(retried.view).toEqual(failed.view); expect(retried.seed).toBe(failed.seed);
    retried.result.resolve(answer({ type: 'fold' })); await expect.poll(async () => (await f.read(t)).pokerRevision).toBe(5);
    expect((await f.commands.readPersistedSession(t.id))?.botProvenance).toHaveLength(1);
    expect((await f.commands.readPersistedSession(t.id))?.botProvenance?.[0]?.evaluationRequestId).not.toBe(failedEvaluationId);
  } finally { socket?.terminate(); await f.close(); }
});

test('matching Retry outcomes survive later assignments and restart without scheduling another evaluation, and stale rejections remain definitive', async () => {
  const f = await fixture();
  try {
    const t = await f.table(); await f.botDecision(t); await expect.poll(() => f.evaluations.length).toBe(1);
    const retry = { requestId: 'durable-retry', expectedSessionRevision: 4, participantId: t.bot };
    const accepted = await (await f.submit(t, 'retry-bot', retry)).json();
    expect(accepted).toMatchObject({ ok: true, pokerRevision: 4, sessionRevision: 4 });
    await expect.poll(() => f.evaluations.length).toBe(2);
    const stale = { ...retry, requestId: 'durable-stale-retry', expectedSessionRevision: 3 };
    const rejected = await (await f.submit(t, 'retry-bot', stale)).json();
    expect(rejected).toMatchObject({ ok: false, rejection: { code: 'stale-session-revision' } });
    expect((await f.configure(t, 'set-playing-strategy', { playingStrategy: descriptor('incompatible') })).status).toBe(200);
    expect(await f.read(t)).toMatchObject({ pokerRevision: 4, sessionRevision: 5 });
    await f.restart();
    expect(await (await f.submit(t, 'retry-bot', retry)).json()).toEqual(accepted);
    expect(await (await f.submit(t, 'retry-bot', stale)).json()).toEqual(rejected);
    expect((await f.submit(t, 'retry-bot', { ...retry, expectedSessionRevision: 5 })).status).toBe(409);
    expect(f.evaluations).toEqual([]);
    expect(await f.read(t)).toMatchObject({ pokerRevision: 4, sessionRevision: 5, view: { state: { actorId: t.bot } } });
    expect((await f.commands.readPersistedSession(t.id))?.botProvenance).toEqual([]);
  } finally { await f.close(); }
});

test('repeated fresh retries preserve declared inputs while obsolete errors and actions cannot replace the latest thinking state or accepted action', async () => {
  const f = await fixture({ jobRunnerOptions: { concurrency: 3, maximumQueued: 1, timeoutMs: 2000 } });
  let socket: WebSocket | undefined;
  try {
    const t = await f.table(); const live = f.connect(t); socket = live.socket; await f.botDecision(t);
    await expect.poll(() => f.evaluations.length).toBe(1); const first = f.evaluations[0]!;
    expect((await f.configure(t, 'retry-bot')).status).toBe(200); await expect.poll(() => f.evaluations.length).toBe(2);
    expect((await f.configure(t, 'retry-bot')).status).toBe(200); await expect.poll(() => f.evaluations.length).toBe(3);
    const second = f.evaluations[1]!; const latest = f.evaluations[2]!;
    expect(latest.view).toEqual(first.view); expect(latest.descriptor).toEqual(first.descriptor); expect(latest.seed).toBe(first.seed);
    expect(second.signal?.aborted).toBe(true); expect(first.signal?.aborted).toBe(true);
    first.result.reject(new Error('obsolete private failure')); second.result.resolve(answer({ type: 'check' }));
    // The HTTP round trip and current-request snapshot observe the committed decision while old work settles.
    expect(await f.read(t)).toMatchObject({ pokerRevision: 4, sessionRevision: 4, view: { state: { actorId: t.bot } } });
    await expect.poll(() => live.messages.at(-1)).toMatchObject({ type: 'table-status', status: { phase: 'thinking', participantId: t.bot } });
    latest.result.resolve(answer({ type: 'fold' })); await expect.poll(async () => (await f.read(t)).pokerRevision).toBe(5);
    await expect.poll(() => live.messages.at(-1)).toMatchObject({ type: 'table-status', status: { phase: 'idle' } });
    expect((await f.commands.readPersistedSession(t.id))?.pokerRecord.commands[4]).toEqual({ type: 'act', participantId: t.bot, action: { type: 'fold' } });
    expect((await f.commands.readPersistedSession(t.id))?.botProvenance).toHaveLength(1);
    expect(JSON.stringify(live.messages)).not.toContain('obsolete private failure');
  } finally { socket?.terminate(); await f.close(); }
});

test('a controller change queued ahead of a returning action promotes only after COMMIT and accepts the new configuration at the same decision', async () => {
  const entered = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
  const f = await fixture({ mutationTransactionFaults: { beforeCommit: async context => {
    if (context.requestId === 'held-configuration') { entered.resolve(); await release.promise; }
  } } });
  let socket: WebSocket | undefined;
  let changing: Promise<Response> | undefined;
  try {
    const t = await f.table(); const live = f.connect(t); socket = live.socket; await f.botDecision(t);
    await expect.poll(() => f.evaluations.length).toBe(1); const obsolete = f.evaluations[0]!;
    const replacement = { ...descriptor(), policy: { ...descriptor().policy, configuration: { mode: 'hold', experiment: 2 } } };
    changing = f.configure(t, 'set-playing-strategy', { playingStrategy: replacement }, 'held-configuration');
    await entered.promise; obsolete.result.resolve(answer({ type: 'check' }));
    expect(await f.read(t)).toMatchObject({ pokerRevision: 4, sessionRevision: 4, bindings: [expect.anything(), expect.objectContaining({ controller: { kind: 'bot', playingStrategy: descriptor() } })] });
    expect(await f.commands.readPersistedSession(t.id)).toMatchObject({ pokerRevision: 4, sessionRevision: 4, botProvenance: [] });
    expect(live.messages.filter(m => m.type === 'table-update').map(m => m.sessionRevision)).not.toContain(5);
    release.resolve(); expect((await changing).status).toBe(200);
    await expect.poll(() => f.evaluations.length).toBe(2); const fresh = f.evaluations[1]!;
    expect(fresh.descriptor).toEqual(replacement); expect(fresh.view).toEqual(obsolete.view); expect(fresh.seed).toBe(obsolete.seed);
    await expect.poll(() => live.messages.find(m => m.type === 'table-update' && m.sessionRevision === 5)).toMatchObject({ pokerRevision: 4, bindings: [expect.anything(), expect.objectContaining({ controller: { kind: 'bot', playingStrategy: replacement } })], view: { state: { actorId: t.bot, decisionId: obsolete.view.state.decisionId } } });
    expect(live.messages.at(-1)).toMatchObject({ type: 'table-status', status: { phase: 'thinking', participantId: t.bot } });
    fresh.result.resolve(answer({ type: 'fold' })); await expect.poll(async () => (await f.read(t)).pokerRevision).toBe(5);
    expect(await f.commands.readPersistedSession(t.id)).toMatchObject({ pokerRevision: 5, sessionRevision: 6, botProvenance: [expect.objectContaining({ playingStrategy: replacement, decisionId: obsolete.view.state.decisionId, evaluationSeed: obsolete.seed })] });
    expect((await f.commands.readPersistedSession(t.id))?.pokerRecord.commands[4]).toEqual({ type: 'act', participantId: t.bot, action: { type: 'fold' } });
  } finally { release.resolve(); await changing?.catch(() => {}); socket?.terminate(); await f.close(); }
});
