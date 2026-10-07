import { afterAll, beforeAll, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import WebSocket from 'ws';
import { baselinePlayingStrategy, type ConcreteAction, type ObservableTableSession, type ObservableTableUpdate } from '@poker/contracts';
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
const submit = (t: Table, kind: string, body: unknown) => fetch(base + '/api/table-sessions/' + t.id + '/' + kind, { method: 'POST', headers: { 'content-type': 'application/json', cookie: t.cookie }, body: JSON.stringify(body) });
const read = async (t: Table): Promise<ObservableTableSession> => (await (await fetch(base + '/api/table-sessions/' + t.id, { headers: { cookie: t.cookie } })).json());
const humanAct = (t: Table, revision: number, action: ConcreteAction, requestId: string = randomUUID()) => submit(t, 'act', { requestId, expectedPokerRevision: revision, participantId: t.human, action });
const botAct = (t: Table, revision: number, action: ConcreteAction, requestId: string = randomUUID()) => controllers.submitAction(t.id, { requestId, expectedPokerRevision: revision, participantId: t.bot, action });
async function table(): Promise<Table> {
  const identity = await fetch(base + '/api/identity');
  const cookie = identity.headers.get('set-cookie')!.split(';')[0]!;
  const created = await (await fetch(base + '/api/table-sessions', { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ requestId: randomUUID(), bots: [{ name: 'Bot', playingStrategy: baselinePlayingStrategy }] }) })).json();
  const t = { id: created.tableSessionId, cookie, human: created.bindings[0].participantId, bot: created.bindings[1].participantId };
  expect((await submit(t, 'seat-participant', { requestId: 'seat-human', expectedPokerRevision: 0, participantId: t.human, seat: 1 })).status).toBe(200);
  expect((await submit(t, 'seat-participant', { requestId: 'seat-bot', expectedPokerRevision: 1, participantId: t.bot, seat: 4 })).status).toBe(200);
  expect((await submit(t, 'start-hand', { requestId: 'start', expectedPokerRevision: 2 })).status).toBe(200);
  return t;
}

test('exact HTTP Bet-to and Raise-to totals share engine bounds, durable retries, conservation, and completed-Hand restoration', async () => {
  const t = await table(); const first = await read(t);
  expect(first.view.state.legalActions).toEqual([{ type: 'fold' }, { type: 'call' }, { type: 'raise', minimum: 40, maximum: 1000 }]);
  expect((await humanAct(t, 3, { type: 'raise', raiseTo: 53 }, 'raise-53')).status).toBe(200);
  expect(await botAct(t, 4, { type: 'raise', raiseTo: 100 })).toMatchObject({ ok: true, pokerRevision: 5 });
  expect((await read(t)).view.state.legalActions).toEqual([{ type: 'fold' }, { type: 'call' }, { type: 'raise', minimum: 147, maximum: 1000 }]);
  expect((await humanAct(t, 5, { type: 'raise', raiseTo: 147 })).status).toBe(200);
  expect(await botAct(t, 6, { type: 'call' })).toMatchObject({ ok: true, pokerRevision: 7 });
  expect(await botAct(t, 7, { type: 'check' })).toMatchObject({ ok: true, pokerRevision: 8 });
  const flop = await read(t);
  expect(flop.view.state.legalActions).toEqual([{ type: 'fold' }, { type: 'check' }, { type: 'bet', minimum: 20, maximum: 853 }]);
  expect((await humanAct(t, 3, { type: 'raise', raiseTo: 53 }, 'stale-size')).status).toBe(409);
  expect(await read(t)).toEqual(flop);
  expect((await humanAct(t, 8, { type: 'bet', betTo: 37 })).status).toBe(200);
  expect(await botAct(t, 9, { type: 'raise', raiseTo: 74 })).toMatchObject({ ok: true, pokerRevision: 10 });
  expect((await humanAct(t, 10, { type: 'call' })).status).toBe(200);
  const turn = await read(t);
  expect(turn.view.state.participants.map(p => [p.stack, p.wager, p.contribution])).toEqual([[779, 0, 221], [779, 0, 221]]);
  for (const revision of [11, 13]) { expect((await botAct(t, revision, { type: 'check' })).ok).toBe(true); expect((await humanAct(t, revision + 1, { type: 'check' })).status).toBe(200); }
  const completed = await read(t);
  expect(completed).toMatchObject({ pokerRevision: 15, sessionRevision: 15, view: { state: { status: 'completed-hand', actorId: null, pots: [{ amount: 442, eligibleParticipantIds: [t.human, t.bot] }] } } });
  expect(completed.view.state.participants.reduce((sum, p) => sum + p.stack, 0)).toBe(2000);
  expect(completed.view.state.payouts!.reduce((sum, p) => sum + p.amount, 0)).toBe(442);
  expect(first.view.state.participants[1]).not.toHaveProperty('holeCards');
  expect(JSON.stringify(flop)).not.toMatch(/"(?:seed|deck|burns|commands|drawnCardCount)"\s*:/);
  expect(await (await humanAct(t, 3, { type: 'raise', raiseTo: 53 }, 'raise-53')).json()).toMatchObject({ ok: true, pokerRevision: 4 });
  expect((await humanAct(t, 3, { type: 'raise', raiseTo: 54 }, 'raise-53')).status).toBe(409);
  expect(await (await humanAct(t, 3, { type: 'raise', raiseTo: 53 }, 'stale-size')).json()).toMatchObject({ ok: false, rejection: { code: 'stale-poker-revision' } });
  expect(await read(t)).toEqual(completed);
  await server.close(); await startServer(); expect(await read(t)).toEqual(completed);
});

