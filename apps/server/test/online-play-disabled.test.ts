import { afterAll, beforeAll, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { createServer } from '../src/server.js';
import { nameGuest } from './fixtures/guest.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('Set TEST_DATABASE_URL to a real PostgreSQL test database.');
const schema = 'test_' + randomUUID().replaceAll('-', '');
const administration = new Pool({ connectionString: databaseUrl });
let server: Awaited<ReturnType<typeof createServer>>;
let base: string;
beforeAll(async () => {
  await administration.query('CREATE SCHEMA "' + schema + '"');
  server = await createServer({ automaticBots: false, databaseUrl: databaseUrl!, schema, onlinePlay: false });
  base = await server.listen({ host: '127.0.0.1', port: 0 });
});
afterAll(async () => { await server?.close(); await administration.query('DROP SCHEMA "' + schema + '" CASCADE'); await administration.end(); });

const post = (path: string, cookie: string, body: unknown) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(body) });
const refusal = async (response: Response) => ({ status: response.status, code: (await response.json()).rejection?.code });

test('with online play off, the server says so and refuses to create or join Online Tables, while Practice Tables still work', async () => {
  expect(await (await fetch(base + '/api/features')).json()).toEqual({ ok: true, onlinePlay: false });
  const cookie = (await fetch(base + '/api/identity')).headers.get('set-cookie')!.split(';')[0]!;
  await nameGuest(base, cookie, 'Ann');
  const disabled = { status: 403, code: 'online-play-disabled' };
  expect(await refusal(await post('/api/table-sessions', cookie, { requestId: randomUUID(), mode: 'online' }))).toEqual(disabled);
  expect(await refusal(await fetch(base + '/api/join-links/some-token', { headers: { cookie } }))).toEqual(disabled);
  expect(await refusal(await post('/api/join-links/some-token/join', cookie, { requestId: randomUUID() }))).toEqual(disabled);
  expect(await refusal(await post('/api/table-sessions/' + randomUUID() + '/rejoin-table', cookie, { requestId: randomUUID() }))).toEqual(disabled);
  expect((await post('/api/table-sessions', cookie, { requestId: randomUUID() })).status).toBe(201);
  expect((await post('/api/table-sessions', cookie, { requestId: randomUUID(), mode: 'practice' })).status).toBe(201);
});
