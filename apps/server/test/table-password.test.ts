import { afterAll, beforeAll, expect, test } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import type { ObservableTableSession } from '@poker/contracts';
import { createServer } from '../src/server.js';
import { nameGuest } from './fixtures/guest.js';
import { ManualClock } from './fixtures/clock.js';
import { announcedCountdown, connectLive } from './fixtures/online.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('Set TEST_DATABASE_URL to a real PostgreSQL test database.');
const schema = 'test_' + randomUUID().replaceAll('-', '');
const administration = new Pool({ connectionString: databaseUrl });
const clock = new ManualClock();
let server: Awaited<ReturnType<typeof createServer>>;
let base: string;
async function startServer() {
  server = await createServer({ clock, automaticBots: false, databaseUrl: databaseUrl!, schema });
  base = await server.listen({ host: '127.0.0.1', port: 0 });
}
beforeAll(async () => { await administration.query('CREATE SCHEMA "' + schema + '"'); await startServer(); });
afterAll(async () => { await server?.close(); await administration.query('DROP SCHEMA "' + schema + '" CASCADE'); await administration.end(); });

/** Each cookie is a separate Guest. */
async function guest(name: string) {
  const cookie = (await fetch(base + '/api/identity')).headers.get('set-cookie')!.split(';')[0]!;
  await nameGuest(base, cookie, name);
  return cookie;
}
const get = (path: string, cookie: string) => fetch(base + path, { headers: { cookie } });
const post = (path: string, cookie: string, body: unknown) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(body) });
const rejection = async (response: Response) => { const body = await response.json(); return { status: response.status, code: body.rejection?.code as string | undefined, message: body.rejection?.message as string | undefined }; };

/** An Online Table owned by Ann, created with `tablePassword` when one is given. */
async function onlineTable(tablePassword?: string) {
  const ann = await guest('Ann');
  const created = await (await post('/api/table-sessions', ann, { requestId: randomUUID(), mode: 'online', ...(tablePassword === undefined ? {} : { tablePassword }) })).json();
  const id = created.tableSessionId as string, annId = created.bindings[0].participantId as string;
  const view = async (cookie: string): Promise<ObservableTableSession> => (await get('/api/table-sessions/' + id, cookie)).json();
  const join = (cookie: string, fields: object = {}) => post('/api/table-sessions/' + id + '/join-table', cookie, { requestId: randomUUID(), ...fields });
  const preview = async (cookie: string) => (await get('/api/table-sessions/' + id + '/join-preview', cookie)).json();
  const as = async (cookie: string, kind: string, fields: object) => post('/api/table-sessions/' + id + '/' + kind, cookie, { requestId: randomUUID(), expectedPokerRevision: (await view(cookie)).pokerRevision, ...fields });
  const setPassword = (cookie: string, password: string | null, requestId = randomUUID()) => post('/api/table-sessions/' + id + '/set-table-password', cookie, { requestId, tablePassword: password });
  return { ann, annId, id, view, join, preview, as, setPassword };
}

test('a table created with a Table Password previews only its owner, and joining needs the password', async () => {
  const { ann, view, join, preview } = await onlineTable('Open Sesame');
  const ben = await guest('Ben');
  expect(await preview(ben)).toEqual({ ok: true, ownerName: 'Ann', passwordRequired: true });
  expect(await rejection(await join(ben))).toMatchObject({ status: 403, code: 'table-password-required' });
  const wrong = await rejection(await join(ben, { tablePassword: 'open sesame' }));
  expect(wrong).toMatchObject({ status: 403, code: 'wrong-table-password' });
  expect(wrong.message).not.toContain('Open Sesame');
  const joined = await join(ben, { tablePassword: 'Open Sesame' });
  expect(joined.status).toBe(200);
  // Everyone at the table sees that it has a password, never the password.
  expect((await view(ben)).options).toEqual({ actionTimeLimitSeconds: 30, allowLiveAnalysis: true, hasTablePassword: true });
  expect((await view(ann)).options.hasTablePassword).toBe(true);
  // Once at the table, joining again needs no password.
  expect((await join(ben)).status).toBe(200);
});

