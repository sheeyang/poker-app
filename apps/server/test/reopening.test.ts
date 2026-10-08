import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import WebSocket from 'ws';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { baselinePlayingStrategy, type ConcreteAction, type ObservableGameConfiguration, type ObservableTableSession, type ObservableTableUpdate, type TableLiveMessage } from '@poker/contracts';
import { createServer } from '../src/server.js';
import type { TableSessionControllerCommands } from '../src/mutations.js';

// Randomness is a system boundary. Only creation's seed draw is fixed; identity
// cookies and UUIDs retain real entropy. No game state or durable record is injected.
const randomness = vi.hoisted(() => ({ seed: undefined as string | undefined }));
vi.mock('node:crypto', async importOriginal => {
  const original = await importOriginal<typeof import('node:crypto')>();
  return { ...original, randomBytes: (size: number) => {
    if (randomness.seed === undefined) return original.randomBytes(size);
    if (size !== 32) throw new Error('Expected only the creation seed draw.');
    const bytes = Buffer.from(randomness.seed, 'hex'); randomness.seed = undefined; return bytes;
  } };
});

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('Set TEST_DATABASE_URL to a real PostgreSQL test database.');
const schema = 'test_' + randomUUID().replaceAll('-', '');
const administration = new Pool({ connectionString: databaseUrl });
let server: Awaited<ReturnType<typeof createServer>>;
let base: string;
let controllers: TableSessionControllerCommands;
let beforeCommit: (context: { tableSessionId: string; requestId: string }) => Promise<void> = async () => {};
async function startServer() {
  server = await createServer({ databaseUrl: databaseUrl!, schema, onControllerCommandsReady: commands => { controllers = commands; }, mutationTransactionFaults: { beforeCommit: context => beforeCommit(context) } });
  base = await server.listen({ host: '127.0.0.1', port: 0 });
}
beforeAll(async () => { await administration.query('CREATE SCHEMA "' + schema + '"'); await startServer(); });
afterAll(async () => { await server?.close(); await administration.query('DROP SCHEMA "' + schema + '" CASCADE'); await administration.end(); });
type Table = { id: string; cookie: string; ids: string[]; revision: number };
async function table(count: number, configuration: Partial<ObservableGameConfiguration> = {}, seed = '0'.repeat(64)): Promise<Table> {
  const identity = await fetch(base + '/api/identity'); const cookie = identity.headers.get('set-cookie')!.split(';')[0]!;
  randomness.seed = seed;
  let response: Response;
  try { response = await fetch(base + '/api/table-sessions', { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ requestId: randomUUID(), configuration: { seatCount: 9, minimumBuyIn: 1, defaultBuyIn: 1000, maximumBuyIn: 2000, ...configuration }, bots: Array.from({ length: count - 1 }, (_, i) => ({ name: 'Bot ' + (i + 1), playingStrategy: baselinePlayingStrategy })) }) }); }
  finally { randomness.seed = undefined; }
  expect(response.status).toBe(201); const created = await response.json();
  return { id: created.tableSessionId, cookie, ids: created.bindings.map((b: { participantId: string }) => b.participantId), revision: 0 };
}
const submit = (t: Table, kind: string, fields: object, requestId: string = randomUUID()) => fetch(base + '/api/table-sessions/' + t.id + '/' + kind, { method: 'POST', headers: { 'content-type': 'application/json', cookie: t.cookie }, body: JSON.stringify({ requestId, expectedPokerRevision: t.revision, ...fields }) });
const read = async (t: Table): Promise<ObservableTableSession> => (await (await fetch(base + '/api/table-sessions/' + t.id, { headers: { cookie: t.cookie } })).json());
async function command(t: Table, kind: string, fields: object = {}) {
  const response = await submit(t, kind, fields); expect(response.status).toBe(200);
  const result = await response.json(); expect(result.ok).toBe(true); t.revision = result.pokerRevision; return result;
}
async function act(t: Table, id: string, action: ConcreteAction) {
  if (id === t.ids[0]) return command(t, 'act', { participantId: id, action });
  const result = await controllers.submitAction(t.id, { requestId: randomUUID(), expectedPokerRevision: t.revision, participantId: id, action });
  expect(result).toMatchObject({ ok: true, pokerRevision: t.revision + 1 }); if (!result.ok) throw new Error(result.rejection.code); t.revision = result.pokerRevision; return result;
}
function connect(t: Table) {
  const socket = new WebSocket(base.replace('http:', 'ws:') + '/api/table-sessions/' + t.id + '/live', { headers: { cookie: t.cookie } });
  const messages: TableLiveMessage[] = []; socket.on('message', data => messages.push(JSON.parse(data.toString())));
  return { socket, messages, async next(revision: number) {
    await expect.poll(() => messages.some(m => m.type === 'table-update' && m.sessionRevision === revision)).toBe(true);
    return messages.find((m): m is ObservableTableUpdate => m.type === 'table-update' && m.sessionRevision === revision)!;
  } };
}

