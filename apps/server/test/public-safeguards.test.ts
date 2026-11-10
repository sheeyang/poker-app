import { afterAll, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import type { ObservableTableSession } from '@poker/contracts';
import { createServer, type ServerOptions } from '../src/server.js';
import { nameGuest } from './fixtures/guest.js';
import { ManualClock } from './fixtures/clock.js';
import { defaultRateLimits } from '../src/rate-limit.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('Set TEST_DATABASE_URL to a real PostgreSQL test database.');
const administration = new Pool({ connectionString: databaseUrl });
afterAll(async () => { await administration.end(); });

interface Harness { base: string; clock: ManualClock; restart: () => Promise<void> }
/** Runs `body` against a real server on its own schema. Each test chooses its own options: the safeguards are configuration. */
async function withServer(options: Partial<ServerOptions>, body: (harness: Harness) => Promise<void>) {
  const schema = 'test_' + randomUUID().replaceAll('-', '');
  const clock = new ManualClock();
  await administration.query('CREATE SCHEMA "' + schema + '"');
  let server: Awaited<ReturnType<typeof createServer>> | undefined;
  const harness: Harness = { base: '', clock, restart: async () => { await server?.close(); server = await createServer({ clock, automaticBots: false, databaseUrl: databaseUrl!, schema, ...options }); harness.base = await server.listen({ host: '127.0.0.1', port: 0 }); } };
  try { await harness.restart(); await body(harness); }
  finally { await server?.close(); await administration.query('DROP SCHEMA "' + schema + '" CASCADE'); }
}

async function guest(base: string, name: string) {
  const cookie = (await fetch(base + '/api/identity')).headers.get('set-cookie')!.split(';')[0]!;
  await nameGuest(base, cookie, name);
  return cookie;
}
const call = (base: string, method: string, path: string, cookie: string, body?: unknown, headers: Record<string, string> = {}) =>
  fetch(base + path, { method, headers: { cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const create = (base: string, cookie: string, body: object = {}, headers?: Record<string, string>) => call(base, 'POST', '/api/table-sessions', cookie, { requestId: randomUUID(), ...body }, headers);
const rejection = async (response: Response) => { const body = await response.json(); return { status: response.status, code: body.rejection?.code as string | undefined, message: body.rejection?.message as string | undefined }; };

const minute = 60_000;

test('table creation is limited per IP, a refusal says when to try again, and refused requests create nothing', async () => {
  await withServer({ rateLimits: { creation: { limit: 2, windowMs: minute } } }, async ({ base, clock }) => {
    const ann = await guest(base, 'Ann'), ben = await guest(base, 'Ben');
    expect((await create(base, ann)).status).toBe(201);
    // Another Guest on the same address shares the limit.
    expect((await create(base, ben)).status).toBe(201);
    const refused = await create(base, ann);
    expect(refused.status).toBe(429);
    expect(refused.headers.get('retry-after')).toBe('60');
    expect(await rejection(refused)).toEqual({ status: 429, code: 'rate-limited', message: expect.stringContaining('60 seconds') });
    expect((await (await call(base, 'GET', '/api/table-sessions', ann)).json()).tables).toHaveLength(1);
    // The wait shrinks with time, and waiting it out is enough.
    clock.advance(45_000);
    const closer = await create(base, ann);
    expect(closer.headers.get('retry-after')).toBe('15');
    expect((await rejection(closer)).message).toContain('15 seconds');
    clock.advance(15_000);
    expect((await create(base, ann)).status).toBe(201);
    expect((await (await call(base, 'GET', '/api/table-sessions', ann)).json()).tables).toHaveLength(2);
  });
});

test('joining, and returning to a table, share a per-IP limit', async () => {
  await withServer({ rateLimits: { joining: { limit: 2, windowMs: minute } } }, async ({ base, clock }) => {
    const ann = await guest(base, 'Ann');
    const created = await (await create(base, ann, { mode: 'online' })).json();
    const id = created.tableSessionId as string, annId = created.bindings[0].participantId as string;
    const view = async (cookie: string): Promise<ObservableTableSession> => (await call(base, 'GET', '/api/table-sessions/' + id, cookie)).json();
    const join = async (cookie: string, table = id) => call(base, 'POST', '/api/table-sessions/' + table + '/join-table', cookie, { requestId: randomUUID() });

    const [ben, cy, dee] = [await guest(base, 'Ben'), await guest(base, 'Cy'), await guest(base, 'Dee')] as [string, string, string];
    expect((await join(ben)).status).toBe(200);
    // A refused attempt counts too: a flood of guessed addresses is a flood.
    expect((await join(cy, randomUUID())).status).toBe(404);
    const refused = await join(cy);
    expect(await rejection(refused)).toEqual({ status: 429, code: 'rate-limited', message: expect.stringContaining('60 seconds') });
    expect(refused.headers.get('retry-after')).toBe('60');
    expect((await view(ben)).bindings.map(binding => binding.name)).toEqual(['Ann', 'Ben']);
    // The owner returns through the Join Link too, so it draws on the same allowance.
    const left = await call(base, 'POST', '/api/table-sessions/' + id + '/leave-table', ann, { requestId: randomUUID(), expectedPokerRevision: (await view(ben)).pokerRevision, participantId: annId });
    expect(left.status).toBe(200);
    expect((await join(ann)).status).toBe(429);
    clock.advance(minute);
    expect((await join(ann)).status).toBe(200);
    expect((await join(cy)).status).toBe(200);
    expect((await join(dee)).status).toBe(429);
  });
});

test('Table Password attempts at joining are limited per IP, by default to 10 in 10 minutes', async () => {
  await withServer({ rateLimits: defaultRateLimits }, async ({ base, clock }) => {
    const ann = await guest(base, 'Ann');
    const id = (await (await create(base, ann, { mode: 'online', tablePassword: 'right one' })).json()).tableSessionId as string;
    const join = (cookie: string, fields: object) => call(base, 'POST', '/api/table-sessions/' + id + '/join-table', cookie, { requestId: randomUUID(), ...fields });
    const ben = await guest(base, 'Ben'), cy = await guest(base, 'Cy');
    for (let guess = 0; guess < 10; guess++) expect((await rejection(await join(ben, { tablePassword: 'guess ' + guess }))).code).toBe('wrong-table-password');
    // Another Guest on the same address shares the limit, even with the right password.
    const refused = await join(cy, { tablePassword: 'right one' });
    expect(await rejection(refused)).toEqual({ status: 429, code: 'rate-limited', message: expect.stringContaining('10 minutes') });
    expect(refused.headers.get('retry-after')).toBe('600');
    // Asking without a password is not an attempt at one.
    expect((await rejection(await join(cy, {}))).code).toBe('table-password-required');
    clock.advance(10 * minute);
    expect((await join(cy, { tablePassword: 'right one' })).status).toBe(200);
  });
});

test('client addresses come from forwarding headers only when the connection is from the trusted reverse proxy', async () => {
  // Nothing is trusted: a forged forwarding header cannot buy a fresh allowance.
  await withServer({ rateLimits: { creation: { limit: 1, windowMs: minute } } }, async ({ base }) => {
    const ann = await guest(base, 'Ann');
    expect((await create(base, ann, {}, { 'x-forwarded-for': '198.51.100.1' })).status).toBe(201);
    expect((await create(base, ann, {}, { 'x-forwarded-for': '198.51.100.2' })).status).toBe(429);
  });
  // Trusted only from a proxy at another address, which is not where these requests come from.
  await withServer({ trustedProxies: ['10.9.8.7'], rateLimits: { creation: { limit: 1, windowMs: minute } } }, async ({ base }) => {
    const ann = await guest(base, 'Ann');
    expect((await create(base, ann, {}, { 'x-forwarded-for': '198.51.100.1' })).status).toBe(201);
    expect((await create(base, ann, {}, { 'x-forwarded-for': '198.51.100.2' })).status).toBe(429);
  });
  // Trusted from the connection's own address: the address the proxy reports is the client's.
  await withServer({ trustedProxies: ['127.0.0.1'], rateLimits: { creation: { limit: 1, windowMs: minute } } }, async ({ base }) => {
    const ann = await guest(base, 'Ann');
    expect((await create(base, ann, {}, { 'x-forwarded-for': '198.51.100.1' })).status).toBe(201);
    expect((await create(base, ann, {}, { 'x-forwarded-for': '198.51.100.2' })).status).toBe(201);
    expect((await create(base, ann, {}, { 'x-forwarded-for': '198.51.100.1' })).status).toBe(429);
    // The proxy appends the address it saw: what the client claimed before that is not believed.
    expect((await create(base, ann, {}, { 'x-forwarded-for': '203.0.113.50, 198.51.100.3' })).status).toBe(201);
    expect((await create(base, ann, {}, { 'x-forwarded-for': '203.0.113.51, 198.51.100.3' })).status).toBe(429);
  });
});

/** Creates a table for `cookie` (Practice unless `body` says otherwise) and, for Practice, seats the human. */
async function seatedPracticeTable(base: string, cookie: string, requestId = randomUUID()) {
  const created = await (await create(base, cookie, { requestId })).json();
  const id = created.tableSessionId as string, human = created.bindings[0].participantId as string;
  const seated = await call(base, 'POST', '/api/table-sessions/' + id + '/seat-participant', cookie, { requestId: randomUUID(), expectedPokerRevision: 0, participantId: human, seat: 1 });
  expect(seated.status).toBe(200);
  return { id, human, requestId };
}

test('there is no per-Guest table cap: a Guest with a seated human at every table creates more than 10', async () => {
  await withServer({ rateLimits: { creation: { limit: 100, windowMs: minute } } }, async harness => {
    const ann = await guest(harness.base, 'Ann');
    for (let count = 0; count < 12; count++) await seatedPracticeTable(harness.base, ann);
    const created = await create(harness.base, ann);
    expect(created.status).toBe(201);
    // Nothing is remembered about a limit across a restart either.
    await harness.restart();
    expect((await create(harness.base, ann)).status).toBe(201);
    expect(((await (await call(harness.base, 'GET', '/api/table-sessions', ann)).json()).tables as unknown[]).length).toBe(14);
  });
});