test('the Table Owner sets, changes and removes the Table Password during a Hand, and nobody at the table is disturbed', async () => {
  const table = await onlineTable();
  const { ann, annId, id, view, join, preview, as, setPassword } = table;
  const ben = await guest('Ben');
  const benId = (await (await join(ben)).json()).participantId as string;
  await connectLive(base, ann, id); await connectLive(base, ben, id);
  expect((await as(ann, 'seat-participant', { participantId: annId, seat: 1 })).status).toBe(200);
  expect((await as(ben, 'seat-participant', { participantId: benId, seat: 2 })).status).toBe(200);
  clock.advanceTo((await announcedCountdown(() => view(ann))).endsAt);
  await expect.poll(async () => (await view(ann)).view.state.handId).toBe('hand-1');
  const before = await view(ann);

  // Only the owner can.
  expect(await rejection(await setPassword(ben, 'secret'))).toMatchObject({ status: 403, code: 'table-owner-required' });
  expect(await rejection(await setPassword(ann, 'abc'))).toMatchObject({ status: 400, code: 'invalid-table-password' });
  expect(await rejection(await setPassword(ann, 'x'.repeat(65)))).toMatchObject({ status: 400, code: 'invalid-table-password' });

  const set = await setPassword(ann, 'secret');
  expect(set.status).toBe(200);
  expect(await set.json()).toMatchObject({ ok: true, sessionRevision: before.sessionRevision + 1, pokerRevision: before.pokerRevision });
  const during = await view(ben);
  expect(during.options.hasTablePassword).toBe(true);
  // The Hand goes on with everyone in it.
  expect(during.view.state.handId).toBe('hand-1');
  expect(during.view.state.participants.map(participant => participant.seat)).toEqual(before.view.state.participants.map(participant => participant.seat));
  expect(during.departedParticipantIds).toBeUndefined();

  const cy = await guest('Cy');
  expect(await preview(cy)).toEqual({ ok: true, ownerName: 'Ann', passwordRequired: true });
  // Changing it shuts out the old one.
  expect((await setPassword(ann, 'new secret')).status).toBe(200);
  expect(await rejection(await join(cy, { tablePassword: 'secret' }))).toMatchObject({ code: 'wrong-table-password' });
  expect((await join(cy, { tablePassword: 'new secret' })).status).toBe(200);

  // Removing it opens the table again.
  expect((await setPassword(ann, null)).status).toBe(200);
  expect((await view(ann)).options.hasTablePassword).toBeUndefined();
  const dee = await guest('Dee');
  expect(await preview(dee)).toMatchObject({ ok: true, ownerName: 'Ann', placesTaken: 3, alreadyJoined: false });
  expect((await join(dee)).status).toBe(200);
});

test('a Practice Table has no Table Password', async () => {
  const sam = await guest('Sam');
  expect(await rejection(await post('/api/table-sessions', sam, { requestId: randomUUID(), tablePassword: 'secret' }))).toMatchObject({ status: 400, code: 'invalid-creation-settings' });
  const id = (await (await post('/api/table-sessions', sam, { requestId: randomUUID() })).json()).tableSessionId as string;
  expect(await rejection(await post('/api/table-sessions/' + id + '/set-table-password', sam, { requestId: randomUUID(), tablePassword: 'secret' }))).toMatchObject({ status: 403, code: 'unavailable-at-practice-tables' });
});

test('the password fingerprints record only whether it is set: a request ID used again with another password is the same request', async () => {
  const sam = await guest('Sam');
  const requestId = randomUUID();
  const first = await (await post('/api/table-sessions', sam, { requestId, mode: 'online', tablePassword: 'first one' })).json();
  // Creation: the same table, still under the first password.
  expect(await (await post('/api/table-sessions', sam, { requestId, mode: 'online', tablePassword: 'second one' })).json()).toEqual(first);
  const id = first.tableSessionId as string;
  const join = (cookie: string, tablePassword: string) => post('/api/table-sessions/' + id + '/join-table', cookie, { requestId: randomUUID(), tablePassword });
  expect((await join(await guest('Ben'), 'first one')).status).toBe(200);

  const set = (tablePassword: string | null) => post('/api/table-sessions/' + id + '/set-table-password', sam, { requestId: 'set-password', tablePassword });
  const changed = await (await set('third one')).json();
  expect(changed.ok).toBe(true);
  expect(await (await set('fourth one')).json()).toEqual(changed);
  expect((await join(await guest('Cy'), 'third one')).status).toBe(200);
  expect(await rejection(await join(await guest('Dee'), 'fourth one'))).toMatchObject({ code: 'wrong-table-password' });
  // Removing is a different request.
  expect(await rejection(await set(null))).toMatchObject({ status: 409, code: 'request-id-conflict' });
});

