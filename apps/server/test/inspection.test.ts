import { afterAll, beforeAll, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import WebSocket from 'ws';
import { baselinePlayingStrategy, type ObservableTableSession, type TableLiveMessage } from '@poker/contracts';
import { createServer } from '../src/server.js';
import type { TableSessionControllerCommands } from '../src/mutations.js';
import type { Strategy } from '@poker/strategies';

const databaseUrl = process.env.TEST_DATABASE_URL!;
const schema = 'test_' + randomUUID().replaceAll('-', '');
const administration = new Pool({ connectionString: databaseUrl });
let server: Awaited<ReturnType<typeof createServer>>;
let base: string;
let controllers: TableSessionControllerCommands;
beforeAll(async () => {
  await administration.query('CREATE SCHEMA "' + schema + '"');
  server = await createServer({ databaseUrl, schema, automaticBots: false, onControllerCommandsReady: commands => { controllers = commands; } });
  base = await server.listen({ host: '127.0.0.1', port: 0 });
});
afterAll(async () => { await server?.close(); await administration.query('DROP SCHEMA "' + schema + '" CASCADE'); await administration.end(); });
async function table(bots = 1) {
  const identity = await fetch(base + '/api/identity');
  const cookie = identity.headers.get('set-cookie')!.split(';')[0]!;
  const result = await fetch(base + '/api/table-sessions', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ requestId: randomUUID(), bots: Array.from({ length: bots }, (_, i) => ({ name: 'Bot ' + i, playingStrategy: baselinePlayingStrategy })) }) });
  const created = await result.json();
  return { id: created.tableSessionId as string, cookie, human: created.bindings[0].participantId as string, bots: created.bindings.slice(1).map((b: { participantId: string }) => b.participantId) as string[] };
}
type Table = Awaited<ReturnType<typeof table>>;
const read = async (t: Table): Promise<ObservableTableSession> => (await fetch(base + '/api/table-sessions/' + t.id, { headers: { cookie: t.cookie } })).json();
async function command(t: Table, kind: string, contents: object = {}) {
  const current = await read(t);
  const result = await fetch(base + '/api/table-sessions/' + t.id + '/' + kind, { method: 'POST', headers: { cookie: t.cookie, 'content-type': 'application/json' }, body: JSON.stringify({ requestId: randomUUID(), expectedPokerRevision: current.pokerRevision, ...contents }) });
  expect(result.status).toBe(200);
}
const inspect = (t: Table, handId = 'hand-1', cookie = t.cookie, extras = {}) => fetch(base + '/api/table-sessions/' + t.id + '/inspect-hand', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ handId, ...extras }) });
async function completed() {
  const t = await table();
  await command(t, 'seat-participant', { participantId: t.human, seat: 1 });
  await command(t, 'seat-participant', { participantId: t.bots[0], seat: 2 });
  await command(t, 'start-hand');
  await command(t, 'act', { participantId: t.human, action: { type: 'fold' } });
  return t;
}

test('owner explicitly inspects one durable completed Hand without changing commands, revisions or original decision visibility', async () => {
  const t = await completed();
  const before = await read(t);
  const durableBefore = await controllers.readPersistedSession(t.id);
  const response = await inspect(t);
  expect(response.status).toBe(200);
  const result = await response.json();
  expect(result).toMatchObject({ ok: true, tableSessionId: t.id, hand: { handId: 'hand-1', sequence: 1, buttonSeat: 1, drawnCardCount: 4, board: [], burns: [], returns: [{ participantId: t.bots[0], amount: 10 }], payouts: [{ participantId: t.bots[0], amount: 20 }] } });
  expect(result.hand.participants.map((p: { holeCards: string[] }) => p.holeCards.length)).toEqual([2, 2]);
  expect(result.hand.participants[0].holeCards).toEqual(before.view.history[0]!.decisions[0]!.state.participants[0]!.holeCards);
  // V1 heads-up dealing starts at the button, one clockwise card per pass.
  expect(result.hand.participants[0].holeCards).toEqual([result.hand.deck[0], result.hand.deck[2]]);
  expect(result.hand.participants[1].holeCards).toEqual([result.hand.deck[1], result.hand.deck[3]]);
  expect(result.hand.deck).toHaveLength(52);
  expect(new Set(result.hand.deck).size).toBe(52);
  expect(Object.keys(result.hand).sort()).toEqual(['handId', 'sequence', 'buttonSeat', 'smallBlindParticipantId', 'bigBlindParticipantId', 'participants', 'deck', 'drawnCardCount', 'burns', 'board', 'pots', 'returns', 'payouts'].sort());
  expect(JSON.stringify(result)).not.toMatch(/"(?:seed|configuration|commands|ownerUserId|userId|assignmentId|botProvenance|game|actorId|decisionId)"\s*:/);
  expect(await read(t)).toEqual(before);
  expect(await controllers.readPersistedSession(t.id)).toEqual(durableBefore);
  expect(before.view.history[0]!.decisions[0]!.state.participants[1]).not.toHaveProperty('holeCards');
});

