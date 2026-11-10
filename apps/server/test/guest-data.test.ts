import { afterAll, beforeAll, expect, test } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { createServer } from '../src/server.js';
import { nameGuest } from './fixtures/guest.js';
import { ManualClock } from './fixtures/clock.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('Set TEST_DATABASE_URL to a real PostgreSQL test database.');
const schema = 'test_' + randomUUID().replaceAll('-', '');
const administration = new Pool({ connectionString: databaseUrl });
const clock = new ManualClock();
let server: Awaited<ReturnType<typeof createServer>>;
let base: string;
beforeAll(async () => {
  await administration.query('CREATE SCHEMA "' + schema + '"');
  server = await createServer({ clock, automaticBots: false, databaseUrl: databaseUrl!, schema });
  base = await server.listen({ host: '127.0.0.1', port: 0 });
});
afterAll(async () => { await server?.close(); await administration.query('DROP SCHEMA "' + schema + '" CASCADE'); await administration.end(); });

const day = 24 * 60 * 60_000;
const json = { 'content-type': 'application/json' };
/** A new Guest: the cookie their browser would hold. */
async function guest(name?: string) {
  const cookie = (await fetch(base + '/api/identity')).headers.get('set-cookie')!.split(';')[0]!;
  if (name) await nameGuest(base, cookie, name);
  return cookie;
}
const get = (path: string, cookie: string) => fetch(base + path, { headers: { cookie } });
const post = (path: string, cookie: string, body: unknown = {}) => fetch(base + path, { method: 'POST', headers: { ...json, cookie }, body: JSON.stringify(body) });
const create = async (cookie: string) => (await (await post('/api/table-sessions', cookie, { requestId: randomUUID() })).json()).tableSessionId as string;
const opened = (cookie: string, id: string) => post('/api/table-sessions/' + id + '/opened', cookie);
const saved = async (cookie: string) => (await (await get('/api/table-sessions', cookie)).json()).tables as { tableSessionId: string; openedAt?: number }[];

test('a Guest’s saved list carries when each table was last opened, by the server’s clock', async () => {
  const ann = await guest('Ann');
  const first = await create(ann), second = await create(ann);
  expect((await saved(ann)).map(table => table.openedAt)).toEqual([undefined, undefined]);

  clock.advance(1000);
  const firstOpened = clock.now();
  expect(await (await opened(ann, first)).json()).toEqual({ ok: true });
  clock.advance(5000);
  const secondOpened = clock.now();
  await opened(ann, second);
  clock.advance(5000);
  await opened(ann, first);

  const listed = new Map((await saved(ann)).map(table => [table.tableSessionId, table.openedAt]));
  expect(listed.get(second)).toBe(secondOpened);
  // Opening again moves the time on.
  expect(listed.get(first)).toBe(secondOpened + 5000);
  expect(firstOpened).toBeLessThan(secondOpened);
});

test('opening needs a table the Guest has a place at, and only changes that Guest’s own time', async () => {
  const ann = await guest('Ann'), ben = await guest('Ben');
  const table = await create(ann);
  const refused = await opened(ben, table);
  expect(refused.status).toBe(404);
  expect(await refused.json()).toMatchObject({ ok: false, rejection: { code: 'not-found' } });
  expect((await saved(ben))).toEqual([]);
  expect((await opened('poker_local=unknown', table)).status).toBe(401);
  expect((await opened(ann, 'not-a-table')).status).toBe(404);
});

/** The cookie the server sets in answer to a request, whole, or undefined when it sets none. */
const refreshed = async (cookie: string, path = '/api/table-sessions') => (await get(path, cookie)).headers.get('set-cookie') ?? undefined;

test('a Guest’s cookie is set again for a fresh year when they return after a day, and not before', async () => {
  const cookie = await guest('Ann');
  clock.advance(day - 60_000);
  expect(await refreshed(cookie)).toBeUndefined();
  clock.advance(120_000);
  const renewed = await refreshed(cookie);
  expect(renewed).toContain(cookie + ';');
  expect(renewed).toContain('Max-Age=31536000');
  expect(renewed).toContain('HttpOnly');
  // Setting it counts as a visit: the next request, and the whole day after it, set nothing.
  expect(await refreshed(cookie)).toBeUndefined();
  clock.advance(day - 60_000);
  expect(await refreshed(cookie, '/api/identity')).toBeUndefined();
  clock.advance(120_000);
  expect(await refreshed(cookie, '/api/identity')).toContain(cookie + ';');
});

const hash = (cookie: string) => createHash('sha256').update(cookie.split('=')[1]!).digest('hex');
const known = async (cookie: string) => (await administration.query(`SELECT 1 FROM "${schema}".local_users WHERE token_hash = $1`, [hash(cookie)])).rowCount === 1;
/** Lets the server's housekeeping run after time has moved: the sweep is asynchronous and the clock only fires its timer. */
async function until(condition: () => Promise<boolean>) {
  for (let attempt = 0; attempt < 100; attempt++) { if (await condition()) return; await new Promise(resolve => setTimeout(resolve, 50)); }
  throw new Error('The condition never held.');
}

test('after 90 idle days the server purges a Guest who has no name and no tables, and nobody else', async () => {
  const visitor = await guest();
  const named = await guest('Ann');
  const owner = await guest('Ben');
  await create(owner);
  const watcher = await guest();
  expect(await known(visitor)).toBe(true);
  clock.advance(89 * day);
  await get('/api/identity', owner);
  clock.advance(2 * day);
  await until(async () => !(await known(visitor)));
  expect(await known(watcher)).toBe(false);
  // A name is enough to keep a Guest, and so is a table, whenever they were last seen.
  expect(await known(named)).toBe(true);
  expect(await known(owner)).toBe(true);
});

test('a Guest seen within the last 90 days is kept, however empty', async () => {
  const visitor = await guest();
  clock.advance(60 * day);
  await get('/api/identity', visitor);
  clock.advance(60 * day);
  await new Promise(resolve => setTimeout(resolve, 300));
  expect(await known(visitor)).toBe(true);
});

test('a Guest can open an Online Table they have left, and it is timed like any other', async () => {
  const ann = await guest('Ann');
  const table = (await (await post('/api/table-sessions', ann, { requestId: randomUUID(), mode: 'online' })).json()).tableSessionId as string;
  const view = await (await get('/api/table-sessions/' + table, ann)).json();
  const left = await post('/api/table-sessions/' + table + '/leave-table', ann, { requestId: randomUUID(), expectedPokerRevision: view.pokerRevision, participantId: view.viewerParticipantId });
  expect(left.status).toBe(200);
  clock.advance(1000);
  expect((await opened(ann, table)).status).toBe(200);
  expect((await saved(ann)).find(entry => entry.tableSessionId === table)).toMatchObject({ left: true, openedAt: clock.now() });
});
