import { afterAll, beforeAll, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { baselinePlayingStrategy } from '@poker/contracts';
import { createServer } from '../src/server.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('Set TEST_DATABASE_URL to a real PostgreSQL test database.');
const schema = 'test_' + randomUUID().replaceAll('-', '');
const administration = new Pool({ connectionString: databaseUrl });
let server: Awaited<ReturnType<typeof createServer>>;
let base: string;
let beforeCommit: (context: { tableSessionId: string; requestId: string }) => Promise<void> = async () => {};
beforeAll(async () => {
  await administration.query('CREATE SCHEMA "' + schema + '"');
  server = await createServer({ databaseUrl, schema, mutationTransactionFaults: { beforeCommit: context => beforeCommit(context) } });
  base = await server.listen({ host: '127.0.0.1', port: 0 });
});
afterAll(async () => { await server?.close(); await administration.query('DROP SCHEMA "' + schema + '" CASCADE'); await administration.end(); });
async function table() {
  const identity = await fetch(base + '/api/identity');
  const cookie = identity.headers.get('set-cookie')!.split(';')[0]!;
  const creation = await fetch(base + '/api/table-sessions', { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ requestId: randomUUID(), bots: [{ name: 'Bot', playingStrategy: baselinePlayingStrategy }] }) });
  const created = await creation.json();
  return { id: created.tableSessionId as string, cookie, human: created.bindings[0].participantId as string, bot: created.bindings[1].participantId as string };
}
type Table = Awaited<ReturnType<typeof table>>;
const submit = (t: Table, kind: string, body: unknown, cookie = t.cookie) => fetch(base + '/api/table-sessions/' + t.id + '/' + kind, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(body) });
const read = async (t: Table) => (await (await fetch(base + '/api/table-sessions/' + t.id, { headers: { cookie: t.cookie } })).json());
async function seated() {
  const t = await table();
  expect((await submit(t, 'seat-participant', { requestId: 'seat-human', expectedPokerRevision: 0, participantId: t.human, seat: 1 })).status).toBe(200);
  expect((await submit(t, 'seat-participant', { requestId: 'seat-bot', expectedPokerRevision: 1, participantId: t.bot, seat: 4 })).status).toBe(200);
  return t;
}

test('the owner starts a durable heads-up Hand, the bound human Folds, and restart preserves settlement and privacy', async () => {
  const t = await seated();
  const start = { requestId: 'start', expectedPokerRevision: 2 };
  expect(await (await submit(t, 'start-hand', start)).json()).toEqual({ ok: true, tableSessionId: t.id, pokerRevision: 3, sessionRevision: 3 });
  const decision = await read(t);
  expect(decision.view.state).toMatchObject({ status: 'active-hand', handId: 'hand-1', decisionId: 'hand-1/decision-1', actorId: t.human, legalActions: [{ type: 'fold' }, { type: 'call' }] });
  expect(decision.view.state.participants[0].holeCards).toHaveLength(2);
  expect(decision.view.state.participants[1]).not.toHaveProperty('holeCards');
  expect(JSON.stringify(decision)).not.toMatch(/"(?:seed|deck|burns|commands|ownerUserId|userId|schemaVersion|engineVersion|cards)"\s*:/);
  const fold = { requestId: 'fold', expectedPokerRevision: 3, participantId: t.human, action: { type: 'fold' } };
  expect(await (await submit(t, 'act', fold)).json()).toEqual({ ok: true, tableSessionId: t.id, pokerRevision: 4, sessionRevision: 4 });
  const completed = await read(t);
  expect(completed.view.state).toMatchObject({ status: 'completed-hand', actorId: null, board: [], returns: [{ participantId: t.bot, amount: 10 }], payouts: [{ participantId: t.bot, amount: 20 }] });
  expect(completed.view.state.participants.map((p: { stack: number }) => p.stack)).toEqual([990, 1010]);
  expect(completed.view.state.participants[1]).not.toHaveProperty('holeCards');
  expect(await (await submit(t, 'start-hand', start)).json()).toEqual({ ok: true, tableSessionId: t.id, pokerRevision: 3, sessionRevision: 3 });
  expect(await (await submit(t, 'act', fold)).json()).toEqual({ ok: true, tableSessionId: t.id, pokerRevision: 4, sessionRevision: 4 });
  expect(await read(t)).toEqual(completed);
  await server.close();
  server = await createServer({ databaseUrl, schema, mutationTransactionFaults: { beforeCommit: context => beforeCommit(context) } });
  base = await server.listen({ host: '127.0.0.1', port: 0 });
  expect(await read(t)).toEqual(completed);
});

