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
beforeAll(async () => {
  await administration.query('CREATE SCHEMA "' + schema + '"');
  server = await createServer({ automaticBots: false, databaseUrl, schema });
  base = await server.listen({ host: '127.0.0.1', port: 0 });
});
afterAll(async () => {
  await server?.close();
  await administration.query('DROP SCHEMA "' + schema + '" CASCADE');
  await administration.end();
});
async function newTable() {
  const identity = await fetch(base + '/api/identity');
  const cookie = identity.headers.get('set-cookie')!.split(';')[0]!;
  const creation = await fetch(base + '/api/table-sessions', {
    method: 'POST', headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ requestId: randomUUID(), bots: [{ name: 'Bot', playingStrategy: baselinePlayingStrategy }] }),
  });
  const created = await creation.json();
  return { cookie, id: created.tableSessionId as string, human: created.bindings[0].participantId as string, bot: created.bindings[1].participantId as string };
}
type Table = Awaited<ReturnType<typeof newTable>>;
const submit = (table: Table, body: unknown, cookie = table.cookie) => fetch(base + '/api/table-sessions/' + table.id + '/seat-participant', {
  method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(body),
});
const read = async (table: Table) => (await (await fetch(base + '/api/table-sessions/' + table.id, { headers: { cookie: table.cookie } })).json());

test('the owner seats a bound Participant durably with both revisions advancing once and restart restores the seat', async () => {
  const table = await newTable();
  const response = await submit(table, { requestId: 'human-seat', expectedPokerRevision: 0, participantId: table.human, seat: 2 });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true, tableSessionId: table.id, pokerRevision: 1, sessionRevision: 1 });
  const committed = await read(table);
  expect(committed).toMatchObject({ pokerRevision: 1, sessionRevision: 1, view: { state: { participants: [{ participantId: table.human, seat: 2, stack: 1000, sittingOut: false }] } } });
  expect(JSON.stringify(committed)).not.toMatch(/"(?:seed|commands|ownerUserId|schemaVersion|engineVersion)"\s*:/);
  await server.close();
  server = await createServer({ automaticBots: false, databaseUrl, schema });
  base = await server.listen({ host: '127.0.0.1', port: 0 });
  expect(await read(table)).toEqual(committed);
  expect(await (await submit(table, { requestId: 'human-seat', expectedPokerRevision: 0, participantId: table.human, seat: 2 })).json()).toEqual({ ok: true, tableSessionId: table.id, pokerRevision: 1, sessionRevision: 1 });
});

test('concurrent matching requests seat once and canonical key ordering does not change the fingerprint', async () => {
  const table = await newTable();
  const request = { requestId: 'concurrent', expectedPokerRevision: 0, participantId: table.human, seat: 1 };
  const responses = await Promise.all([submit(table, request), submit(table, { seat: 1, participantId: table.human, expectedPokerRevision: 0, requestId: 'concurrent' })]);
  expect(responses.map(r => r.status)).toEqual([200, 200]);
  const [first, duplicate] = await Promise.all(responses.map(r => r.json()));
  expect(duplicate).toEqual(first);
  expect(await read(table)).toMatchObject({ pokerRevision: 1, sessionRevision: 1, view: { state: { participants: [{ participantId: table.human, seat: 1, stack: 1000 }] } } });
});

test('matching success and domain-rejection retries return the original small outcome before checking a later revision', async () => {
  const table = await newTable();
  const accepted = { requestId: 'accepted', expectedPokerRevision: 0, participantId: table.human, seat: 2 };
  const original = await (await submit(table, accepted)).json();
  const rejected = { requestId: 'occupied', expectedPokerRevision: 1, participantId: table.bot, seat: 2 };
  const domainRejection = await (await submit(table, rejected)).json();
  expect(domainRejection).toMatchObject({ ok: false, rejection: { code: 'seat-occupied' } });
  expect((await submit(table, { requestId: 'bot', expectedPokerRevision: 1, participantId: table.bot, seat: 4 })).status).toBe(200);
  expect(await (await submit(table, accepted)).json()).toEqual(original);
  expect(await (await submit(table, rejected)).json()).toEqual(domainRejection);
  expect(original).not.toHaveProperty('view');
  expect(await read(table)).toMatchObject({ pokerRevision: 2, sessionRevision: 2 });
  const conflict = await submit(table, { ...accepted, seat: 3 });
  expect(conflict.status).toBe(409);
  expect(await conflict.json()).toMatchObject({ ok: false, rejection: { code: 'request-id-conflict' } });
});

test('a stale unprocessed expectation is remembered without invoking seating or advancing revisions', async () => {
  const table = await newTable();
  await submit(table, { requestId: 'first', expectedPokerRevision: 0, participantId: table.human, seat: 1 });
  const stale = { requestId: 'stale', expectedPokerRevision: 0, participantId: table.bot, seat: 2 };
  const response = await submit(table, stale);
  expect(response.status).toBe(409);
  const rejection = await response.json();
  expect(rejection).toMatchObject({ ok: false, rejection: { code: 'stale-poker-revision' } });
  await submit(table, { ...stale, requestId: 'fresh', expectedPokerRevision: 1 });
  expect(await (await submit(table, stale)).json()).toEqual(rejection);
  expect(await read(table)).toMatchObject({ pokerRevision: 2, sessionRevision: 2 });
});

test('only the Table Owner can seat an assigned Participant and unassigned identities are rejected', async () => {
  const table = await newTable();
  const stranger = await newTable();
  const request = { requestId: 'owner-only', expectedPokerRevision: 0, participantId: table.human, seat: 1 };
  expect((await submit(table, request, stranger.cookie)).status).toBe(404);
  const anonymous = await fetch(base + '/api/table-sessions/' + table.id + '/seat-participant', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request),
  });
  expect(anonymous.status).toBe(401);
  const unassigned = { ...request, requestId: 'unassigned', participantId: stranger.human };
  expect(await (await submit(table, unassigned)).json()).toMatchObject({ ok: false, rejection: { code: 'participant-not-bound' } });
  expect(await read(table)).toMatchObject({ pokerRevision: 0, sessionRevision: 0, view: { state: { participants: [] } } });
  expect((await submit(table, request)).status).toBe(200);
});

test.each([
  { expectedPokerRevision: -1 }, { expectedPokerRevision: 0.5 },
  { ownerUserId: 'injected' }, { seed: 'injected' }, { type: 'start-hand' },
])('invalid application mutation contents are retained outside the poker record: %j', async invalid => {
  const table = await newTable();
  const request = { requestId: randomUUID(), expectedPokerRevision: 0, participantId: table.human, seat: 1, ...invalid };
  const rejection = await (await submit(table, request)).json();
  expect(rejection).toMatchObject({ ok: false, rejection: { code: 'invalid-mutation-request' } });
  expect(await (await submit(table, request)).json()).toEqual(rejection);
  expect((await submit(table, { ...request, seat: 2 })).status).toBe(409);
  expect(await read(table)).toMatchObject({ pokerRevision: 0, sessionRevision: 0 });
});
