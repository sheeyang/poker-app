import { afterAll, beforeAll, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { baselinePlayingStrategy } from '@poker/contracts';
import { createServer } from '../src/server.js';
import { nameGuest } from './fixtures/guest.js';

const databaseUrl = process.env.TEST_DATABASE_URL!;
const schema = 'test_' + randomUUID().replaceAll('-', '');
const administration = new Pool({ connectionString: databaseUrl });
let server: Awaited<ReturnType<typeof createServer>>;
let base: string;
beforeAll(async () => {
  await administration.query('CREATE SCHEMA "' + schema + '"');
  // No adminMode option: the hosted default.
  server = await createServer({ journalConnectionTimeoutMs: 10_000, databaseUrl, schema, automaticBots: false });
  base = await server.listen({ host: '127.0.0.1', port: 0 });
});
afterAll(async () => { await server?.close(); await administration.query('DROP SCHEMA "' + schema + '" CASCADE'); await administration.end(); });

test('without Admin Mode a Practice Table refuses inspection and reports it unavailable', async () => {
  const identity = await fetch(base + '/api/identity');
  const cookie = identity.headers.get('set-cookie')!.split(';')[0]!; await nameGuest(base, cookie);
  const headers = { cookie, 'content-type': 'application/json' };
  const created = await (await fetch(base + '/api/table-sessions', { method: 'POST', headers, body: JSON.stringify({ requestId: randomUUID(), bots: [{ name: 'Bot', playingStrategy: baselinePlayingStrategy }] }) })).json();
  const view = await (await fetch(base + '/api/table-sessions/' + created.tableSessionId, { headers: { cookie } })).json();
  expect(view.inspection).toEqual({ adminMode: false, completedHands: [] });
  const refused = await fetch(base + '/api/table-sessions/' + created.tableSessionId + '/inspect-hand', { method: 'POST', headers, body: JSON.stringify({ handId: 'hand-1' }) });
  expect(refused.status).toBe(403);
  expect((await refused.json()).rejection.code).toBe('admin-mode-disabled');
});
