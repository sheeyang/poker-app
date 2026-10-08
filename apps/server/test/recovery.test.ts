import { expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Client, Pool } from 'pg';
import { createServer, type ServerOptions } from '../src/server.js';
import { baselinePlayingStrategy, highestProbabilityPlayingStrategy } from '@poker/contracts';
import type { TableSessionControllerCommands } from '../src/mutations.js';
import { HighestProbabilitySelector, type PolicyResult } from '@poker/strategies';

const databaseUrl = process.env.TEST_DATABASE_URL!;
async function fixture(options: Partial<ServerOptions> = {}) {
  const schema = 'test_' + randomUUID().replaceAll('-', '');
  const administration = new Pool({ connectionString: databaseUrl });
  await administration.query('CREATE SCHEMA "' + schema + '"');
  let heldId: string | undefined;
  let terminal: ReturnType<typeof Promise.withResolvers<'COMMIT' | 'ROLLBACK'>> | undefined;
  const targets = new Set<Promise<void>>();
  let commands: TableSessionControllerCommands;
  let server: Awaited<ReturnType<typeof createServer>>;
  let base = '';
  const faults = {
    async openClient(context: { requestId: string }) {
      if (heldId === 'bot:*' && context.requestId.startsWith('bot:')) heldId = context.requestId;
      if (context.requestId !== heldId) return undefined;
      const client = new Client({ connectionString: databaseUrl, options: '-c search_path=' + schema });
      await client.connect();
      return { client, release: () => {} }; // The fixture owns this detached terminal client.
    },
    async terminalCommit(client: Client, context: { requestId: string }) {
      if (context.requestId !== heldId) { await client.query('COMMIT'); return; }
      terminal = Promise.withResolvers<'COMMIT' | 'ROLLBACK'>();
      const target = terminal.promise.then(async sql => { try { await client.query(sql); } finally { await client.end(); } });
      targets.add(target); void target.finally(() => targets.delete(target));
      throw new Error('COMMIT confirmation unavailable; real PostgreSQL target is still in progress');
    },
  };
  async function start() {
    server = await createServer({ databaseUrl, schema, automaticBots: false, transactionFaults: faults, mutationTransactionFaults: faults, ...options, onControllerCommandsReady: ready => { commands = ready; } } as ServerOptions);
    base = await server.listen({ host: '127.0.0.1', port: 0 });
  }
  await start();
  const identity = await fetch(base + '/api/identity'); const cookie = identity.headers.get('set-cookie')!.split(';')[0]!;
  async function post(path: string, body: object, auth = cookie) {
    return fetch(base + '/api' + path, { method: 'POST', headers: { cookie: auth, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  }
  async function table() {
    const response = await post('/table-sessions', { requestId: randomUUID(), bots: [{ name: 'Bot', playingStrategy: baselinePlayingStrategy }] });
    expect(response.status).toBe(201); return response.json();
  }
  const read = async (id: string) => (await fetch(base + '/api/table-sessions/' + id, { headers: { cookie } })).json();
  const list = async () => (await (await fetch(base + '/api/table-sessions', { headers: { cookie } })).json()).tableSessionIds;
  return { schema, table, read, post, list, get commands() { return commands!; }, hold(id: string) { heldId = id; }, async resolve(sql: 'COMMIT' | 'ROLLBACK') { terminal!.resolve(sql); await Promise.all([...targets]); heldId = undefined; }, async restart() { await server.close(); await start(); }, async close() { terminal?.resolve('ROLLBACK'); await Promise.allSettled([...targets]); await server.close(); await administration.query('DROP SCHEMA "' + schema + '" CASCADE'); await administration.end(); } };
}

test('a missing outcome during an unresolved real transaction pauses only its table, then restores eventual commit without duplicate seating', async () => {
  const f = await fixture();
  try {
    const t = await f.table(); const other = await f.table();
    const body = { requestId: 'unknown-seat', expectedPokerRevision: 0, participantId: t.bindings[0].participantId, seat: 1 };
    f.hold(body.requestId);
    const response = await f.post('/table-sessions/' + t.tableSessionId + '/seat-participant', body);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ rejection: { code: 'commit-outcome-unknown' } });
    expect(await f.read(t.tableSessionId)).toMatchObject({ pokerRevision: 0, sessionRevision: 0, runtimeStatus: { phase: 'recovering' }, view: { state: { participants: [] } } });
    expect(await f.commands.readPersistedSession(t.tableSessionId)).toMatchObject({ pokerRevision: 0, pokerRecord: { commands: [] } });
    expect(await (await f.post('/table-sessions/' + t.tableSessionId + '/seat-participant', body)).json()).toMatchObject({ rejection: { code: 'commit-outcome-unknown' } });
    expect((await f.post('/table-sessions/' + other.tableSessionId + '/seat-participant', { ...body, requestId: 'independent', participantId: other.bindings[0].participantId })).status).toBe(200);
    await f.resolve('COMMIT');
    const resolved = await f.post('/table-sessions/' + t.tableSessionId + '/seat-participant', body);
    expect(await resolved.json()).toEqual({ ok: true, tableSessionId: t.tableSessionId, pokerRevision: 1, sessionRevision: 1 });
    expect(await f.read(t.tableSessionId)).toMatchObject({ pokerRevision: 1, sessionRevision: 1, view: { state: { participants: [{ seat: 1, stack: 1000 }] } } });
    expect((await f.commands.readPersistedSession(t.tableSessionId))?.pokerRecord.commands).toHaveLength(1);
  } finally { await f.close(); }
});

test('client cleanup failure after a positively confirmed real COMMIT still returns the stored definitive acknowledgement', async () => {
  let namespace = ''; const closed = Promise.withResolvers<void>();
  const f = await fixture({ mutationTransactionFaults: { openClient: async context => {
    if (context.requestId !== 'cleanup-failure') return;
    const client = new Client({ connectionString: databaseUrl, options: '-c search_path=' + namespace });
    await client.connect(); return { client, release() { void client.end().then(closed.resolve); throw new Error('Controlled client cleanup error after actual terminal SQL.'); } };
  } } });
  namespace = f.schema;
  try {
    const t = await f.table();
    const response = await f.post('/table-sessions/' + t.tableSessionId + '/seat-participant', { requestId: 'cleanup-failure', expectedPokerRevision: 0, participantId: t.bindings[0].participantId, seat: 1 });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, tableSessionId: t.tableSessionId, pokerRevision: 1, sessionRevision: 1 });
    expect(await f.read(t.tableSessionId)).toMatchObject({ pokerRevision: 1, sessionRevision: 1, view: { state: { participants: [{ seat: 1 }] } } });
  } finally { await closed.promise; await f.close(); }
});

