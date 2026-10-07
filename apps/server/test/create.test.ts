import { afterAll, beforeAll, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { createServer } from '../src/server.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('Set TEST_DATABASE_URL to a real PostgreSQL test database.');
const schema = 'test_' + randomUUID().replaceAll('-', '');
const administration = new Pool({ connectionString: databaseUrl });
let server: Awaited<ReturnType<typeof createServer>>;
let base: string;
let cookie: string;
let tableSessionId: string;

beforeAll(async () => {
  await administration.query('CREATE SCHEMA "' + schema + '"');
  server = await createServer({ databaseUrl, schema });
  base = await server.listen({ host: '127.0.0.1', port: 0 });
});
afterAll(async () => {
  await server?.close();
  await administration.query('DROP SCHEMA "' + schema + '" CASCADE');
  await administration.end();
});

test('an owned empty Table Session persists and reopens with the same binding after server restart', async () => {
  const identity = await fetch(base + '/api/identity');
  expect(identity.status).toBe(200);
  expect(identity.headers.get('set-cookie')).toContain('HttpOnly');
  cookie = identity.headers.get('set-cookie')!.split(';')[0]!;
  const create = await fetch(base + '/api/table-sessions', {
    method: 'POST', headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ requestId: 'first-creation', configuration: {} }),
  });
  expect(create.status).toBe(201);
  const created = await create.json();
  expect(created.ok).toBe(true);
  expect(created.bindings).toEqual([{ participantId: expect.any(String), name: 'You', controller: { kind: 'human' } }]);
  tableSessionId = created.tableSessionId;
  const read = await fetch(base + '/api/table-sessions/' + tableSessionId, { headers: { cookie } });
  expect(read.status).toBe(200);
  const before = await read.json();
  expect(before.view.state.participants).toEqual([]);
  expect(before.pokerRevision).toBe(0);
  expect(before.sessionRevision).toBe(0);
  expect(before.view.configuration).toEqual({
    seatCount: 6, smallBlind: 10, bigBlind: 20, ante: 0,
    minimumBuyIn: 1000, defaultBuyIn: 1000, maximumBuyIn: 1000, allowSeatChanges: true,
  });
  expect(JSON.stringify(before)).not.toMatch(/seed|commands|ownerUserId|schemaVersion|engineVersion/);
  await server.close();
  server = await createServer({ databaseUrl, schema });
  base = await server.listen({ host: '127.0.0.1', port: 0 });
  const after = await fetch(base + '/api/table-sessions/' + tableSessionId, { headers: { cookie } });
  expect(await after.json()).toEqual(before);
});

test('a matching creation retry returns the same committed session and Bot bindings while conflicting reuse is rejected', async () => {
  const request = { requestId: 'retry-creation', configuration: { seatCount: 3 }, bots: [{
    name: 'Baseline Bot', playingStrategy: {
      policy: { id: 'uniform-choice', version: 'v1', configuration: {} },
      selector: { id: 'seeded-sampling', version: 'v1', configuration: {} },
    },
  }] };
  const submit = async (body: unknown) => fetch(base + '/api/table-sessions', {
    method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(body),
  });
  const first = await submit(request);
  const original = await first.json();
  expect(original.bindings).toHaveLength(2);
  const retry = await submit(request);
  expect(await retry.json()).toEqual(original);
  const conflicting = await submit({ ...request, configuration: { seatCount: 4 } });
  expect(conflicting.status).toBe(409);
  expect(await conflicting.json()).toMatchObject({ ok: false, rejection: { code: 'request-id-conflict' } });
});

test.each([
  { configuration: { seatCount: 10 } },
  { configuration: { ante: -1 } },
  { configuration: { smallBlind: 0 } },
  { configuration: { defaultBuyIn: 2000 } },
  { configuration: { bigBlind: 9 } },
  { configuration: { maximumBuyIn: 1.5 } },
  { configuration: { seed: 'client-master-seed' } },
  { seed: 'client-master-seed' },
  { ownerUserId: 'client-owner' },
  { participantId: 'client-participant' },
])('invalid or hidden creation settings are definitively rejected: %j', async contents => {
  const body = { requestId: randomUUID(), ...contents };
  const submit = async (attempt: unknown) => fetch(base + '/api/table-sessions', {
    method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(attempt),
  });
  const first = await submit(body);
  expect(first.status).toBe(400);
  const rejection = await first.json();
  expect(rejection.ok).toBe(false);
  expect(await (await submit(body)).json()).toEqual(rejection);
  expect((await submit({ ...body, configuration: {} })).status).toBe(409);
});
test('a supplied observer or Participant identity cannot authorize reading another owner session', async () => {
  const strangerIdentity = await fetch(base + '/api/identity');
  const strangerCookie = strangerIdentity.headers.get('set-cookie')!.split(';')[0]!;
  const unauthorized = await fetch(base + '/api/table-sessions/' + tableSessionId + '?participantId=human&ownerUserId=client-owner', { headers: { cookie: strangerCookie } });
  expect(unauthorized.status).toBe(404);
  const anonymous = await fetch(base + '/api/table-sessions/' + tableSessionId);
  expect(anonymous.status).toBe(401);
});

test('the local identity can discover only its owned Table Sessions for reopen', async () => {
  const response = await fetch(base + '/api/table-sessions', { headers: { cookie } });
  expect(response.status).toBe(200);
  expect((await response.json()).tableSessionIds).toContain(tableSessionId);
  const identity = await fetch(base + '/api/identity');
  const otherCookie = identity.headers.get('set-cookie')!.split(';')[0]!;
  const other = await fetch(base + '/api/table-sessions', { headers: { cookie: otherCookie } });
  expect(await other.json()).toEqual({ tableSessionIds: [] });
});
