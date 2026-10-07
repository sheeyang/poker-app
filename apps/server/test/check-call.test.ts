import { afterAll, beforeAll, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { baselinePlayingStrategy, type ConcreteAction, type ObservableTableSession } from '@poker/contracts';
import { createServer } from '../src/server.js';
import type { TableSessionControllerCommands } from '../src/mutations.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('Set TEST_DATABASE_URL to a real PostgreSQL test database.');
const schema = 'test_' + randomUUID().replaceAll('-', '');
const administration = new Pool({ connectionString: databaseUrl });
let server: Awaited<ReturnType<typeof createServer>>;
let base: string;
let controllers: TableSessionControllerCommands;
let beforeCommit: (context: { tableSessionId: string; requestId: string }) => Promise<void> = async () => {};
async function startServer() {
  server = await createServer({ databaseUrl: databaseUrl!, schema, mutationTransactionFaults: { beforeCommit: context => beforeCommit(context) }, onControllerCommandsReady: commands => { controllers = commands; } });
  base = await server.listen({ host: '127.0.0.1', port: 0 });
}
beforeAll(async () => { await administration.query('CREATE SCHEMA "' + schema + '"'); await startServer(); });
afterAll(async () => { await server?.close(); await administration.query('DROP SCHEMA "' + schema + '" CASCADE'); await administration.end(); });
type Table = { id: string; cookie: string; human: string; bot: string };
async function table(): Promise<Table> {
  const identity = await fetch(base + '/api/identity');
  const cookie = identity.headers.get('set-cookie')!.split(';')[0]!;
  const response = await fetch(base + '/api/table-sessions', { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ requestId: randomUUID(), bots: [{ name: 'Bot', playingStrategy: baselinePlayingStrategy }] }) });
  const created = await response.json();
  const t = { id: created.tableSessionId, cookie, human: created.bindings[0].participantId, bot: created.bindings[1].participantId };
  expect((await submit(t, 'seat-participant', { requestId: 'seat-human', expectedPokerRevision: 0, participantId: t.human, seat: 1 })).status).toBe(200);
  expect((await submit(t, 'seat-participant', { requestId: 'seat-bot', expectedPokerRevision: 1, participantId: t.bot, seat: 4 })).status).toBe(200);
  expect((await submit(t, 'start-hand', { requestId: 'start', expectedPokerRevision: 2 })).status).toBe(200);
  return t;
}
const submit = (t: Table, kind: string, body: unknown) => fetch(base + '/api/table-sessions/' + t.id + '/' + kind, { method: 'POST', headers: { 'content-type': 'application/json', cookie: t.cookie }, body: JSON.stringify(body) });
const read = async (t: Table): Promise<ObservableTableSession> => (await (await fetch(base + '/api/table-sessions/' + t.id, { headers: { cookie: t.cookie } })).json());
const humanAct = (t: Table, revision: number, action: ConcreteAction, requestId: string = randomUUID()) => submit(t, 'act', { requestId, expectedPokerRevision: revision, participantId: t.human, action });
const botAct = (t: Table, revision: number, action: ConcreteAction, requestId: string = randomUUID()) => controllers.submitAction(t.id, { requestId, expectedPokerRevision: revision, participantId: t.bot, action });

test('authenticated human Call and trusted Bot Check progress every street, reveal only at showdown, and restore after restart', async () => {
  const t = await table(); const before = await read(t);
  expect((await humanAct(t, 3, { type: 'call' }, 'human-call')).status).toBe(200);
  const option = await read(t);
  expect(option).toMatchObject({ pokerRevision: 4, sessionRevision: 4, view: { state: { street: 'preflop', actorId: t.bot, board: [], legalActions: [] } } });
  expect((await submit(t, 'act', { requestId: 'browser-bot', expectedPokerRevision: 4, participantId: t.bot, action: { type: 'check' } })).status).toBe(403);
  expect(await read(t)).toEqual(option);
  expect(await botAct(t, 4, { type: 'check' }, 'bot-option')).toMatchObject({ ok: true, pokerRevision: 5 });
  expect((await submit(t, 'act', { requestId: 'bot-option', expectedPokerRevision: 4, participantId: t.bot, action: { type: 'check' } })).status).toBe(409);
  for (const [index, street] of ['flop', 'turn', 'river'].entries()) {
    const view = await read(t);
    expect(view.view.state).toMatchObject({ street, actorId: t.bot, board: expect.any(Array), legalActions: [] });
    expect(view.view.state.board).toHaveLength(index + 3);
    expect(view.view.state.participants.map(p => [p.stack, p.wager, p.contribution])).toEqual([[980, 0, 20], [980, 0, 20]]);
    expect(view.view.state.participants[1]).not.toHaveProperty('holeCards');
    expect(JSON.stringify(view)).not.toMatch(/"(?:seed|deck|burns|commands|drawnCardCount|ownerUserId|userId)"\s*:/);
    expect(await botAct(t, 5 + index * 2, { type: 'check' })).toMatchObject({ ok: true, pokerRevision: 6 + index * 2 });
    const humanTurn = await read(t);
    expect(humanTurn.view.state).toMatchObject({ actorId: t.human, legalActions: [{ type: 'fold' }, { type: 'check' }, { type: 'bet', minimum: 20, maximum: 980 }] });
    expect((await humanAct(t, 6 + index * 2, { type: 'check' })).status).toBe(200);
  }
  const completed = await read(t);
  expect(completed).toMatchObject({ pokerRevision: 11, sessionRevision: 11, view: { state: { status: 'completed-hand', actorId: null, legalActions: [], board: expect.any(Array) } } });
  expect(completed.view.state.participants[1]!.holeCards).toHaveLength(2);
  expect(completed.view.state.participants.reduce((sum, p) => sum + p.stack, 0)).toBe(2000);
  expect(completed.view.state.payouts!.reduce((sum, p) => sum + p.amount, 0)).toBe(40);
  expect(completed.view.state.returns).toEqual([]);
  expect(before.view.state.participants[1]).not.toHaveProperty('holeCards');
  expect(before.view.state.board).toEqual([]);
  expect(await botAct(t, 4, { type: 'check' }, 'bot-option')).toMatchObject({ ok: true, pokerRevision: 5 });
  expect(await read(t)).toEqual(completed);
  await server.close(); await startServer(); expect(await read(t)).toEqual(completed);
  expect((await submit(t, 'start-hand', { requestId: 'hand-2', expectedPokerRevision: 11 })).status).toBe(200);
  expect((await read(t)).view.state.actorId).toBe(t.bot);
  expect(await botAct(t, 12, { type: 'call' })).toMatchObject({ ok: true, pokerRevision: 13 });
  expect((await humanAct(t, 13, { type: 'check' })).status).toBe(200);
  const nextFlop = (await read(t)).view.state;
  // The server-generated deck may award Hand 1 to either player; winnings carry into this Hand.
  const humanStack = nextFlop.participants.find(p => p.participantId === t.human)!.stack;
  expect(nextFlop).toMatchObject({ street: 'flop', actorId: t.human, legalActions: [{ type: 'fold' }, { type: 'check' }, { type: 'bet', minimum: 20, maximum: humanStack }] });
});

