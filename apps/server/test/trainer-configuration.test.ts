import { afterAll, beforeAll, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import WebSocket from 'ws';
import { baselinePlayingStrategy, defaultPlayingStrategy, highestProbabilityPlayingStrategy, type ObservableTableUpdate, type ServerLiveMessage } from '@poker/contracts';
import { createServer } from '../src/server.js';

const databaseUrl = process.env.TEST_DATABASE_URL!;
const schema = 'test_' + randomUUID().replaceAll('-', '');
const administration = new Pool({ connectionString: databaseUrl });
let server: Awaited<ReturnType<typeof createServer>>;
let base: string;
let beforeCommit: (context: { tableSessionId: string; requestId: string }) => Promise<void> = async () => {};
let afterCommit: () => Promise<void> = async () => {};
async function start() {
  server = await createServer({ automaticBots: false, databaseUrl, schema, mutationTransactionFaults: { beforeCommit: context => beforeCommit(context), afterCommit: () => afterCommit() } });
  base = await server.listen({ host: '127.0.0.1', port: 0 });
}
beforeAll(async () => {
  await administration.query('CREATE SCHEMA "' + schema + '"');
  await start();
});
afterAll(async () => { await server?.close(); await administration.query('DROP SCHEMA "' + schema + '" CASCADE'); await administration.end(); });
async function table(playingStrategy = baselinePlayingStrategy) {
  const identity = await fetch(base + '/api/identity');
  const cookie = identity.headers.get('set-cookie')!.split(';')[0]!;
  const creation = await fetch(base + '/api/table-sessions', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ requestId: randomUUID(), bots: [{ name: 'Bot', playingStrategy }] }) });
  expect(creation.status).toBe(201);
  const result = await creation.json();
  return { id: result.tableSessionId as string, cookie, bot: result.bindings[1].participantId as string };
}
type Table = Awaited<ReturnType<typeof table>>;
const read = async (t: Table) => (await fetch(base + '/api/table-sessions/' + t.id, { headers: { cookie: t.cookie } })).json();
const configure = (t: Table, body: object) => fetch(base + '/api/table-sessions/' + t.id + '/set-trainer-configuration', { method: 'POST', headers: { cookie: t.cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) });
const chosenConfiguration = { referenceStrategy: highestProbabilityPlayingStrategy, liveAnalysis: true };
const change = (expectedSessionRevision = 0, requestId: string = randomUUID()) => ({ requestId, expectedSessionRevision, trainerConfiguration: chosenConfiguration });
function connect(t: Table) {
  const socket = new WebSocket(base.replace('http:', 'ws:') + '/api/live', { headers: { cookie: t.cookie } });
  const messages: ObservableTableUpdate[] = [];
  socket.on('open', () => socket.send(JSON.stringify({ type: 'subscribe-table', requestId: randomUUID(), tableSessionId: t.id })));
  socket.on('error', () => {});
  socket.on('message', data => { const message: ServerLiveMessage = JSON.parse(data.toString()); if (message.type === 'table-update') messages.push(message); });
  return { socket, messages, async next(revision: number) {
    await expect.poll(() => messages.find(message => message.type === 'table-update' && message.sessionRevision === revision)).toBeDefined();
    return messages.find((message): message is ObservableTableUpdate => message.type === 'table-update' && message.sessionRevision === revision)!;
  } };
}

test('new Table Sessions expose a complete default Reference Strategy and Live Analysis off independently of Bot assignments', async () => {
  const t = await table();
  expect(await read(t)).toMatchObject({
    pokerRevision: 0, sessionRevision: 0,
    trainerConfiguration: { referenceStrategy: defaultPlayingStrategy, liveAnalysis: false },
    bindings: [expect.objectContaining({ controller: { kind: 'human' } }), expect.objectContaining({ controller: { kind: 'bot', playingStrategy: baselinePlayingStrategy } })],
  });
});

test('matching retries share one durable change while conflicting and stale changes retain definitive rejections', async () => {
  const t = await table();
  const request = change(0, 'same-request');
  const responses = await Promise.all([configure(t, request), configure(t, request)]);
  expect(await responses[0]!.json()).toEqual(await responses[1]!.json());
  expect(await read(t)).toMatchObject({ pokerRevision: 0, sessionRevision: 1, trainerConfiguration: chosenConfiguration });
  expect((await configure(t, { ...request, trainerConfiguration: { ...chosenConfiguration, liveAnalysis: false } })).status).toBe(409);
  const stale = change(0, 'stale');
  expect(await (await configure(t, stale)).json()).toMatchObject({ ok: false, rejection: { code: 'stale-session-revision' } });
  expect((await configure(t, change(1))).status).toBe(200);
  expect(await (await configure(t, stale)).json()).toMatchObject({ ok: false, rejection: { code: 'stale-session-revision' } });
  expect(await read(t)).toMatchObject({ pokerRevision: 0, sessionRevision: 2, trainerConfiguration: chosenConfiguration });
});

