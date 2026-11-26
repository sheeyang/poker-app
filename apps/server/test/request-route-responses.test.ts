import { afterAll, beforeAll, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { createServer } from '../src/server.js';
import { nameGuest } from './fixtures/guest.js';

// The two response changes #127 made to the request routes, which it did not announce, pinned here.

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('Set TEST_DATABASE_URL to a real PostgreSQL test database.');
const schema = 'test_' + randomUUID().replaceAll('-', '');
const administration = new Pool({ connectionString: databaseUrl });
let server: Awaited<ReturnType<typeof createServer>>;
let base: string;
beforeAll(async () => {
  await administration.query('CREATE SCHEMA "' + schema + '"');
  server = await createServer({ journalConnectionTimeoutMs: 10_000, automaticBots: false, databaseUrl: databaseUrl!, schema });
  base = await server.listen({ host: '127.0.0.1', port: 0 });
});
afterAll(async () => { await server?.close(); await administration.query('DROP SCHEMA "' + schema + '" CASCADE'); await administration.end(); });

const send = (method: 'GET' | 'POST', path: string, cookie: string, body: unknown = {}) =>
  fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(method === 'POST' ? { body: JSON.stringify(body) } : {}) });
const answer = async (response: Response) => ({ status: response.status, ...(await response.json()) });

test('a request without an established identity is told to open the Trainer, on the summary, session-summary, hand-summary and analysis routes', async () => {
  const table = randomUUID(), request = randomUUID();
  const routes = [
    ['GET', `/api/table-sessions/${table}/summaries/${request}`],
    ['POST', `/api/table-sessions/${table}/session-summaries`],
    ['POST', `/api/table-sessions/${table}/hand-summaries`],
    ['POST', `/api/table-sessions/${table}/analysis`],
    ['GET', `/api/table-sessions/${table}/analysis/${request}`],
  ] as const;
  for (const [method, path] of routes)
    expect({ path, ...await answer(await send(method, path, '')) }).toEqual({ path, status: 401, ok: false, rejection: { code: 'unauthenticated', message: 'Open the Trainer to establish your local identity.' } });
});

test('a retry for a request ID that is not UUID-shaped is 404 before its body is checked, whatever the body holds', async () => {
  const cookie = (await fetch(base + '/api/identity')).headers.get('set-cookie')!.split(';')[0]!;
  await nameGuest(base, cookie, 'Ada');
  const table = randomUUID(), notAnId = 'not-a-request-id';
  const retries = [
    `/api/overall-history/scored/${notAnId}/retry`,
    `/api/overall-history/summaries/${notAnId}/retry`,
    `/api/table-sessions/${table}/summaries/${notAnId}/retry`,
    `/api/table-sessions/${table}/analysis/${notAnId}/retry`,
  ];
  for (const path of retries) {
    const refused = await answer(await send('POST', path, cookie, { anything: 'at all' }));
    expect({ path, status: refused.status, code: refused.rejection?.code }).toEqual({ path, status: 404, code: 'not-found' });
  }
});