test('owner selection lists completed Bot-only Hands outside the filtered Participant history, including reconnect', async () => {
  const t = await table(2);
  for (let i = 0; i < 2; i++) await command(t, 'seat-participant', { participantId: t.bots[i], seat: i + 1 });
  await command(t, 'start-hand');
  expect(await read(t)).toMatchObject({ inspection: { adminMode: true, completedHands: [] } });
  await controllers.submitAction(t.id, { requestId: randomUUID(), expectedPokerRevision: 3, participantId: t.bots[0]!, action: { type: 'fold' } });
  const view = await read(t);
  expect(view.view.history).toEqual([]);
  expect(view.inspection).toEqual({ adminMode: true, completedHands: [{ handId: 'hand-1', sequence: 1 }] });
  const socket = new WebSocket(base.replace('http:', 'ws:') + '/api/table-sessions/' + t.id + '/live', { headers: { cookie: t.cookie } });
  const frames: TableLiveMessage[] = [];
  socket.on('message', data => frames.push(JSON.parse(data.toString())));
  try {
    await expect.poll(() => frames.find(f => f.type === 'table-update')).toBeDefined();
    expect(frames[0]).toMatchObject({ inspection: view.inspection, view: { history: [] } });
    expect((await inspect(t)).status).toBe(200);
    expect(JSON.stringify(frames)).not.toMatch(/"(?:deck|burns|seed|pokerRecord)"\s*:/);
  } finally { socket.terminate(); }
});

test('direct inspection rejects unauthenticated, non-owner, active, unknown and unsupported requests and disabling Admin Mode survives unchanged revisions', async () => {
  const t = await completed();
  const other = await table();
  expect((await inspect(t, 'hand-1', '')).status).toBe(401);
  expect((await inspect(t, 'hand-1', other.cookie)).status).toBe(404);
  expect((await inspect(t, 'missing')).status).toBe(404);
  expect((await inspect(t, 'hand-1', t.cookie, { seed: 'forbidden' })).status).toBe(400);
  await command(t, 'start-hand');
  const before = await read(t);
  const record = await controllers.readPersistedSession(t.id);
  expect(await (await inspect(t, 'hand-2')).json()).toMatchObject({ ok: false, rejection: { code: 'active-hand' } });
  expect((await inspect(t, 'hand-1')).status).toBe(200);
  expect(await read(t)).toEqual(before);
  expect(await controllers.readPersistedSession(t.id)).toEqual(record);
  await server.close();
  server = await createServer({ databaseUrl, schema, automaticBots: false, adminMode: false, onControllerCommandsReady: commands => { controllers = commands; } });
  base = await server.listen({ host: '127.0.0.1', port: 0 });
  expect(await read(t)).toEqual({ ...before, inspection: { adminMode: false, completedHands: [] } });
  expect(await (await inspect(t)).json()).toMatchObject({ ok: false, rejection: { code: 'admin-mode-disabled' } });
  const socket = new WebSocket(base.replace('http:', 'ws:') + '/api/table-sessions/' + t.id + '/live', { headers: { cookie: t.cookie } });
  const frames: TableLiveMessage[] = [];
  socket.on('message', data => frames.push(JSON.parse(data.toString())));
  try {
    await expect.poll(() => frames.find(f => f.type === 'table-update')).toBeDefined();
    expect(frames[0]).toMatchObject({ pokerRevision: before.pokerRevision, sessionRevision: before.sessionRevision, inspection: { adminMode: false, completedHands: [] } });
  } finally { socket.terminate(); }
  expect(await controllers.readPersistedSession(t.id)).toEqual(record);
  await server.close();
  server = await createServer({ databaseUrl, schema, automaticBots: false, onControllerCommandsReady: commands => { controllers = commands; } });
  base = await server.listen({ host: '127.0.0.1', port: 0 });
  await controllers.submitAction(t.id, { requestId: randomUUID(), expectedPokerRevision: before.pokerRevision, participantId: t.bots[0]!, action: { type: 'fold' } });
});