type Role = 'a' | 'b' | 'c' | 'd' | 'e';
async function fixture(price = 200, human: Role = 'a', opening = false) {
  const t = await table(5);
  const roles: Role[] = [human, ...(['a', 'b', 'c', 'd', 'e'] as const).filter(role => role !== human)];
  const ids = Object.fromEntries(roles.map((role, i) => [role, t.ids[i]!])) as Record<Role, string>;
  for (const [role, seat, buyIn] of [['e', 1, 1000], ['a', 2, 1000], ['b', 3, opening ? 25 : 170], ['c', 4, opening ? 35 : 1000], ['d', 5, price + 20]] as const)
    await command(t, 'seat-participant', { participantId: ids[role], seat, buyIn });
  await command(t, 'start-hand');
  for (const role of ['c', 'd', 'e', 'a'] as const) await act(t, ids[role], { type: 'call' });
  await act(t, ids.b, { type: 'check' });
  await act(t, ids.a, opening ? { type: 'check' } : { type: 'bet', betTo: 100 });
  await act(t, ids.b, opening ? { type: 'bet', betTo: 5 } : { type: 'raise', raiseTo: 150 });
  await act(t, ids.c, opening ? { type: 'raise', raiseTo: 15 } : { type: 'call' });
  return { t, ids };
}
async function finish(t: Table) {
  for (;;) {
    const current = await read(t); const state = current.view.state;
    if (state.status === 'completed-hand') return current;
    const member = state.participants.find(p => p.participantId === state.actorId)!;
    const price = Math.max(...state.participants.map(p => p.wager ?? 0));
    await act(t, state.actorId!, { type: (member.wager ?? 0) < price ? 'call' : 'check' });
  }
}

