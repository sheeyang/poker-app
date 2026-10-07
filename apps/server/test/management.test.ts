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
async function table(allowSeatChanges = true) {
  const identity = await fetch(base + '/api/identity');
  const cookie = identity.headers.get('set-cookie')!.split(';')[0]!;
  const response = await fetch(base + '/api/table-sessions', { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ requestId: randomUUID(), configuration: { minimumBuyIn: 100, maximumBuyIn: 2000, allowSeatChanges }, bots: [{ name: 'Bot', playingStrategy: baselinePlayingStrategy }] }) });
  const created = await response.json();
  return { id: created.tableSessionId as string, cookie, human: created.bindings[0].participantId as string, bot: created.bindings[1].participantId as string };
}
type Table = Awaited<ReturnType<typeof table>>;
const submit = (t: Table, kind: string, body: unknown, cookie = t.cookie) => fetch(base + '/api/table-sessions/' + t.id + '/' + kind, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(body) });
const read = async (t: Table) => (await (await fetch(base + '/api/table-sessions/' + t.id, { headers: { cookie: t.cookie } })).json());
async function completed(allowSeatChanges = true) {
  const t = await table(allowSeatChanges);
  for (const [kind, body] of [
    ['seat-participant', { participantId: t.human, seat: 1 }], ['seat-participant', { participantId: t.bot, seat: 4 }],
    ['start-hand', {}], ['act', { participantId: t.human, action: { type: 'fold' } }],
  ] as const) expect((await submit(t, kind, { ...body, requestId: randomUUID(), expectedPokerRevision: (await read(t)).pokerRevision })).status).toBe(200);
  return t;
}

test('owner management commits and retries exactly once through the durable poker path while retaining identity and history', async () => {
  const t = await completed();
  const initial = await read(t);
  const operations = [
    ['leave-participant', { participantId: t.bot }], ['seat-participant', { participantId: t.bot, seat: 2, buyIn: 100 }],
    ['top-up-to', { participantId: t.human, targetStack: 1200 }], ['move-participant', { participantId: t.human, seat: 3 }],
    ['set-sitting-out', { participantId: t.bot, sittingOut: true }], ['set-sitting-out', { participantId: t.bot, sittingOut: false }], ['set-button', { seat: 3 }],
  ] as const;
  for (const [index, [kind, body]] of operations.entries()) {
    const request = { ...body, requestId: 'manage-' + index, expectedPokerRevision: 4 + index };
    const outcome = { ok: true, tableSessionId: t.id, pokerRevision: 5 + index, sessionRevision: 5 + index };
    expect(await (await submit(t, kind, request)).json()).toEqual(outcome);
    expect(await (await submit(t, kind, request)).json()).toEqual(outcome);
  }
  const managed = await read(t);
  expect(managed).toMatchObject({ pokerRevision: 11, sessionRevision: 11, view: { state: { buttonSeat: 3, participants: [{ participantId: t.human, seat: 3, stack: 1200 }, { participantId: t.bot, seat: 2, stack: 100 }] } } });
  expect(managed.view.history).toEqual(initial.view.history);
  await server.close(); server = await createServer({ databaseUrl: databaseUrl!, schema, mutationTransactionFaults: { beforeCommit: context => beforeCommit(context) } }); base = await server.listen({ host: '127.0.0.1', port: 0 });
  expect(await read(t)).toEqual(managed);
  expect((await submit(t, 'start-hand', { requestId: 'next', expectedPokerRevision: 11 })).status).toBe(200);
  expect((await read(t)).view.state.buttonSeat).toBe(3);
});

