import { afterAll, beforeAll, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { createServer } from '../src/server.js';
import { InstantClock } from './fixtures/clock.js';

// Not a timing test: every Presentation Phase ends at once (see fixtures/clock.ts).
const clock = new InstantClock();

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('Set TEST_DATABASE_URL to a real PostgreSQL test database.');
const schema = 'test_' + randomUUID().replaceAll('-', '');
const administration = new Pool({ connectionString: databaseUrl });
let server: Awaited<ReturnType<typeof createServer>>;
let base: string;

beforeAll(async () => {
  await administration.query('CREATE SCHEMA "' + schema + '"');
  server = await createServer({ clock, automaticBots: false, databaseUrl, schema });
  base = await server.listen({ host: '127.0.0.1', port: 0 });
});
afterAll(async () => {
  await server?.close();
  await administration.query('DROP SCHEMA "' + schema + '" CASCADE');
  await administration.end();
});

const identity = async () => (await fetch(base + '/api/identity')).headers.get('set-cookie')!.split(';')[0]!;
const json = { 'content-type': 'application/json' };
const setName = (cookie: string, displayName: unknown) => fetch(base + '/api/display-name', { method: 'PUT', headers: { ...json, cookie }, body: JSON.stringify({ displayName }) });
const create = (cookie: string) => fetch(base + '/api/table-sessions', { method: 'POST', headers: { ...json, cookie }, body: JSON.stringify({ requestId: randomUUID(), configuration: {} }) });
const identityBody = async (cookie: string) => (await fetch(base + '/api/identity', { headers: { cookie } })).json();

test('a new Guest has no name and creation is rejected until one is set', async () => {
  const cookie = await identity();
  expect(await identityBody(cookie)).toEqual({ ok: true });
  const rejected = await create(cookie);
  expect(rejected.status).toBe(400);
  expect(await rejected.json()).toMatchObject({ ok: false, rejection: { code: 'display-name-required' } });
  expect((await setName(cookie, 'Ada')).status).toBe(200);
  expect((await create(cookie)).status).toBe(201);
});

test('names are trimmed, stored and exposed with the identity', async () => {
  const cookie = await identity();
  const response = await setName(cookie, '  Grace H.  ');
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true, displayName: 'Grace H.' });
  expect(await identityBody(cookie)).toEqual({ ok: true, displayName: 'Grace H.' });
});

test.each(['', '   ', 'x'.repeat(21), 'tab\there', 'new\nline', 'emoji 😀', '<script>', 'semi;colon', 42, null])('invalid name %j is rejected with a distinct code', async name => {
  const cookie = await identity();
  await setName(cookie, 'Valid');
  const response = await setName(cookie, name);
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ ok: false, rejection: { code: 'invalid-display-name' } });
  expect((await identityBody(cookie)).displayName).toBe('Valid');
});

test('names of 20 characters with allowed punctuation are accepted', async () => {
  const cookie = await identity();
  expect((await setName(cookie, "O'Neil-Smith, J. (#1)!")).status).toBe(400);
  expect((await setName(cookie, "O'Neil-Smith, J. 1!?")).status).toBe(200);
});

test('setting a name needs a known identity', async () => {
  expect((await setName('poker_local=unknown', 'Ada')).status).toBe(401);
});

test('the Practice human Participant keeps the creation-time name after the Guest edits theirs', async () => {
  const cookie = await identity();
  await setName(cookie, 'First');
  const created = await (await create(cookie)).json();
  expect(created.bindings).toEqual([{ participantId: expect.any(String), name: 'First', controller: { kind: 'human' } }]);
  await setName(cookie, 'Second');
  const read = await (await fetch(base + '/api/table-sessions/' + created.tableSessionId, { headers: { cookie } })).json();
  expect(read.bindings[0].name).toBe('First');
  const next = await (await create(cookie)).json();
  expect(next.bindings[0].name).toBe('Second');
});