test('two owner connections receive the complete configuration only after commit, without poker events or repeated publications', async () => {
  const t = await table();
  const first = connect(t);
  const second = connect(t);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let held: Promise<Response> | undefined;
  try {
    await Promise.all([first.next(0), second.next(0)]);
    beforeCommit = async context => { if (context.tableSessionId === t.id) { entered.resolve(); await release.promise; } };
    held = configure(t, change(0, 'held'));
    await entered.promise;
    expect(await read(t)).toMatchObject({ pokerRevision: 0, sessionRevision: 0, trainerConfiguration: { referenceStrategy: defaultPlayingStrategy, liveAnalysis: false } });
    expect(first.messages).toHaveLength(1);
    expect(second.messages).toHaveLength(1);
    release.resolve();
    expect((await held).status).toBe(200);
    const updates = await Promise.all([first.next(1), second.next(1)]);
    for (const update of updates) expect(update).toMatchObject({ pokerRevision: 0, trainerConfiguration: chosenConfiguration, presentationEvents: [] });
    expect((await configure(t, change(0, 'held'))).status).toBe(200);
    expect(first.messages).toHaveLength(2);
    expect(second.messages).toHaveLength(2);
  } finally { release.resolve(); beforeCommit = async () => {}; await held; first.socket.terminate(); second.socket.terminate(); }
});

test.each([
  { trainerConfiguration: { ...chosenConfiguration, unknown: true } },
  { trainerConfiguration: { referenceStrategy: highestProbabilityPlayingStrategy } },
  { trainerConfiguration: { ...chosenConfiguration, liveAnalysis: 'true' } },
  { trainerConfiguration: { ...chosenConfiguration, referenceStrategy: { ...highestProbabilityPlayingStrategy, selector: { id: 'unknown', version: 'v1', configuration: {} } } } },
  { trainerConfiguration: { ...chosenConfiguration, referenceStrategy: { ...highestProbabilityPlayingStrategy, policy: { id: 'uniform-choice', version: 'v1', configuration: { hidden: true } } } } },
  { unknown: true, trainerConfiguration: chosenConfiguration },
  { expectedSessionRevision: -1, trainerConfiguration: chosenConfiguration },
])('invalid or unsupported configuration is rejected atomically: %j', async contents => {
  const t = await table();
  const before = await read(t);
  const request = { requestId: randomUUID(), expectedSessionRevision: 0, ...contents };
  const first = await configure(t, request);
  expect(first.status).toBe(400);
  const outcome = await first.json();
  expect(outcome).toMatchObject({ ok: false });
  expect(await (await configure(t, request)).json()).toEqual(outcome);
  expect(await read(t)).toEqual(before);
});

test('another user and an unauthenticated caller cannot read or change the owner configuration', async () => {
  const t = await table();
  const outsider = await table();
  const before = await read(t);
  expect((await configure({ ...t, cookie: outsider.cookie }, change())).status).toBe(404);
  expect((await configure({ ...t, cookie: '' }, change())).status).toBe(401);
  const foreignRead = await fetch(base + '/api/table-sessions/' + t.id, { headers: { cookie: outsider.cookie } });
  expect(foreignRead.status).toBe(404);
  expect(await read(t)).toEqual(before);
});

test('a confirmed rollback preserves configuration and permits explicitly retrying the same request', async () => {
  const t = await table();
  const before = await read(t);
  const request = change();
  beforeCommit = async () => { throw new Error('Controlled preference rollback'); };
  try {
    expect((await configure(t, request)).status).toBe(503);
    expect(await read(t)).toEqual(before);
  } finally { beforeCommit = async () => {}; }
  expect((await configure(t, request)).status).toBe(200);
  expect(await read(t)).toMatchObject({ pokerRevision: 0, sessionRevision: 1, trainerConfiguration: chosenConfiguration });
});

