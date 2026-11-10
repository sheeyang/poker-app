import { afterAll, beforeAll, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { baselinePlayingStrategy, type ObservableTableSession } from '@poker/contracts';
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
/** Holds a join's COMMIT open, by request ID, or every creation's, so that a concurrent request runs meanwhile. */
const heldJoins = new Map<string, Promise<void>>();
let heldCreation: Promise<void> | undefined;
beforeAll(async () => {
  await administration.query('CREATE SCHEMA "' + schema + '"');
  server = await createServer({ clock, automaticBots: false, databaseUrl: databaseUrl!, schema,
    mutationTransactionFaults: { beforeCommit: async ({ requestId }) => { await heldJoins.get(requestId); } },
    transactionFaults: { beforeCommit: async () => { await heldCreation; } } });
  base = await server.listen({ host: '127.0.0.1', port: 0 });
});
afterAll(async () => { await server?.close(); await administration.query('DROP SCHEMA "' + schema + '" CASCADE'); await administration.end(); });

/** Each cookie is a separate Guest. */
async function guest(name: string) {
  const cookie = (await fetch(base + '/api/identity')).headers.get('set-cookie')!.split(';')[0]!;
  await nameGuest(base, cookie, name);
  return cookie;
}
const get = (path: string, cookie: string) => fetch(base + path, { headers: { cookie } });
const post = (path: string, cookie: string, body: unknown) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(body) });
const create = (cookie: string, body: object = {}) => post('/api/table-sessions', cookie, { requestId: randomUUID(), ...body });
const createOnline = async (cookie: string) => (await (await create(cookie, { mode: 'online' })).json()).tableSessionId as string;
const join = (cookie: string, id: string, requestId = randomUUID()) => post('/api/table-sessions/' + id + '/join-table', cookie, { requestId });
const view = async (cookie: string, id: string): Promise<ObservableTableSession> => (await get('/api/table-sessions/' + id, cookie)).json();
async function leave(cookie: string, id: string) {
  const table = await view(cookie, id);
  const left = await post('/api/table-sessions/' + id + '/leave-table', cookie, { requestId: randomUUID(), expectedPokerRevision: table.pokerRevision, participantId: table.viewerParticipantId });
  expect(left.status).toBe(200);
}
const outcome = async (response: Response) => ({ status: response.status, body: await response.json() });
const savedIds = async (cookie: string) => ((await (await get('/api/table-sessions', cookie)).json()).tables as { tableSessionId: string; left?: true }[]);
/** The refusal of a Guest who is joined at another open Online Table, their Current Table, which it names. */
const atCurrentTable = (currentTableId: string) => ({ status: 409, body: { ok: false, rejection: { code: 'current-table-elsewhere', currentTableId, message: expect.stringContaining('Leave') } } });

test('a Guest at an Online Table cannot create another one: the refusal names their Current Table', async () => {
  const ann = await guest('Ann');
  const current = await createOnline(ann);
  expect(await outcome(await create(ann, { mode: 'online' }))).toEqual(atCurrentTable(current));
  // Nothing was created.
  expect((await savedIds(ann)).map(saved => saved.tableSessionId)).toEqual([current]);
});

test('joining another Online Table is refused while the Guest is at one, and allowed once they leave it', async () => {
  const ann = await guest('Ann'), ben = await guest('Ben');
  const anns = await createOnline(ann), bens = await createOnline(ben);
  const requestId = randomUUID();
  expect(await outcome(await join(ann, bens, requestId))).toEqual(atCurrentTable(anns));
  // Nothing changed at Ben's table, and Ann's saved list still holds only her own.
  expect((await view(ben, bens)).bindings.map(binding => binding.name)).toEqual(['Ben']);
  expect((await savedIds(ann)).map(saved => saved.tableSessionId)).toEqual([anns]);
  // Joining her own Current Table again is no refusal: it returns her Participant.
  expect((await join(ann, anns)).status).toBe(200);

  await leave(ann, anns);
  // The refusal was not remembered: the same request now joins.
  const joined = await outcome(await join(ann, bens, requestId));
  expect(joined).toMatchObject({ status: 200, body: { ok: true, tableSessionId: bens } });
  // And Ben's table is now her Current Table, so creating one is refused in turn.
  expect(await outcome(await create(ann, { mode: 'online' }))).toEqual(atCurrentTable(bens));
});