test('an ambiguously aborted Bot action pauses play and uses fresh evaluation identity for its eventual single accepted action', async () => {
  const evaluations: ReturnType<typeof Promise.withResolvers<PolicyResult>>[] = [];
  const f = await fixture({ automaticBots: true, strategyFactory: () => ({ policy: {
    checkCompatibility: () => ({ compatible: true }), evaluate: () => { const result = Promise.withResolvers<PolicyResult>(); evaluations.push(result); return result.promise; },
  }, actionSelector: new HighestProbabilitySelector() }) });
  try {
    const t = await f.table(); const id = t.tableSessionId;
    async function poker(kind: string, revision: number, contents: object = {}) { expect((await f.post('/table-sessions/' + id + '/' + kind, { requestId: randomUUID(), expectedPokerRevision: revision, ...contents })).status).toBe(200); }
    await poker('seat-participant', 0, { participantId: t.bindings[0].participantId, seat: 1 });
    await poker('seat-participant', 1, { participantId: t.bindings[1].participantId, seat: 2 });
    await poker('start-hand', 2); await poker('act', 3, { participantId: t.bindings[0].participantId, action: { type: 'call' } });
    await expect.poll(() => evaluations.length).toBe(1);
    f.hold('bot:*'); evaluations[0]!.resolve({ choices: [{ action: { type: 'fold' }, probability: 1 }] });
    await expect.poll(async () => (await f.read(id)).runtimeStatus.phase).toBe('recovering');
    expect(await f.commands.readPersistedSession(id)).toMatchObject({ pokerRevision: 4, sessionRevision: 4, botProvenance: [] });
    await f.resolve('ROLLBACK');
    await expect.poll(() => evaluations.length).toBe(2);
    expect(await f.commands.readPersistedSession(id)).toMatchObject({ pokerRevision: 4, botProvenance: [] });
    evaluations[1]!.resolve({ choices: [{ action: { type: 'fold' }, probability: 1 }] });
    await expect.poll(async () => (await f.read(id)).pokerRevision).toBe(5);
    expect((await f.commands.readPersistedSession(id))?.botProvenance).toHaveLength(1);
    expect((await f.commands.readPersistedSession(id))?.pokerRecord.commands).toHaveLength(5);
  } finally { for (const result of evaluations) result.resolve({ choices: [{ action: { type: 'fold' }, probability: 1 }] }); await f.close(); }
});