test('trusted controller commands retain actor, binding, and revision checks and share the human command FIFO', async () => {
  const t = await table(); const before = await read(t);
  expect(await controllers.submitAction(t.id, { requestId: 'trusted-human', expectedPokerRevision: 3, participantId: t.human, action: { type: 'call' } })).toMatchObject({ ok: false, rejection: { code: 'actor-not-authorized' } });
  expect(await botAct(t, 3, { type: 'check' })).toMatchObject({ ok: false, rejection: { code: 'wrong-actor' } });
  expect(await botAct(t, 2, { type: 'check' })).toMatchObject({ ok: false, rejection: { code: 'stale-poker-revision' } });
  expect(await read(t)).toEqual(before);
  const entered = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
  beforeCommit = async context => { if (context.tableSessionId === t.id && context.requestId === 'held-call') { entered.resolve(); await release.promise; } };
  const calling = humanAct(t, 3, { type: 'call' }, 'held-call');
  await entered.promise;
  const checking = botAct(t, 4, { type: 'check' }, 'queued-bot');
  try { expect(await read(t)).toEqual(before); }
  finally { release.resolve(); beforeCommit = async () => {}; }
  expect((await calling).status).toBe(200); expect(await checking).toMatchObject({ ok: true, pokerRevision: 5 });
  const flop = await read(t);
  expect(flop).toMatchObject({ pokerRevision: 5, view: { state: { street: 'flop', actorId: t.bot } } });
  expect(flop.view.state.board).toHaveLength(3);
  expect(flop.view.state.participants[1]).not.toHaveProperty('holeCards');
});

test('rollback and COMMIT gating withhold river reveals, payouts, and completion, and allow an exact retry', async () => {
  const t = await table();
  await humanAct(t, 3, { type: 'call' }); await botAct(t, 4, { type: 'check' });
  for (const revision of [5, 7]) { await botAct(t, revision, { type: 'check' }); await humanAct(t, revision + 1, { type: 'check' }); }
  await botAct(t, 9, { type: 'check' });
  const river = await read(t);
  expect(river).toMatchObject({ pokerRevision: 10, view: { state: { street: 'river', actorId: t.human, status: 'active-hand' } } });
  beforeCommit = async context => { if (context.tableSessionId === t.id && context.requestId === 'final-check') throw new Error('controlled showdown rollback'); };
  try { expect((await humanAct(t, 10, { type: 'check' }, 'final-check')).status).toBe(503); }
  finally { beforeCommit = async () => {}; }
  expect(await read(t)).toEqual(river);
  const entered = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
  beforeCommit = async context => { if (context.tableSessionId === t.id && context.requestId === 'final-check') { entered.resolve(); await release.promise; } };
  const finishing = humanAct(t, 10, { type: 'check' }, 'final-check'); await entered.promise;
  try { expect(await read(t)).toEqual(river); expect(river.view.state.participants[1]).not.toHaveProperty('holeCards'); }
  finally { release.resolve(); beforeCommit = async () => {}; }
  expect((await finishing).status).toBe(200);
  const completed = await read(t);
  expect(completed).toMatchObject({ pokerRevision: 11, sessionRevision: 11, view: { state: { status: 'completed-hand', actorId: null } } });
  expect(completed.view.state.participants[1]!.holeCards).toHaveLength(2);
  expect(completed.view.state.participants.reduce((sum, p) => sum + p.stack, 0)).toBe(2000);
  expect(await (await humanAct(t, 10, { type: 'check' }, 'final-check')).json()).toMatchObject({ ok: true, pokerRevision: 11 });
  expect(await read(t)).toEqual(completed);
});
