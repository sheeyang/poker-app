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
let beforeCommit: () => Promise<void> = async () => {};
let afterCommit: () => Promise<void> = async () => {};
beforeAll(async () => {
  await administration.query('CREATE SCHEMA "' + schema + '"');
  server = await createServer({ automaticBots: false,
    databaseUrl, schema,
    transactionFaults: { beforeCommit: () => beforeCommit(), afterCommit: () => afterCommit() },
  });
  base = await server.listen({ host: '127.0.0.1', port: 0 });
});
afterAll(async () => {
  await server?.close();
  await administration.query('DROP SCHEMA "' + schema + '" CASCADE');
  await administration.end();
});
async function newUser() {
  const identity = await fetch(base + '/api/identity');
  return identity.headers.get('set-cookie')!.split(';')[0]!;
}
function submit(cookie: string, requestId: string) {
  return fetch(base + '/api/table-sessions', { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ requestId }) });
}
async function list(cookie: string) {
  return (await (await fetch(base + '/api/table-sessions', { headers: { cookie } })).json()).tableSessionIds;
}
test('a working creation remains unavailable until its real PostgreSQL transaction commits', async () => {
  const cookie = await newUser();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  beforeCommit = async () => { entered.resolve(); await release.promise; };
  const pending = submit(cookie, 'withheld');
  try {
    const reached = await Promise.race([entered.promise.then(() => true), new Promise(resolve => setTimeout(() => resolve(false), 500))]);
    expect(reached).toBe(true);
    expect(await list(cookie)).toEqual([]);
  } finally { release.resolve(); beforeCommit = async () => {}; }
  const response = await pending;
  expect(response.status).toBe(201);
  const outcome = await response.json();
  expect(await list(cookie)).toEqual([outcome.tableSessionId]);
});

test('confirmed creation rollback leaves no session or definitive rejection and a human retry may create it', async () => {
  const cookie = await newUser();
  beforeCommit = async () => { throw new Error('controlled failure before COMMIT'); };
  const failed = await submit(cookie, 'rollback-attempt');
  expect(failed.status).toBe(503);
  expect(await failed.json()).toMatchObject({ ok: false, rejection: { code: 'persistence-unavailable' } });
  expect(await list(cookie)).toEqual([]);
  beforeCommit = async () => {};
  const explicitRetry = await submit(cookie, 'rollback-attempt');
  expect(explicitRetry.status).toBe(201);
  expect(await list(cookie)).toEqual([(await explicitRetry.json()).tableSessionId]);
});

test('lost COMMIT acknowledgement is reported as unknown and an explicit matching retry resolves the committed outcome without a second creation', async () => {
  const cookie = await newUser();
  afterCommit = async () => { throw new Error('controlled lost COMMIT acknowledgement'); };
  const ambiguous = await submit(cookie, 'ambiguous-attempt');
  expect(ambiguous.status).toBe(503);
  expect(await ambiguous.json()).toMatchObject({ ok: false, rejection: { code: 'commit-outcome-unknown' } });
  const committed = await list(cookie);
  expect(committed).toHaveLength(1);
  afterCommit = async () => {};
  const explicitRetry = await submit(cookie, 'ambiguous-attempt');
  expect(explicitRetry.status).toBe(201);
  expect((await explicitRetry.json()).tableSessionId).toBe(committed[0]);
  expect(await list(cookie)).toEqual(committed);
});