test('minimum, maximum and invalid HTTP sizes respect committed legality without partial acceptance', async () => {
  for (const amount of [40, 1000]) {
    const t = await table(); const before = await read(t);
    for (const size of [39, 1001, 40.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect((await humanAct(t, 3, { type: 'raise', raiseTo: size })).status).toBe(400);
      expect(await read(t)).toEqual(before);
    }
    expect((await humanAct(t, 3, { type: 'raise', raiseTo: amount })).status).toBe(200);
    const raised = await read(t);
    expect(raised.view.state.participants[0]).toMatchObject({ stack: 1000 - amount, wager: amount, contribution: amount });
    expect((await botAct(t, 4, { type: 'call' })).ok).toBe(true);
    expect((await read(t)).view.state.status).toBe(amount === 1000 ? 'completed-hand' : 'active-hand');
  }
});

test('held and rolled-back sized HTTP commands expose no working contribution and retain exact retry identity', async () => {
  const t = await table(); const before = await read(t);
  beforeCommit = async context => { if (context.tableSessionId === t.id && context.requestId === 'held-raise') throw new Error('controlled raise rollback'); };
  try { expect((await humanAct(t, 3, { type: 'raise', raiseTo: 57 }, 'held-raise')).status).toBe(503); }
  finally { beforeCommit = async () => {}; }
  expect(await read(t)).toEqual(before);
  const entered = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
  beforeCommit = async context => { if (context.tableSessionId === t.id && context.requestId === 'held-raise') { entered.resolve(); await release.promise; } };
  const raising = humanAct(t, 3, { type: 'raise', raiseTo: 57 }, 'held-raise'); await entered.promise;
  try { expect(await read(t)).toEqual(before); }
  finally { release.resolve(); beforeCommit = async () => {}; }
  expect((await raising).status).toBe(200);
  const committed = await read(t);
  expect(committed).toMatchObject({ pokerRevision: 4, sessionRevision: 4 });
  expect(committed.view.state.participants[0]).toMatchObject({ stack: 943, wager: 57, contribution: 57 });
  expect(await (await humanAct(t, 3, { type: 'raise', raiseTo: 57 }, 'held-raise')).json()).toMatchObject({ ok: true, pokerRevision: 4 });
  expect(await read(t)).toEqual(committed);
});

test('committed WebSocket views publish exact Bet/Raise intentions once and withhold the working size before COMMIT', async () => {
  const t = await table();
  const socket = new WebSocket(base.replace('http:', 'ws:') + '/api/table-sessions/' + t.id + '/live', { headers: { cookie: t.cookie } });
  const updates: ObservableTableUpdate[] = [];
  socket.on('message', data => { const message = JSON.parse(data.toString()); if (message.type === 'table-update') updates.push(message); });
  socket.on('error', () => {});
  const next = async (revision: number) => {
    await expect.poll(() => updates.find(update => update.sessionRevision === revision)).toBeDefined();
    return updates.find(update => update.sessionRevision === revision)!;
  };
  const entered = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
  try {
    await next(3);
    expect((await humanAct(t, 3, { type: 'raise', raiseTo: 53 })).status).toBe(200);
    const raise = await next(4);
    expect(raise.presentationEvents).toEqual([{ type: 'acted', participantId: t.human, action: { type: 'raise', raiseTo: 53 } }]);
    expect(raise.view.state.participants[0]).toMatchObject({ stack: 947, wager: 53, contribution: 53 });
    expect((await botAct(t, 4, { type: 'call' })).ok).toBe(true);
    expect((await botAct(t, 5, { type: 'check' })).ok).toBe(true);
    const flop = await next(6);
    expect(flop.view.state.legalActions).toEqual([{ type: 'fold' }, { type: 'check' }, { type: 'bet', minimum: 20, maximum: 947 }]);
    beforeCommit = async context => { if (context.tableSessionId === t.id && context.requestId === 'live-bet') { entered.resolve(); await release.promise; } };
    const betting = humanAct(t, 6, { type: 'bet', betTo: 37 }, 'live-bet'); await entered.promise;
    try { expect(await read(t)).toMatchObject({ pokerRevision: 6 }); expect(updates.some(update => update.sessionRevision === 7)).toBe(false); }
    finally { release.resolve(); beforeCommit = async () => {}; }
    expect((await betting).status).toBe(200);
    const bet = await next(7);
    expect(bet.presentationEvents).toEqual([{ type: 'acted', participantId: t.human, action: { type: 'bet', betTo: 37 } }]);
    expect(bet.view.state.participants[0]).toMatchObject({ stack: 910, wager: 37, contribution: 90 });
    expect(bet.view.state.participants[1]).not.toHaveProperty('holeCards');
    expect(JSON.stringify(bet)).not.toMatch(/"(?:seed|deck|burns|commands|drawnCardCount)"\s*:/);
    expect((await humanAct(t, 6, { type: 'bet', betTo: 37 }, 'live-bet')).status).toBe(200);
    expect(updates.filter(update => update.sessionRevision === 7)).toHaveLength(1);
  } finally { release.resolve(); beforeCommit = async () => {}; socket.terminate(); }
});