test.each([[199, 99, undefined], [200, 100, 300], [201, 101, 301]] as const)('serialized human options at cumulative price %i agree with closed rejection or exact reopened minimum', async (price, owed, minimum) => {
  const { t, ids } = await fixture(price);
  await act(t, ids.d, { type: 'raise', raiseTo: price }); await act(t, ids.e, { type: 'fold' });
  const before = await read(t); const live = connect(t);
  try {
    const initial = await live.next(t.revision);
    expect(initial.view).toEqual(before.view);
    expect(before.view.state).toMatchObject({ actorId: ids.a, amountToCall: owed, legalActions: [{ type: 'fold' }, { type: 'call' }, ...(minimum ? [{ type: 'raise', minimum, maximum: 980 }] : [])] });
    const rejectedSize = minimum ? minimum - 1 : 299;
    const rejectedFields = { expectedPokerRevision: t.revision, participantId: ids.a, action: { type: 'raise', raiseTo: rejectedSize } };
    const rejected = await (await submit(t, 'act', rejectedFields, 'rejected-raise')).json();
    expect(rejected).toMatchObject({ ok: false, rejection: { code: minimum ? 'illegal-action-size' : 'illegal-action' } });
    expect(await read(t)).toEqual(before); expect(live.messages).toHaveLength(1);
    const stale = await fetch(base + '/api/table-sessions/' + t.id + '/act', { method: 'POST', headers: { 'content-type': 'application/json', cookie: t.cookie }, body: JSON.stringify({ requestId: 'stale-raise', expectedPokerRevision: t.revision - 1, participantId: ids.a, action: { type: 'raise', raiseTo: minimum ?? 299 } }) });
    expect(stale.status).toBe(409); expect(await read(t)).toEqual(before);
    const acceptedFields = { expectedPokerRevision: t.revision, participantId: ids.a, action: minimum ? { type: 'raise', raiseTo: minimum } : { type: 'call' } };
    const acceptedRevision = t.revision + 1;
    const response = await submit(t, 'act', acceptedFields, 'human-reopened'); expect(response.status).toBe(200); t.revision = acceptedRevision;
    const committed = await read(t); expect((await live.next(acceptedRevision)).view).toEqual(committed.view);
    const done = await finish(t);
    expect(done.view.state.status).toBe('completed-hand');
    expect(done.view.state.participants.reduce((sum, p) => sum + p.stack, 0)).toBe(3190 + price);
    expect(done.view.history[0]!.decisions.some(d => JSON.stringify(d.state) === JSON.stringify(before.view.state))).toBe(true);
    expect(done.view.history[0]!.decisions.every(d => d.state.participants.filter(p => p.holeCards).length === 1)).toBe(true);
    expect(await (await submit(t, 'act', acceptedFields, 'human-reopened')).json()).toMatchObject({ ok: true, pokerRevision: acceptedRevision });
    expect(await (await submit(t, 'act', rejectedFields, 'rejected-raise')).json()).toEqual(rejected);
    expect(await read(t)).toEqual(done);
    expect(JSON.stringify(done)).not.toMatch(/"(?:seed|deck|burns|commands|drawnCardCount)"\s*:/);
    live.socket.terminate(); await server.close(); await startServer(); expect(await read(t)).toEqual(done);
  } finally { live.socket.terminate(); }
});

test('reopened human Raise is visible only after commit and a rolled-back attempt changes no cards, chips, history, or revisions', async () => {
  const { t, ids } = await fixture();
  await act(t, ids.d, { type: 'raise', raiseTo: 200 }); await act(t, ids.e, { type: 'fold' });
  const before = await read(t); const live = connect(t); const requestId = 'held-reopened-raise';
  const fields = { expectedPokerRevision: t.revision, participantId: ids.a, action: { type: 'raise', raiseTo: 300 } };
  const entered = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>(); let held: Promise<Response> | undefined;
  try {
    await live.next(t.revision);
    beforeCommit = async context => { if (context.requestId === requestId) throw new Error('controlled reopening rollback'); };
    expect((await submit(t, 'act', fields, requestId)).status).toBe(503);
    expect(await read(t)).toEqual(before); expect(live.messages).toHaveLength(1);
    beforeCommit = async context => { if (context.requestId === requestId) { entered.resolve(); await release.promise; } };
    held = submit(t, 'act', fields, requestId); await entered.promise;
    expect(await read(t)).toEqual(before); expect(live.messages).toHaveLength(1);
    release.resolve(); expect((await held).status).toBe(200); beforeCommit = async () => {};
    t.revision++;
    const committed = await read(t); const update = await live.next(t.revision);
    expect(update.view).toEqual(committed.view);
    expect(committed.view.state.participants.find(p => p.participantId === ids.a)).toMatchObject({ stack: 680, contribution: 320, wager: 300 });
    expect(update.presentationEvents).toEqual([{ type: 'acted', participantId: ids.a, action: { type: 'raise', raiseTo: 300 } }]);
    const done = await finish(t); expect(done.view.state.participants.reduce((sum, p) => sum + p.stack, 0)).toBe(3390);
    expect(await (await submit(t, 'act', fields, requestId)).json()).toMatchObject({ ok: true, pokerRevision: before.pokerRevision + 1 });
    expect(await read(t)).toEqual(done);
    live.socket.terminate(); await server.close(); await startServer(); expect(await read(t)).toEqual(done);
  } finally { release.resolve(); beforeCommit = async () => {}; await held; live.socket.terminate(); }
});

