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
let afterCommit: () => Promise<void> = async () => {};
beforeAll(async () => {
  await administration.query('CREATE SCHEMA "' + schema + '"');
  server = await createServer({ automaticBots: false, databaseUrl, schema, mutationTransactionFaults: { beforeCommit: context => beforeCommit(context), afterCommit: () => afterCommit() } });
  base = await server.listen({ host: '127.0.0.1', port: 0 });
});
afterAll(async () => {
  await server?.close();
  await administration.query('DROP SCHEMA "' + schema + '" CASCADE');
  await administration.end();
});
async function table() {
  const identity = await fetch(base + '/api/identity');
  const cookie = identity.headers.get('set-cookie')!.split(';')[0]!;
  const response = await fetch(base + '/api/table-sessions', {
    method: 'POST', headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ requestId: randomUUID(), bots: [{ name: 'Bot', playingStrategy: baselinePlayingStrategy }] }),
  });
  const result = await response.json();
  return { id: result.tableSessionId as string, cookie, human: result.bindings[0].participantId as string, bot: result.bindings[1].participantId as string };
}
type Table = Awaited<ReturnType<typeof table>>;
const submit = (t: Table, requestId: string, participantId = t.human, seat = 1, expectedPokerRevision = 0) => fetch(base + '/api/table-sessions/' + t.id + '/seat-participant', {
  method: 'POST', headers: { 'content-type': 'application/json', cookie: t.cookie }, body: JSON.stringify({ requestId, participantId, seat, expectedPokerRevision }),
});
const read = async (t: Table) => (await (await fetch(base + '/api/table-sessions/' + t.id, { headers: { cookie: t.cookie } })).json());
const within = <T>(promise: Promise<T>) => Promise.race([promise, new Promise<undefined>(resolve => setTimeout(() => resolve(undefined), 1000))]);

test('held COMMIT withholds the working view, same-session mutations remain FIFO, and another session commits independently', async () => {
  const first = await table();
  const other = await table();
  const entered = Promise.withResolvers<boolean>();
  const release = Promise.withResolvers<void>();
  beforeCommit = async context => { if (context.tableSessionId === first.id && context.requestId === 'held') { entered.resolve(true); await release.promise; } };
  const held = submit(first, 'held');
  let queued: Promise<Response> | undefined;
  try {
    expect(await within(entered.promise)).toBe(true);
    expect(await read(first)).toMatchObject({ pokerRevision: 0, sessionRevision: 0, view: { state: { participants: [] } } });
    queued = submit(first, 'next', first.bot, 2, 1);
    const independent = await within(submit(other, 'independent'));
    expect(independent?.status).toBe(200);
    expect(await read(first)).toMatchObject({ pokerRevision: 0, sessionRevision: 0, view: { state: { participants: [] } } });
  } finally { release.resolve(); beforeCommit = async () => {}; }
  expect((await held).status).toBe(200);
  expect((await queued!).status).toBe(200);
  expect(await read(first)).toMatchObject({ pokerRevision: 2, sessionRevision: 2, view: { state: { participants: [
    { participantId: first.human, seat: 1, stack: 1000 }, { participantId: first.bot, seat: 2, stack: 1000 },
  ] } } });
});

test('confirmed rollback leaves committed seating and revisions unchanged and stores no definitive outcome', async () => {
  const t = await table();
  const before = await read(t);
  beforeCommit = async () => { throw new Error('controlled PostgreSQL rollback before COMMIT'); };
  try {
    const response = await submit(t, 'rollback');
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ ok: false, rejection: { code: 'persistence-unavailable' } });
    expect(await read(t)).toEqual(before);
  } finally { beforeCommit = async () => {}; }
  expect((await submit(t, 'rollback')).status).toBe(200);
  expect(await read(t)).toMatchObject({ pokerRevision: 1, sessionRevision: 1 });
});

test('lost COMMIT confirmation pauses submissions without promoting or blindly re-executing until durable restoration', async () => {
  const t = await table();
  const before = await read(t);
  afterCommit = async () => { throw new Error('controlled lost COMMIT confirmation'); };
  try {
    const ambiguous = await submit(t, 'ambiguous');
    expect(ambiguous.status).toBe(503);
    expect(await ambiguous.json()).toMatchObject({ ok: false, rejection: { code: 'commit-outcome-unknown' } });
    expect(await read(t)).toEqual(before);
  } finally { afterCommit = async () => {}; }
  expect(await (await submit(t, 'new-after-unknown', t.bot, 2, 1)).json()).toMatchObject({ ok: false, rejection: { code: 'session-recovering' } });
  expect(await (await submit(t, 'ambiguous')).json()).toMatchObject({ ok: false, rejection: { code: 'session-recovering' } });
  await server.close();
  server = await createServer({ automaticBots: false, databaseUrl, schema });
  base = await server.listen({ host: '127.0.0.1', port: 0 });
  expect(await read(t)).toMatchObject({ pokerRevision: 1, sessionRevision: 1, view: { state: { participants: [{ participantId: t.human, seat: 1, stack: 1000 }] } } });
  expect(await (await submit(t, 'ambiguous')).json()).toEqual({ ok: true, tableSessionId: t.id, pokerRevision: 1, sessionRevision: 1 });
  expect(await read(t)).toMatchObject({ pokerRevision: 1, sessionRevision: 1 });
});