test('showdown inspection reconstructs burn-before-board draws while earlier decision information stays unchanged', async () => {
  const t = await table();
  await command(t, 'seat-participant', { participantId: t.human, seat: 1 });
  await command(t, 'seat-participant', { participantId: t.bots[0], seat: 2 });
  await command(t, 'start-hand');
  const decision = (await read(t)).view.state;
  await command(t, 'act', { participantId: t.human, action: { type: 'call' } });
  while ((await read(t)).view.state.status === 'active-hand') {
    const current = await read(t);
    if (current.view.state.actorId === t.human) await command(t, 'act', { participantId: t.human, action: { type: 'check' } });
    else expect((await controllers.submitAction(t.id, { requestId: randomUUID(), expectedPokerRevision: current.pokerRevision, participantId: t.bots[0]!, action: { type: 'check' } })).ok).toBe(true);
  }
  const before = await read(t);
  const persisted = await controllers.readPersistedSession(t.id);
  const result = await (await inspect(t)).json();
  expect(result.hand).toMatchObject({ handId: 'hand-1', drawnCardCount: 12, returns: [], pots: [{ amount: 40 }] });
  expect(result.hand.burns).toEqual([result.hand.deck[4], result.hand.deck[8], result.hand.deck[10]]);
  expect(result.hand.board).toEqual([result.hand.deck[5], result.hand.deck[6], result.hand.deck[7], result.hand.deck[9], result.hand.deck[11]]);
  expect(result.hand.payouts.reduce((sum: number, p: { amount: number }) => sum + p.amount, 0)).toBe(40);
  expect(before.view.history[0]!.decisions[0]!.state).toEqual(decision);
  expect(decision.participants[1]).not.toHaveProperty('holeCards');
  expect(await read(t)).toEqual(before);
  expect(await controllers.readPersistedSession(t.id)).toEqual(persisted);
});

test('inspection shares Bot capacity, waits outside mutation acceptance and retains a completed result when later poker advances', async () => {
  await server.close();
  const release = Promise.withResolvers<void>();
  let policyView: unknown;
  const strategy: Strategy = {
    policy: { checkCompatibility: () => ({ compatible: true }), evaluate: async view => { policyView = view; await release.promise; return { choices: [{ action: { type: 'fold' }, probability: 1 }] }; } },
    actionSelector: { select: choices => choices[0]!.action },
  };
  server = await createServer({ databaseUrl, schema, jobRunnerOptions: { concurrency: 1, maximumQueued: 1, timeoutMs: 30000 }, strategyFactory: () => strategy, onControllerCommandsReady: commands => { controllers = commands; } });
  base = await server.listen({ host: '127.0.0.1', port: 0 });
  try {
    const t = await completed();
    const first = await read(t);
    await command(t, 'start-hand');
    await expect.poll(() => policyView).toBeDefined();
    const queued = inspect(t);
    let finished = false;
    void queued.then(() => { finished = true; });
    // Capacity proves this is the same runner as the executing Bot, not a second Research runner.
    await expect.poll(async () => (await inspect(t)).status).toBe(503);
    expect(finished).toBe(false);
    const active = await read(t);
    expect(JSON.stringify(policyView)).not.toMatch(/"(?:inspection|deck|burns|seed|configurationSeed|commands|pokerRecord)"\s*:/);
    await controllers.submitAction(t.id, { requestId: randomUUID(), expectedPokerRevision: active.pokerRevision, participantId: t.bots[0]!, action: { type: 'fold' } });
    await command(t, 'start-hand');
    expect((await read(t)).view.state.legalActions).toContainEqual({ type: 'fold' });
    await command(t, 'act', { participantId: t.human, action: { type: 'fold' } });
    const advanced = await read(t);
    const record = await controllers.readPersistedSession(t.id);
    release.resolve();
    const response = await queued;
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.hand).toMatchObject({ handId: 'hand-1', sequence: 1, board: [], burns: [], drawnCardCount: 4 });
    expect(JSON.stringify(result)).not.toContain('hand-2');
    expect(JSON.stringify(result)).not.toContain('hand-3');
    expect(await read(t)).toEqual(advanced);
    expect(await controllers.readPersistedSession(t.id)).toEqual(record);
    expect(advanced.view.history[0]!.decisions).toEqual(first.view.history[0]!.decisions);
  } finally { release.resolve(); }
});