test('a human who called at the later price remains closed when the earlier bettor is reopened', async () => {
  const { t, ids } = await fixture(200, 'c');
  await act(t, ids.d, { type: 'raise', raiseTo: 200 }); await act(t, ids.e, { type: 'fold' }); await act(t, ids.a, { type: 'call' });
  const before = await read(t);
  expect(before.view.state).toMatchObject({ actorId: ids.c, amountToCall: 50, legalActions: [{ type: 'fold' }, { type: 'call' }] });
  expect((await submit(t, 'act', { participantId: ids.c, action: { type: 'raise', raiseTo: 300 } })).status).toBe(400);
  expect(await read(t)).toEqual(before);
  await act(t, ids.c, { type: 'call' });
  expect((await read(t)).view.state.street).toBe('turn');
  const done = await finish(t); expect(done.view.state.participants.reduce((sum, p) => sum + p.stack, 0)).toBe(3390);
});

test('unacted human rights and a genuine singleton short-all-in Raise use their exact serialized sizes', async () => {
  const unacted = await fixture(199, 'e');
  await act(unacted.t, unacted.ids.d, { type: 'raise', raiseTo: 199 });
  const before = await read(unacted.t);
  expect(before.view.state).toMatchObject({ actorId: unacted.ids.e, amountToCall: 199, legalActions: [{ type: 'fold' }, { type: 'call' }, { type: 'raise', minimum: 299, maximum: 980 }] });
  expect((await submit(unacted.t, 'act', { participantId: unacted.ids.e, action: { type: 'raise', raiseTo: 298 } })).status).toBe(400); expect(await read(unacted.t)).toEqual(before);
  await act(unacted.t, unacted.ids.e, { type: 'raise', raiseTo: 299 });
  expect((await finish(unacted.t)).view.state.participants.reduce((sum, p) => sum + p.stack, 0)).toBe(3389);

  const short = await fixture(199, 'd'); const singleton = await read(short.t);
  expect(singleton.view.state).toMatchObject({ actorId: short.ids.d, amountToCall: 150, legalActions: [{ type: 'fold' }, { type: 'call' }, { type: 'raise', minimum: 199, maximum: 199 }] });
  expect((await submit(short.t, 'act', { participantId: short.ids.d, action: { type: 'raise', raiseTo: 198 } })).status).toBe(400); expect(await read(short.t)).toEqual(singleton);
  await act(short.t, short.ids.d, { type: 'raise', raiseTo: 199 });
  expect((await read(short.t)).view.state.participants.find(p => p.participantId === short.ids.d)).toMatchObject({ stack: 0, allIn: true });
  expect((await finish(short.t)).view.state.participants.reduce((sum, p) => sum + p.stack, 0)).toBe(3389);
});

test.each([[19, false], [20, true]] as const)('a serialized human Check followed by incomplete opening price %i preserves the full-bet threshold', async (price, reopened) => {
  const { t, ids } = await fixture(price, 'a', true);
  await act(t, ids.d, { type: 'raise', raiseTo: price }); await act(t, ids.e, { type: 'call' });
  const before = await read(t);
  expect(before.view.state).toMatchObject({ actorId: ids.a, amountToCall: price, legalActions: [{ type: 'fold' }, { type: 'call' }, ...(reopened ? [{ type: 'raise', minimum: 40, maximum: 980 }] : [])] });
  expect((await submit(t, 'act', { participantId: ids.a, action: { type: 'raise', raiseTo: 39 } })).status).toBe(400); expect(await read(t)).toEqual(before);
  await act(t, ids.a, reopened ? { type: 'raise', raiseTo: 40 } : { type: 'call' });
  const done = await finish(t); expect(done.view.state.participants.reduce((sum, p) => sum + p.stack, 0)).toBe(2080 + price);
});