test('owner management does not authorize browser actions as a Bot, and wrong human turns and active setup are atomic rejections', async () => {
  const t = await seated();
  const other = await table();
  const start = { requestId: 'owner-start', expectedPokerRevision: 2 };
  expect((await submit(t, 'start-hand', start, other.cookie)).status).toBe(404);
  expect((await submit(t, 'start-hand', start)).status).toBe(200);
  const decision = await read(t);
  const botAction = { requestId: 'impersonation', expectedPokerRevision: 3, participantId: t.bot, action: { type: 'fold' } };
  expect((await submit(t, 'act', botAction)).status).toBe(403);
  expect(await (await submit(t, 'act', botAction)).json()).toMatchObject({ ok: false, rejection: { code: 'actor-not-authorized' } });
  expect(await (await submit(t, 'start-hand', { requestId: 'already-active', expectedPokerRevision: 3 })).json()).toMatchObject({ ok: false, rejection: { code: 'active-hand' } });
  expect(await (await submit(t, 'seat-participant', { requestId: 'active-setup', expectedPokerRevision: 3, participantId: t.human, seat: 2 })).json()).toMatchObject({ ok: false, rejection: { code: 'active-hand' } });
  expect(await (await submit(t, 'act', { requestId: 'illegal-check', expectedPokerRevision: 3, participantId: t.human, action: { type: 'check' } })).json()).toMatchObject({ ok: false, rejection: { code: 'illegal-action' } });
  expect(await read(t)).toEqual(decision);
  await submit(t, 'act', { requestId: 'fold', expectedPokerRevision: 3, participantId: t.human, action: { type: 'fold' } });
  await submit(t, 'start-hand', { requestId: 'next-hand', expectedPokerRevision: 4 });
  const secondDecision = await read(t);
  expect(secondDecision.view.state).toMatchObject({ handId: 'hand-2', actorId: t.bot, legalActions: [] });
  expect(await (await submit(t, 'act', { requestId: 'wrong-human-turn', expectedPokerRevision: 5, participantId: t.human, action: { type: 'fold' } })).json()).toMatchObject({ ok: false, rejection: { code: 'wrong-actor' } });
  expect(await read(t)).toEqual(secondDecision);
});

test('Start Hand and Fold withhold every consequence until COMMIT and use the same FIFO as seating', async () => {
  const t = await seated();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  beforeCommit = async context => { if (context.tableSessionId === t.id && context.requestId === 'held-start') { entered.resolve(); await release.promise; } };
  const starting = submit(t, 'start-hand', { requestId: 'held-start', expectedPokerRevision: 2 });
  await entered.promise;
  let folding: Promise<Response>;
  try {
    const waiting = await read(t);
    expect(waiting).toMatchObject({ pokerRevision: 2, view: { state: { status: 'between-hands', actorId: null } } });
    expect(waiting.view.state.participants[0]).not.toHaveProperty('holeCards');
    folding = submit(t, 'act', { requestId: 'queued-fold', expectedPokerRevision: 3, participantId: t.human, action: { type: 'fold' } });
    expect(await read(t)).toEqual(waiting);
  } finally { release.resolve(); beforeCommit = async () => {}; }
  expect((await starting).status).toBe(200);
  expect((await folding!).status).toBe(200);
  expect(await read(t)).toMatchObject({ pokerRevision: 4, sessionRevision: 4, view: { state: { status: 'completed-hand', participants: [{ stack: 990 }, { stack: 1010 }] } } });
});

test('a confirmed rollback of dealing or Fold preserves the prior committed view and the same request can be explicitly retried', async () => {
  const t = await seated();
  for (const [kind, request] of [
    ['start-hand', { requestId: 'rollback-start', expectedPokerRevision: 2 }],
    ['act', { requestId: 'rollback-fold', expectedPokerRevision: 3, participantId: t.human, action: { type: 'fold' } }],
  ] as const) {
    const before = await read(t);
    beforeCommit = async () => { throw new Error('controlled PostgreSQL rollback'); };
    try { expect((await submit(t, kind, request)).status).toBe(503); expect(await read(t)).toEqual(before); }
    finally { beforeCommit = async () => {}; }
    expect((await submit(t, kind, request)).status).toBe(200);
  }
  expect(await read(t)).toMatchObject({ pokerRevision: 4, sessionRevision: 4, view: { state: { handId: 'hand-1', status: 'completed-hand', participants: [{ stack: 990 }, { stack: 1010 }] } } });
});