test('stored rejection-only and retry acknowledgements resolve without poker commands or revision changes', async () => {
  const f = await fixture();
  try {
    const t = await f.table(); const id = t.tableSessionId;
    const path = '/table-sessions/' + id + '/seat-participant';
    expect((await f.post(path, { requestId: 'seat', expectedPokerRevision: 0, participantId: t.bindings[0].participantId, seat: 1 })).status).toBe(200);
    const rejection = { requestId: 'unknown-rejection', expectedPokerRevision: 1, participantId: t.bindings[1].participantId, seat: 1 };
    f.hold(rejection.requestId); expect((await f.post(path, rejection)).status).toBe(503);
    await f.restart(); await f.resolve('COMMIT');
    const stored = await (await f.post(path, rejection)).json();
    expect(stored).toMatchObject({ rejection: { code: 'seat-occupied' } });
    expect((await f.post(path, { ...rejection, requestId: 'seat-bot', seat: 2 })).status).toBe(200);
    await f.restart();
    expect(await (await f.post(path, rejection)).json()).toEqual(stored);
    expect(await (await f.post(path, { ...rejection, seat: 3 })).json()).toMatchObject({ rejection: { code: 'request-id-conflict' } });
    expect((await f.post('/table-sessions/' + id + '/start-hand', { requestId: 'start', expectedPokerRevision: 2 })).status).toBe(200);
    expect((await f.post('/table-sessions/' + id + '/act', { requestId: 'call', expectedPokerRevision: 3, participantId: t.bindings[0].participantId, action: { type: 'call' } })).status).toBe(200);
    const retry = { requestId: 'unknown-retry', expectedSessionRevision: 4, participantId: t.bindings[1].participantId };
    const retryPath = '/table-sessions/' + id + '/retry-bot';
    f.hold(retry.requestId); expect((await f.post(retryPath, retry)).status).toBe(503);
    await f.resolve('COMMIT');
    expect(await (await f.post(retryPath, retry)).json()).toEqual({ ok: true, tableSessionId: id, pokerRevision: 4, sessionRevision: 4 });
    expect(await f.commands.readPersistedSession(id)).toMatchObject({ pokerRevision: 4, sessionRevision: 4 });
    expect((await f.commands.readPersistedSession(id))?.pokerRecord.commands).toHaveLength(4);
  } finally { await f.close(); }
});

test('recovery rejects late pre-recovery Bot results and freshly evaluates the unchanged decision after confirmed abort', async () => {
  const evaluations: ReturnType<typeof Promise.withResolvers<PolicyResult>>[] = [];
  const f = await fixture({ automaticBots: true, strategyFactory: () => ({ policy: {
    checkCompatibility: () => ({ compatible: true }),
    evaluate: () => { const result = Promise.withResolvers<PolicyResult>(); evaluations.push(result); return result.promise; },
  }, actionSelector: new HighestProbabilitySelector() }) });
  try {
    const t = await f.table(); const id = t.tableSessionId;
    async function poker(kind: string, revision: number, contents: object = {}) { expect((await f.post('/table-sessions/' + id + '/' + kind, { requestId: randomUUID(), expectedPokerRevision: revision, ...contents })).status).toBe(200); }
    await poker('seat-participant', 0, { participantId: t.bindings[0].participantId, seat: 1 });
    await poker('seat-participant', 1, { participantId: t.bindings[1].participantId, seat: 2 });
    await poker('start-hand', 2); await poker('act', 3, { participantId: t.bindings[0].participantId, action: { type: 'call' } });
    await expect.poll(() => evaluations.length).toBe(1);
    const body = { requestId: 'unknown-while-thinking', expectedSessionRevision: 4, participantId: t.bindings[1].participantId, playingStrategy: highestProbabilityPlayingStrategy };
    f.hold(body.requestId);
    expect((await f.post('/table-sessions/' + id + '/set-playing-strategy', body)).status).toBe(503);
    evaluations[0]!.resolve({ choices: [{ action: { type: 'fold' }, probability: 1 }] });
    expect(await f.read(id)).toMatchObject({ pokerRevision: 4, sessionRevision: 4, runtimeStatus: { phase: 'recovering' } });
    expect(evaluations).toHaveLength(1);
    await f.resolve('ROLLBACK');
    expect(await (await f.post('/table-sessions/' + id + '/set-playing-strategy', body)).json()).toMatchObject({ rejection: { code: 'commit-not-applied' } });
    await expect.poll(() => evaluations.length).toBe(2);
    expect(await f.commands.readPersistedSession(id)).toMatchObject({ pokerRevision: 4, sessionRevision: 4, botProvenance: [] });
    evaluations[1]!.resolve({ choices: [{ action: { type: 'fold' }, probability: 1 }] });
    await expect.poll(async () => (await f.read(id)).pokerRevision).toBe(5);
    expect((await f.commands.readPersistedSession(id))?.botProvenance).toHaveLength(1);
  } finally { for (const result of evaluations) result.resolve({ choices: [{ action: { type: 'fold' }, probability: 1 }] }); await f.close(); }
});