test('anyone not at the table needs the password: a Guest who left, a removed Guest and the Table Owner after leaving', async () => {
  const { ann, annId, view, join, as, setPassword } = await onlineTable();
  const ben = await guest('Ben'), cy = await guest('Cy');
  const benId = (await (await join(ben)).json()).participantId as string;
  const cyId = (await (await join(cy)).json()).participantId as string;
  expect((await setPassword(ann, 'let me in')).status).toBe(200);
  // Those at the table are untouched, and joining again returns them without it.
  expect((await join(ben)).status).toBe(200);

  expect((await as(ben, 'leave-table', { participantId: benId })).status).toBe(200);
  expect(await rejection(await join(ben))).toMatchObject({ code: 'table-password-required' });
  expect(await (await join(ben, { tablePassword: 'let me in' })).json()).toMatchObject({ ok: true, participantId: benId });

  expect((await as(ann, 'remove-participant', { participantId: cyId })).status).toBe(200);
  expect(await rejection(await join(cy))).toMatchObject({ code: 'table-password-required' });

  expect((await as(ann, 'leave-table', { participantId: annId })).status).toBe(200);
  // The password is the stored table's, so it holds across a restart.
  await server.close(); await startServer();
  expect(await rejection(await join(ann, { tablePassword: 'let me out' }))).toMatchObject({ code: 'wrong-table-password' });
  expect(await (await join(ann, { tablePassword: 'let me in' })).json()).toMatchObject({ ok: true, participantId: annId });
  expect((await view(ann)).options.hasTablePassword).toBe(true);
});

test('a wrong password is not remembered under its request ID, and the password is never in a response or stored in plain', async () => {
  const tablePassword = 'Pl41n-T3xt?';
  const { ann, id, view, join, preview, setPassword } = await onlineTable(tablePassword);
  const ben = await guest('Ben');
  const requestId = randomUUID();
  const responses: string[] = [];
  const record = async (response: Response) => { const text = await response.text(); responses.push(text); return { status: response.status, body: JSON.parse(text) }; };
  expect(await record(await join(ben, { requestId, tablePassword: 'pl41n-t3xt?' }))).toMatchObject({ status: 403, body: { rejection: { code: 'wrong-table-password' } } });
  // A typo is not a dead end: the same request, with the right password, joins.
  expect(await record(await join(ben, { requestId, tablePassword }))).toMatchObject({ status: 200, body: { ok: true } });
  await record(await get('/api/table-sessions/' + id, ben));
  await record(await get('/api/table-sessions/' + id + '/join-preview', await guest('Cy')));
  await record(await setPassword(ann, tablePassword));
  await record(await get('/api/table-sessions', ann));
  expect((await view(ann)).options.hasTablePassword).toBe(true);
  expect(await preview(ben)).toMatchObject({ ok: true, alreadyJoined: true });
  for (const text of responses) expect(text).not.toContain(tablePassword);

  // Nothing stored holds the password, or an unsalted digest of it: not the table, its fingerprints or its journal.
  const digest = createHash('sha256').update(tablePassword).digest('hex');
  const stored = (await administration.query('SELECT table_name FROM information_schema.tables WHERE table_schema = $1', [schema])).rows.map(row => row.table_name as string);
  expect(stored).toEqual(expect.arrayContaining(['table_sessions', 'creation_requests', 'processed_requests', 'acceptance_attempts']));
  for (const table of stored) {
    const rows = (await administration.query(`SELECT row_to_json(t)::text AS row FROM "${schema}"."${table}" t`)).rows.map(row => row.row as string);
    for (const row of rows) { expect(row).not.toContain(tablePassword); expect(row).not.toContain(digest); }
  }
});