test('returning to an Online Table the Guest left is refused while they are at another one', async () => {
  const ann = await guest('Ann'), ben = await guest('Ben');
  const bens = await createOnline(ben);
  expect((await join(ann, bens)).status).toBe(200);
  await leave(ann, bens);
  const anns = await createOnline(ann);
  // Ben's table is in her saved list only while she is at it; returning goes through its Join Link.
  expect(await outcome(await join(ann, bens))).toEqual(atCurrentTable(anns));
  await leave(ann, anns);
  expect(await outcome(await join(ann, bens))).toMatchObject({ status: 200, body: { ok: true } });
});

test('a Guest at an Online Table creates and plays Practice Tables freely', async () => {
  const ann = await guest('Ann');
  const current = await createOnline(ann);
  const created = await create(ann, { bots: [{ name: 'Bot 1', playingStrategy: baselinePlayingStrategy }] });
  expect(created.status).toBe(201);
  const practice = await created.json(), at = (kind: string) => '/api/table-sessions/' + practice.tableSessionId + '/' + kind;
  for (const [index, participant] of (practice.bindings as { participantId: string }[]).entries())
    expect((await post(at('seat-participant'), ann, { requestId: randomUUID(), expectedPokerRevision: index, participantId: participant.participantId, seat: index + 1 })).status).toBe(200);
  expect((await post(at('start-hand'), ann, { requestId: randomUUID(), expectedPokerRevision: 2 })).status).toBe(200);
  // A second Practice Table too, and she is still at her Online Table.
  expect((await create(ann)).status).toBe(201);
  expect((await view(ann, current)).tableSessionId).toBe(current);
  expect(await outcome(await create(ann, { mode: 'online' }))).toEqual(atCurrentTable(current));
});

test('two concurrent joins from two browser tabs cannot both succeed', async () => {
  const ann = await guest('Ann'), ben = await guest('Ben'), cy = await guest('Cy');
  const bens = await createOnline(ben), cys = await createOnline(cy);
  // The first join's COMMIT is held open while the second is sent.
  const release = Promise.withResolvers<void>(), first = randomUUID();
  heldJoins.set(first, release.promise);
  const both = [join(ann, bens, first), join(ann, cys)];
  setTimeout(release.resolve, 300);
  const [toBen, toCy] = await Promise.all(both.map(async response => outcome(await response)));
  heldJoins.delete(first);
  expect(toBen).toMatchObject({ status: 200, body: { ok: true, tableSessionId: bens } });
  expect(toCy).toEqual(atCurrentTable(bens));
  expect((await view(cy, cys)).bindings.map(binding => binding.name)).toEqual(['Cy']);
});

test('a creation and a join sent together from two browser tabs cannot both succeed', async () => {
  const ann = await guest('Ann'), ben = await guest('Ben');
  const bens = await createOnline(ben);
  // The creation's COMMIT is held open while the join is sent.
  const release = Promise.withResolvers<void>();
  heldCreation = release.promise;
  const creating = create(ann, { mode: 'online' });
  const joining = join(ann, bens);
  setTimeout(release.resolve, 300);
  const created = await outcome(await creating), joined = await outcome(await joining);
  heldCreation = undefined;
  expect(created).toMatchObject({ status: 201, body: { ok: true } });
  expect(joined).toEqual(atCurrentTable(created.body.tableSessionId));
  expect((await savedIds(ann)).map(saved => saved.tableSessionId)).toEqual([created.body.tableSessionId]);
});