test('creation recovery before a Table Session ID survives restart, commits one seed/session/binding set, and returns its original acknowledgement', async () => {
  const f = await fixture();
  try {
    const body = { requestId: 'unknown-creation', bots: [{ name: 'Bot', playingStrategy: baselinePlayingStrategy }] };
    f.hold(body.requestId);
    expect((await f.post('/table-sessions', body)).status).toBe(503);
    expect(await f.list()).toEqual([]);
    expect((await f.post('/table-sessions', body)).status).toBe(503);
    expect((await f.post('/table-sessions', { requestId: 'different-creation' })).status).toBe(503);
    expect((await f.post('/table-sessions', { requestId: 'independent-owner' }, '')).status).toBe(201);
    expect(await (await f.post('/table-sessions', { ...body, bots: [] })).json()).toMatchObject({ rejection: { code: 'request-id-conflict' } });
    await f.restart();
    expect((await f.post('/table-sessions', body)).status).toBe(503);
    await f.resolve('COMMIT');
    const acknowledged = await (await f.post('/table-sessions', body)).json();
    expect(acknowledged).toMatchObject({ ok: true, bindings: [{ name: 'You' }, { name: 'Bot' }] });
    const original = await f.commands.readPersistedSession(acknowledged.tableSessionId);
    expect(await f.list()).toEqual([acknowledged.tableSessionId]);
    await f.restart();
    expect(await (await f.post('/table-sessions', body)).json()).toEqual(acknowledged);
    expect(await f.commands.readPersistedSession(acknowledged.tableSessionId)).toEqual(original);
    expect(await f.list()).toEqual([acknowledged.tableSessionId]);
  } finally { await f.close(); }
});

test('shutdown invalidates a held pre-COMMIT callback before draining HTTP and preserves known same-ID retry', async () => {
  const entered = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
  const f = await fixture({ mutationTransactionFaults: { beforeCommit: async context => { if (context.requestId === 'closing') { entered.resolve(); await release.promise; } } } });
  try {
    const t = await f.table(); const path = '/table-sessions/' + t.tableSessionId + '/seat-participant';
    const body = { requestId: 'closing', expectedPokerRevision: 0, participantId: t.bindings[0].participantId, seat: 1 };
    const request = f.post(path, body); await entered.promise;
    const restarting = f.restart();
    const response = await request; expect(response.status).toBe(503); await response.json();
    await restarting;
    release.resolve();
    expect(await f.commands.readPersistedSession(t.tableSessionId)).toMatchObject({ pokerRevision: 0, pokerRecord: { commands: [] } });
    expect((await f.post(path, body)).status).toBe(200);
  } finally { release.resolve(); await f.close(); }
});

test('independent target transactions cannot consume the separate journal pool and deadlock COMMIT dispatch', async () => {
  const release = Promise.withResolvers<void>(); const entered = Promise.withResolvers<void>(); let waiting = 0;
  const f = await fixture({ mutationTransactionFaults: { beforeCommit: async context => { if (context.requestId === 'capacity') { if (++waiting === 10) entered.resolve(); await release.promise; } } } });
  try {
    const tables = []; for (let i = 0; i < 10; i++) tables.push(await f.table());
    const requests = tables.map(t => f.post('/table-sessions/' + t.tableSessionId + '/seat-participant', { requestId: 'capacity', expectedPokerRevision: 0, participantId: t.bindings[0].participantId, seat: 1 }));
    await entered.promise; release.resolve();
    expect((await Promise.all(requests)).map(response => response.status)).toEqual(Array(10).fill(200));
  } finally { release.resolve(); await f.close(); }
});

