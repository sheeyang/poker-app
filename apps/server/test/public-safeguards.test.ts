import { afterAll, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import type { ObservableTableSession } from '@poker/contracts';
import { createServer, type ServerOptions } from '../src/server.js';
import { nameGuest } from './fixtures/guest.js';
import { ManualClock } from './fixtures/clock.js';

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

test('joining, returning to a table and replacing a Join Link each have their own per-IP limit', async () => {
  await withServer({ rateLimits: { joining: { limit: 2, windowMs: minute }, 'join-link-replacement': { limit: 1, windowMs: minute } } }, async ({ base, clock }) => {
    const ann = await guest(base, 'Ann');
    const created = await (await create(base, ann, { mode: 'online' })).json();
    const id = created.tableSessionId as string, annId = created.bindings[0].participantId as string;
    const view = async (cookie: string): Promise<ObservableTableSession> => (await call(base, 'GET', '/api/table-sessions/' + id, cookie)).json();
    const link = async () => (await view(ann)).joinToken!;
    const join = async (cookie: string, token?: string) => call(base, 'POST', '/api/join-links/' + (token ?? await link()) + '/join', cookie, { requestId: randomUUID() });

    const [ben, cy, dee] = [await guest(base, 'Ben'), await guest(base, 'Cy'), await guest(base, 'Dee')] as [string, string, string];
    expect((await join(ben)).status).toBe(200);
    // A refused attempt counts too: a flood of bad links is a flood.
    expect((await join(cy, 'x'.repeat(43))).status).toBe(404);
    const refused = await join(cy);
    expect(await rejection(refused)).toEqual({ status: 429, code: 'rate-limited', message: expect.stringContaining('60 seconds') });
    expect(refused.headers.get('retry-after')).toBe('60');
    expect((await view(ben)).bindings.map(binding => binding.name)).toEqual(['Ann', 'Ben']);
    // The owner's way back without the link is joining as well, so it draws on the same allowance.
    const left = await call(base, 'POST', '/api/table-sessions/' + id + '/leave-table', ann, { requestId: randomUUID(), expectedPokerRevision: (await view(ben)).pokerRevision, participantId: annId });
    expect(left.status).toBe(200);
    expect((await call(base, 'POST', '/api/table-sessions/' + id + '/rejoin-table', ann, { requestId: randomUUID() })).status).toBe(429);
    clock.advance(minute);
    expect((await call(base, 'POST', '/api/table-sessions/' + id + '/rejoin-table', ann, { requestId: randomUUID() })).status).toBe(200);
    expect((await join(cy)).status).toBe(200);
    expect((await join(dee)).status).toBe(429);

    // Replacing the link has its own, separate allowance.
    const replace = () => call(base, 'POST', '/api/table-sessions/' + id + '/replace-join-link', ann, { requestId: randomUUID(), expectedSessionRevision: 0 });
    clock.advance(minute);
    const first = await link();
    const current = (await view(ann)).sessionRevision;
    const replaced = await call(base, 'POST', '/api/table-sessions/' + id + '/replace-join-link', ann, { requestId: randomUUID(), expectedSessionRevision: current });
    expect(replaced.status).toBe(200);
    expect(await link()).not.toBe(first);
    const again = await replace();
    expect(await rejection(again)).toEqual({ status: 429, code: 'rate-limited', message: expect.stringContaining('60 seconds') });
    expect(await link()).not.toBe(first);
    clock.advance(minute);
    expect((await replace()).status).toBe(409); // allowed through, then judged on its stale revision
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

test('a Guest cannot create a table while they own 10 tables that each have a seated human, and nothing else counts', async () => {
  await withServer({}, async harness => {
    const ann = await guest(harness.base, 'Ann');
    const tables = [];
    for (let count = 0; count < 9; count++) tables.push(await seatedPracticeTable(harness.base, ann));
    // An Online Table counts once any human is seated at it, the owner or not; before that it does not.
    const online = await (await create(harness.base, ann, { mode: 'online' })).json();
    const onlineId = online.tableSessionId as string;
    const view = async (cookie: string): Promise<ObservableTableSession> => (await call(harness.base, 'GET', '/api/table-sessions/' + onlineId, cookie)).json();
    const ben = await guest(harness.base, 'Ben');
    const benId = (await (await call(harness.base, 'POST', '/api/join-links/' + (await view(ann)).joinToken + '/join', ben, { requestId: randomUUID() })).json()).participantId as string;
    // Nine tables with a seated human, a tenth with only a watcher, and an eleventh is allowed.
    expect((await create(harness.base, ann)).status).toBe(201);
    const seatBen = await call(harness.base, 'POST', '/api/table-sessions/' + onlineId + '/seat-participant', ben, { requestId: randomUUID(), expectedPokerRevision: (await view(ben)).pokerRevision, participantId: benId, seat: 2 });
    expect(seatBen.status).toBe(200);

    expect(await rejection(await create(harness.base, ann))).toEqual({ status: 409, code: 'table-limit-reached', message: expect.stringContaining('10 tables') });
    // The limit is the Guest's own: Ben owns nothing and can still create. The limit survives a restart.
    expect((await create(harness.base, ben)).status).toBe(201);
    await harness.restart();
    expect((await rejection(await create(harness.base, ann))).code).toBe('table-limit-reached');

    // A refusal is not remembered: the same request goes through once a place is free.
    const requestId = randomUUID();
    expect((await rejection(await create(harness.base, ann, { requestId }))).code).toBe('table-limit-reached');
    const stand = await call(harness.base, 'POST', '/api/table-sessions/' + tables[0]!.id + '/stand-up-participant', ann, { requestId: randomUUID(), expectedPokerRevision: 1, participantId: tables[0]!.human });
    expect(stand.status).toBe(200);
    const created = await create(harness.base, ann, { requestId });
    expect(created.status).toBe(201);
    const fresh = await created.json();
    // Seating at the new table puts the Guest at the limit again, and the same request still answers with that table.
    const seat = await call(harness.base, 'POST', '/api/table-sessions/' + fresh.tableSessionId + '/seat-participant', ann, { requestId: randomUUID(), expectedPokerRevision: 0, participantId: fresh.bindings[0].participantId, seat: 1 });
    expect(seat.status).toBe(200);
    expect((await rejection(await create(harness.base, ann))).code).toBe('table-limit-reached');
    const retried = await create(harness.base, ann, { requestId });
    expect(retried.status).toBe(201);
    expect(await retried.json()).toEqual(fresh);
  });
});
