import { afterAll, beforeAll, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import WebSocket from 'ws';
import { baselinePlayingStrategy, type ObservableTableSession, type TableLiveMessage } from '@poker/contracts';
import { createServer } from '../src/server.js';

const databaseUrl = process.env.TEST_DATABASE_URL!;
const schema = 'test_' + randomUUID().replaceAll('-', '');
const administration = new Pool({ connectionString: databaseUrl });
let server: Awaited<ReturnType<typeof createServer>>;
let base: string;
beforeAll(async () => { await administration.query('CREATE SCHEMA "' + schema + '"'); server = await createServer({ databaseUrl, schema }); base = await server.listen({ host: '127.0.0.1', port: 0 }); });
afterAll(async () => { await server?.close(); await administration.query('DROP SCHEMA "' + schema + '" CASCADE'); await administration.end(); });
async function table(botCount = 1, configuration?: { ante: number; minimumBuyIn: number; defaultBuyIn: number }) {
  const identity = await fetch(base + '/api/identity');
  const cookie = identity.headers.get('set-cookie')!.split(';')[0]!;
  const creation = await fetch(base + '/api/table-sessions', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ requestId: randomUUID(), configuration, bots: Array.from({ length: botCount }, (_, index) => ({ name: 'Bot ' + (index + 1), playingStrategy: { ...baselinePlayingStrategy, selector: { id: 'highest-probability', version: 'v1', configuration: {} } } })) }) });
  expect(creation.status).toBe(201);
  const value = await creation.json();
  return { id: value.tableSessionId as string, cookie, human: value.bindings[0].participantId as string, bot: value.bindings[1].participantId as string, bots: value.bindings.slice(1).map((binding: { participantId: string }) => binding.participantId) as string[] };
}
type Table = Awaited<ReturnType<typeof table>>;
async function read(t: Table): Promise<ObservableTableSession> { return (await fetch(base + '/api/table-sessions/' + t.id, { headers: { cookie: t.cookie } })).json(); }
async function command(t: Table, kind: string, contents: object = {}) {
  const current = await read(t);
  const result = await fetch(base + '/api/table-sessions/' + t.id + '/' + kind, { method: 'POST', headers: { cookie: t.cookie, 'content-type': 'application/json' }, body: JSON.stringify({ requestId: randomUUID(), expectedPokerRevision: current.pokerRevision, ...contents }) });
  expect(result.status).toBe(200);
  return result.json();
}
test('server evaluates the bound Bot after a human action, publishes safe thinking and confirmed play, and waits after settlement', async () => {
  const t = await table();
  await command(t, 'seat-participant', { participantId: t.human, seat: 1 });
  await command(t, 'seat-participant', { participantId: t.bot, seat: 2 });
  const socket = new WebSocket(base.replace('http:', 'ws:') + '/api/table-sessions/' + t.id + '/live', { headers: { cookie: t.cookie } });
  const messages: TableLiveMessage[] = [];
  socket.on('message', data => messages.push(JSON.parse(data.toString())));
  try {
    await expect.poll(() => messages.length).toBe(1);
    await command(t, 'start-hand');
    await command(t, 'act', { participantId: t.human, action: { type: 'call' } });
    await expect.poll(async () => (await read(t)).view.state.status).toBe('completed-hand');
    expect(await read(t)).toMatchObject({ pokerRevision: 5, sessionRevision: 5 });
    expect(messages).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'table-status', status: { phase: 'thinking', participantId: t.bot } })]));
    expect(JSON.stringify(messages)).not.toMatch(/"(?:seed|evaluationSeed|selectionSeed|botProvenance|assignmentId|diagnostics|deck|burns)"\s*:/);
    expect((await read(t)).view.state.handId).toBe('hand-1');
  } finally { socket.terminate(); }
});

test('Bots automatically complete a Hand while the Table Owner’s human Participant has never been seated', async () => {
  const t = await table(2);
  await command(t, 'seat-participant', { participantId: t.bots[0], seat: 1 });
  await command(t, 'seat-participant', { participantId: t.bots[1], seat: 2 });
  await command(t, 'start-hand');
  await expect.poll(async () => (await read(t)).inspection.completedHands).toEqual([{ handId: 'hand-1', sequence: 1 }]);
  await expect.poll(async () => (await read(t)).runtimeStatus?.phase).toBe('idle');
  expect(await read(t)).toMatchObject({ pokerRevision: 4, sessionRevision: 4, runtimeStatus: { phase: 'idle' }, view: { state: { status: 'completed-hand', actorId: null, legalActions: [] }, history: [] } });
  expect((await read(t)).view.state).not.toHaveProperty('handId');
  expect(JSON.stringify((await read(t)).view)).not.toMatch(/"(?:holeCards|seed|deck|burns)"\s*:/);
});