test('lost commit confirmation resolves to one original preference outcome and restores its complete descriptor after restart', async () => {
  const t = await table();
  const request = change();
  afterCommit = async () => { throw new Error('Controlled lost preference COMMIT confirmation'); };
  try {
    const uncertain = await configure(t, request);
    expect(uncertain.status).toBe(503);
    expect(await uncertain.json()).toMatchObject({ ok: false, rejection: { code: 'commit-outcome-unknown' } });
  } finally { afterCommit = async () => {}; }
  const acknowledged = { ok: true, tableSessionId: t.id, pokerRevision: 0, sessionRevision: 1 };
  expect(await (await configure(t, request)).json()).toEqual(acknowledged);
  await server.close();
  await start();
  expect(await read(t)).toMatchObject({ pokerRevision: 0, sessionRevision: 1, trainerConfiguration: chosenConfiguration });
  expect(await (await configure(t, request)).json()).toEqual(acknowledged);
  const restored = connect(t);
  try { expect(await restored.next(1)).toMatchObject({ pokerRevision: 0, trainerConfiguration: chosenConfiguration }); }
  finally { restored.socket.terminate(); }
});

test('an incompatible pre-release record fails restoration instead of silently replacing its missing Trainer configuration', async () => {
  const t = await table();
  await server.close();
  // An external persistence fixture simulates an older pre-release record format.
  await administration.query('UPDATE "' + schema + '".table_sessions SET aggregate = aggregate - \'trainerConfiguration\' WHERE id = $1', [t.id]);
  await start();
  const response = await fetch(base + '/api/table-sessions/' + t.id, { headers: { cookie: t.cookie } });
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({ ok: false, rejection: { code: 'record-restoration-failed' } });
});

test('the owner commits a complete Reference Strategy and Live Analysis setting without changing poker history or Bot assignments', async () => {
  const t = await table();
  const before = await read(t);
  const trainerConfiguration = { referenceStrategy: highestProbabilityPlayingStrategy, liveAnalysis: true };
  const response = await configure(t, { requestId: 'preferences', expectedSessionRevision: 0, trainerConfiguration });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true, tableSessionId: t.id, pokerRevision: 0, sessionRevision: 1 });
  expect(await read(t)).toMatchObject({ trainerConfiguration, pokerRevision: 0, sessionRevision: 1, view: before.view, bindings: before.bindings });
  const botChange = await fetch(base + '/api/table-sessions/' + t.id + '/set-playing-strategy', { method: 'POST', headers: { cookie: t.cookie, 'content-type': 'application/json' }, body: JSON.stringify({ requestId: randomUUID(), expectedSessionRevision: 1, participantId: t.bot, playingStrategy: highestProbabilityPlayingStrategy }) });
  expect(botChange.status).toBe(200);
  expect(await read(t)).toMatchObject({ trainerConfiguration, pokerRevision: 0, sessionRevision: 2 });
  const reset = { referenceStrategy: baselinePlayingStrategy, liveAnalysis: false };
  expect((await configure(t, { requestId: randomUUID(), expectedSessionRevision: 2, trainerConfiguration: reset })).status).toBe(200);
  expect(await read(t)).toMatchObject({ trainerConfiguration: reset, pokerRevision: 0, sessionRevision: 3, bindings: [expect.anything(), expect.objectContaining({ controller: { kind: 'bot', playingStrategy: highestProbabilityPlayingStrategy } })] });
});

test('Simple Heuristic assignments persist and an existing Uniform Choice reference and Bot remain unchanged after restart', async () => {
  const heuristic = await table(defaultPlayingStrategy);
  const baseline = await table();
  expect(await read(heuristic)).toMatchObject({
    trainerConfiguration: { referenceStrategy: defaultPlayingStrategy },
    bindings: [expect.anything(), expect.objectContaining({ controller: { kind: 'bot', playingStrategy: defaultPlayingStrategy } })],
  });
  expect((await configure(baseline, { requestId: randomUUID(), expectedSessionRevision: 0, trainerConfiguration: { referenceStrategy: baselinePlayingStrategy, liveAnalysis: false } })).status).toBe(200);
  const before = await read(baseline);
  const heuristicBefore = await read(heuristic);
  await server.close();
  await start();
  expect(await read(baseline)).toEqual(before);
  expect(await read(heuristic)).toEqual(heuristicBefore);
  const reference = { ...defaultPlayingStrategy, selector: highestProbabilityPlayingStrategy.selector };
  expect((await configure(baseline, { requestId: randomUUID(), expectedSessionRevision: 1, trainerConfiguration: { referenceStrategy: reference, liveAnalysis: true } })).status).toBe(200);
  expect(await read(baseline)).toMatchObject({ trainerConfiguration: { referenceStrategy: reference }, bindings: before.bindings });
});