test('controller recovery synchronizes assignments and sessionRevision only, retaining the original outcome while current state advances', async () => {
  const f = await fixture();
  try {
    const t = await f.table(); const id = t.tableSessionId;
    const path = '/table-sessions/' + id + '/set-playing-strategy';
    const body = { requestId: 'unknown-assignment', expectedSessionRevision: 0, participantId: t.bindings[1].participantId, playingStrategy: highestProbabilityPlayingStrategy };
    f.hold(body.requestId);
    expect((await f.post(path, body)).status).toBe(503);
    expect(await f.read(id)).toMatchObject({ pokerRevision: 0, sessionRevision: 0, bindings: [{}, { controller: { playingStrategy: baselinePlayingStrategy } }] });
    await f.resolve('COMMIT');
    const original = { ok: true, tableSessionId: id, pokerRevision: 0, sessionRevision: 1 };
    expect(await (await f.post(path, body)).json()).toEqual(original);
    expect(await f.read(id)).toMatchObject({ pokerRevision: 0, sessionRevision: 1, bindings: [{}, { controller: { playingStrategy: highestProbabilityPlayingStrategy } }] });
    expect((await f.commands.readPersistedSession(id))?.pokerRecord.commands).toEqual([]);
    expect((await f.post('/table-sessions/' + id + '/seat-participant', { requestId: 'advance', expectedPokerRevision: 0, participantId: t.bindings[0].participantId, seat: 1 })).status).toBe(200);
    await f.restart();
    expect(await (await f.post(path, body)).json()).toEqual(original);
    expect(await f.read(id)).toMatchObject({ pokerRevision: 1, sessionRevision: 2 });
  } finally { await f.close(); }
});

test('an aborted rejection-only creation releases its owner for a new request while retaining old-attempt noncommit', async () => {
  const f = await fixture();
  try {
    const body = { requestId: 'unknown-invalid-creation', configuration: { seatCount: 1 } };
    f.hold(body.requestId);
    expect((await f.post('/table-sessions', body)).status).toBe(503);
    await f.restart(); await f.resolve('ROLLBACK');
    const fresh = await f.post('/table-sessions', { requestId: 'new-valid-creation' });
    expect(fresh.status).toBe(201);
    expect(await (await f.post('/table-sessions', body)).json()).toMatchObject({ rejection: { code: 'commit-not-applied' } });
    expect(await f.list()).toHaveLength(1);
  } finally { await f.close(); }
});

test('an ambiguously aborted attempt survives restart as confirmed noncommit and requires a deliberate new requestId', async () => {
  const f = await fixture();
  try {
    const t = await f.table();
    const path = '/table-sessions/' + t.tableSessionId + '/seat-participant';
    const body = { requestId: 'aborted-seat', expectedPokerRevision: 0, participantId: t.bindings[0].participantId, seat: 1 };
    f.hold(body.requestId);
    expect((await f.post(path, body)).status).toBe(503);
    await f.restart();
    expect(await f.read(t.tableSessionId)).toMatchObject({ pokerRevision: 0, runtimeStatus: { phase: 'recovering' }, view: { state: { participants: [] } } });
    expect(await (await f.post(path, { ...body, seat: 2 })).json()).toMatchObject({ rejection: { code: 'request-id-conflict' } });
    await f.resolve('ROLLBACK');
    const aborted = await f.post(path, body);
    expect(aborted.status).toBe(503);
    expect(await aborted.json()).toMatchObject({ rejection: { code: 'commit-not-applied' } });
    await f.restart();
    expect(await (await f.post(path, body)).json()).toMatchObject({ rejection: { code: 'commit-not-applied' } });
    expect(await f.commands.readPersistedSession(t.tableSessionId)).toMatchObject({ pokerRevision: 0, sessionRevision: 0, pokerRecord: { commands: [] } });
    expect((await f.post(path, { ...body, requestId: 'deliberate-new-attempt' })).status).toBe(200);
  } finally { await f.close(); }
});