test('owner-only management rejects active, stale, unsupported and disabled-policy attempts without changing committed state or retries', async () => {
  const t = await completed(false);
  const stranger = await table(); const initial = await read(t);
  const commands = [
    ['leave-participant', { participantId: t.human }], ['move-participant', { participantId: t.human, seat: 2 }],
    ['set-sitting-out', { participantId: t.human, sittingOut: true }], ['top-up-to', { participantId: t.human, targetStack: 1200 }], ['set-button', { seat: 4 }],
  ] as const;
  for (const [index, [kind, body]] of commands.entries()) expect((await submit(t, kind, { ...body, requestId: 'foreign-' + index, expectedPokerRevision: 4 }, stranger.cookie)).status).toBe(404);
  expect(await read(t)).toEqual(initial);
  const disabled = { requestId: 'disabled', expectedPokerRevision: 4, participantId: t.human, seat: 2 };
  const rejection = await (await submit(t, 'move-participant', disabled)).json();
  expect(rejection).toMatchObject({ ok: false, rejection: { code: 'seat-changes-disabled' } });
  expect(await (await submit(t, 'move-participant', disabled)).json()).toEqual(rejection);
  expect((await submit(t, 'move-participant', { ...disabled, seat: 3 })).status).toBe(409);
  expect((await submit(t, 'top-up-to', { requestId: 'stale', expectedPokerRevision: 0, participantId: t.human, targetStack: 1200 })).status).toBe(409);
  expect((await submit(t, 'top-up-to', { requestId: 'unknown-field', expectedPokerRevision: 4, participantId: t.human, targetStack: 1200, stack: 1200 })).status).toBe(400);
  expect(await read(t)).toEqual(initial);
  expect((await submit(t, 'set-button', { requestId: 'button', expectedPokerRevision: 4, seat: 1 })).status).toBe(200);
  expect((await submit(t, 'start-hand', { requestId: 'active', expectedPokerRevision: 5 })).status).toBe(200);
  const active = await read(t);
  for (const [index, [kind, body]] of commands.entries()) {
    const request = { ...body, requestId: 'active-' + index, expectedPokerRevision: 6 };
    const rejected = await (await submit(t, kind, request)).json();
    expect(rejected).toMatchObject({ ok: false, rejection: { code: 'active-hand' } });
    expect(await (await submit(t, kind, request)).json()).toEqual(rejected);
  }
  expect(await read(t)).toEqual(active);
  expect(await (await submit(t, 'move-participant', disabled)).json()).toEqual(rejection);
});

test('PostgreSQL rollback and held COMMIT withhold management state, identity, history and revisions in the shared FIFO', async () => {
  const t = await completed();
  const initial = await read(t);
  const operations = [
    ['leave-participant', { participantId: t.bot }], ['seat-participant', { participantId: t.bot, seat: 2 }],
    ['move-participant', { participantId: t.human, seat: 3 }], ['set-sitting-out', { participantId: t.bot, sittingOut: true }],
    ['top-up-to', { participantId: t.human, targetStack: 1200 }], ['set-button', { seat: 3 }],
  ] as const;
  for (const [index, [kind, body]] of operations.entries()) {
    const before = await read(t); const request = { ...body, requestId: 'rollback-' + index, expectedPokerRevision: 4 + index };
    beforeCommit = async () => { throw new Error('controlled management rollback'); };
    try { expect((await submit(t, kind, request)).status).toBe(503); expect(await read(t)).toEqual(before); }
    finally { beforeCommit = async () => {}; }
    expect((await submit(t, kind, request)).status).toBe(200);
  }
  expect((await read(t)).view.history).toEqual(initial.view.history);
  const entered = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
  beforeCommit = async context => { if (context.requestId === 'held-management') { entered.resolve(); await release.promise; } };
  const held = submit(t, 'set-sitting-out', { requestId: 'held-management', expectedPokerRevision: 10, participantId: t.bot, sittingOut: false });
  let next: Promise<Response> | undefined;
  try {
    await entered.promise; const before = await read(t);
    next = submit(t, 'start-hand', { requestId: 'queued-start', expectedPokerRevision: 11 });
    expect(await read(t)).toEqual(before);
    expect(before.view.state.participants[1].sittingOut).toBe(true);
    expect(before).toMatchObject({ pokerRevision: 10, sessionRevision: 10 });
  } finally { release.resolve(); beforeCommit = async () => {}; }
  expect((await held).status).toBe(200); expect((await next!).status).toBe(200);
  expect(await read(t)).toMatchObject({ pokerRevision: 12, sessionRevision: 12, view: { state: { status: 'active-hand', buttonSeat: 3 } } });
});
