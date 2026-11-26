import { afterAll, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { highestProbabilityPlayingStrategy, simpleHeuristicPlayingStrategy, type TrainerConfiguration } from '@poker/contracts';
import { createServer } from '../src/server.js';
import { InstantClock } from './fixtures/clock.js';
import { nameGuest } from './fixtures/guest.js';

// The table of User-scoped requests was named guest_requests before it became user_requests. Not a timing test.
const clock = new InstantClock();
const databaseUrl = process.env.TEST_DATABASE_URL!;
const administration = new Pool({ connectionString: databaseUrl });
const schemas: string[] = [];
let server: Awaited<ReturnType<typeof createServer>> | undefined;
afterAll(async () => {
  await server?.close();
  for (const schema of schemas) await administration.query('DROP SCHEMA "' + schema + '" CASCADE');
  await administration.end();
});

async function freshSchema() {
  const schema = 'test_' + randomUUID().replaceAll('-', '');
  schemas.push(schema);
  await administration.query('CREATE SCHEMA "' + schema + '"');
  return schema;
}
async function start(schema: string) {
  server = await createServer({ journalConnectionTimeoutMs: 10_000, clock, automaticBots: false, databaseUrl, schema });
  return server.listen({ host: '127.0.0.1', port: 0 });
}
async function stop() { await server?.close(); server = undefined; }
/** Which of the two tables the schema holds. */
async function tables(schema: string) {
  const { rows } = await administration.query(`SELECT to_regclass($1) IS NOT NULL AS "guestRequests", to_regclass($2) IS NOT NULL AS "userRequests"`, ['"' + schema + '".guest_requests', '"' + schema + '".user_requests']);
  return rows[0] as { guestRequests: boolean; userRequests: boolean };
}
const configure = (base: string, cookie: string, requestId: string, trainerConfiguration: TrainerConfiguration) =>
  fetch(base + '/api/trainer-configuration', { method: 'PUT', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ requestId, trainerConfiguration }) });

test('a server started on a database with guest_requests rows finds them in user_requests', async () => {
  const schema = await freshSchema();
  let base = await start(schema);
  const cookie = (await fetch(base + '/api/identity')).headers.get('set-cookie')!.split(';')[0]!;
  await nameGuest(base, cookie);
  const chosen: TrainerConfiguration = { referenceStrategy: highestProbabilityPlayingStrategy, liveAnalysis: false };
  const applied = await configure(base, cookie, 'chosen', chosen);
  expect(applied.status).toBe(200);
  const acknowledgement = await applied.json();
  await stop();
  // The database as it stood before the rename: the same rows, under the old name.
  await administration.query(`ALTER TABLE "${schema}".user_requests RENAME TO guest_requests`);
  expect(await tables(schema)).toEqual({ guestRequests: true, userRequests: false });

  base = await start(schema);
  expect(await tables(schema)).toEqual({ guestRequests: false, userRequests: true });
  const { rows } = await administration.query(`SELECT request_id AS "requestId", outcome FROM "${schema}".user_requests`);
  expect(rows).toEqual([{ requestId: 'chosen', outcome: acknowledgement }]);
  // The server reads them: the same request applies once, and its request ID cannot be reused for another change.
  const repeated = await configure(base, cookie, 'chosen', chosen);
  expect({ status: repeated.status, body: await repeated.json() }).toEqual({ status: 200, body: acknowledgement });
  const reused = await configure(base, cookie, 'chosen', { referenceStrategy: simpleHeuristicPlayingStrategy, liveAnalysis: true });
  expect(reused.status).toBe(409);
  expect(await reused.json()).toMatchObject({ ok: false, rejection: { code: 'request-id-conflict' } });
  // Restarting again changes nothing.
  await stop();
  await start(schema);
  expect(await tables(schema)).toEqual({ guestRequests: false, userRequests: true });
  expect((await administration.query(`SELECT count(*)::int AS count FROM "${schema}".user_requests`)).rows[0].count).toBe(1);
  await stop();
});

test('a fresh database creates user_requests', async () => {
  const schema = await freshSchema();
  await start(schema);
  expect(await tables(schema)).toEqual({ guestRequests: false, userRequests: true });
  await stop();
});