test('Bots automatically complete a Hand while the human Participant is sitting out', async () => {
  const t = await table(2);
  await command(t, 'seat-participant', { participantId: t.bots[0], seat: 1 });
  await command(t, 'seat-participant', { participantId: t.bots[1], seat: 2 });
  await command(t, 'seat-participant', { participantId: t.human, seat: 3 });
  await command(t, 'set-sitting-out', { participantId: t.human, sittingOut: true });
  await command(t, 'start-hand');
  await expect.poll(async () => (await read(t)).inspection.completedHands).toEqual([{ handId: 'hand-1', sequence: 1 }]);
  await expect.poll(async () => (await read(t)).runtimeStatus?.phase).toBe('idle');
  expect(await read(t)).toMatchObject({ pokerRevision: 6, sessionRevision: 6, runtimeStatus: { phase: 'idle' }, view: { state: { status: 'completed-hand', actorId: null, legalActions: [] } } });
  expect((await read(t)).view.state.participants.find(participant => participant.participantId === t.human)).toMatchObject({ seat: 3, sittingOut: true });
});

test('Bots continue automatically after the human Participant leaves between Hands without widening their earlier history', async () => {
  const t = await table(2);
  await command(t, 'seat-participant', { participantId: t.human, seat: 1 });
  await command(t, 'seat-participant', { participantId: t.bots[0], seat: 2 });
  await command(t, 'start-hand');
  await command(t, 'act', { participantId: t.human, action: { type: 'fold' } });
  await command(t, 'seat-participant', { participantId: t.bots[1], seat: 3 });
  await command(t, 'leave-participant', { participantId: t.human });
  const before = await read(t);
  await command(t, 'start-hand');
  await expect.poll(async () => (await read(t)).inspection.completedHands).toEqual([{ handId: 'hand-1', sequence: 1 }, { handId: 'hand-2', sequence: 2 }]);
  await expect.poll(async () => (await read(t)).runtimeStatus?.phase).toBe('idle');
  const after = await read(t);
  expect(after).toMatchObject({ pokerRevision: 8, sessionRevision: 8, runtimeStatus: { phase: 'idle' }, view: { state: { actorId: null, legalActions: [] } } });
  expect(after.view.history).toEqual(before.view.history);
  expect(after.view.state).not.toHaveProperty('handId');
});

test('an absent Human receives no Bot-only all-in cards through HTTP or live presentation events while explicit Admin inspection remains available', async () => {
  const t = await table(2, { ante: 10, minimumBuyIn: 10, defaultBuyIn: 10 });
  await command(t, 'seat-participant', { participantId: t.human, seat: 3 });
  const socket = new WebSocket(base.replace('http:', 'ws:') + '/api/table-sessions/' + t.id + '/live', { headers: { cookie: t.cookie } });
  const messages: TableLiveMessage[] = [];
  socket.on('message', data => messages.push(JSON.parse(data.toString())));
  try {
    await expect.poll(() => messages.length).toBe(1);
    await command(t, 'leave-participant', { participantId: t.human });
    await command(t, 'seat-participant', { participantId: t.bots[0], seat: 1 });
    await command(t, 'seat-participant', { participantId: t.bots[1], seat: 2 });
    await command(t, 'start-hand');
    await expect.poll(() => messages.find(message => message.type === 'table-update' && message.sessionRevision === 5)).toBeDefined();
    const completed = await read(t);
    expect(completed).toMatchObject({ pokerRevision: 5, sessionRevision: 5, inspection: { completedHands: [{ handId: 'hand-1', sequence: 1 }] }, view: { state: { actorId: null, board: [], legalActions: [] }, history: [] } });
    expect(completed.view.state).not.toHaveProperty('handId');
    const update = messages.find(message => message.type === 'table-update' && message.sessionRevision === 5);
    expect(update).toMatchObject({ presentationEvents: [], view: completed.view });
    expect(messages).toContainEqual(expect.objectContaining({ type: 'table-update', presentationEvents: [{ type: 'participant-left', participantId: t.human, seat: 3, cashOut: 10 }] }));
    expect(JSON.stringify(messages)).not.toMatch(/"(?:holeCards|cards|deck|burns|seed)"\s*:/);
    const response = await fetch(base + '/api/table-sessions/' + t.id + '/inspect-hand', { method: 'POST', headers: { cookie: t.cookie, 'content-type': 'application/json' }, body: JSON.stringify({ handId: 'hand-1' }) });
    expect(response.status).toBe(200);
    const inspected = (await response.json()).hand;
    expect(inspected.board).toHaveLength(5);
    expect(inspected.burns).toHaveLength(3);
    expect(inspected.participants.every((participant: { holeCards: string[] }) => participant.holeCards.length === 2)).toBe(true);
    expect(await read(t)).toMatchObject({ pokerRevision: 5, sessionRevision: 5, view: completed.view });
  } finally { socket.terminate(); }
});
