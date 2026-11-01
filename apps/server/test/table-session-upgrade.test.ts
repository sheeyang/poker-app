import { afterAll, beforeAll, expect, test } from 'vitest';
import { nameGuest } from './fixtures/guest.js';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { baselinePlayingStrategy, defaultConfiguration, highestProbabilityPlayingStrategy, simpleHeuristicPlayingStrategy, type ObservableTableSession } from '@poker/contracts';
import { CashGame } from '@poker/engine';
import { createServer } from '../src/server.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('Set TEST_DATABASE_URL to a real PostgreSQL test database.');
const schema = 'test_' + randomUUID().replaceAll('-', '');
const administration = new Pool({ connectionString: databaseUrl });
let server: Awaited<ReturnType<typeof createServer>> | undefined;
let base: string;
async function start() {
  server = await createServer({ automaticBots: false, databaseUrl: databaseUrl!, schema });
  base = await server.listen({ host: '127.0.0.1', port: 0 });
}
async function stop() { await server?.close(); server = undefined; }
beforeAll(async () => { await administration.query('CREATE SCHEMA "' + schema + '"'); await start(); await stop(); });
afterAll(async () => { await stop(); await administration.query('DROP SCHEMA "' + schema + '" CASCADE'); await administration.end(); });

/** Returns the database to the shape written before M4: no membership index, analysis owned by the Table Owner. */
async function revertToPreM4Schema() {
  await administration.query(`SET search_path = "${schema}"`);
  await administration.query('DROP TABLE IF EXISTS table_memberships');
  for (const table of ['analysis_evaluations', 'analysis_scores']) {
    await administration.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS owner_user_id uuid REFERENCES local_users(id)`);
    await administration.query(`UPDATE ${table} AS analysis SET owner_user_id = sessions.owner_user_id FROM table_sessions AS sessions WHERE sessions.id = analysis.table_session_id`);
    await administration.query(`ALTER TABLE ${table} ALTER COLUMN owner_user_id SET NOT NULL`);
    await administration.query(`ALTER TABLE ${table} DROP COLUMN IF EXISTS participant_id`);
  }
  await administration.query('RESET search_path');
}
/** A Practice Table exactly as version 1 stored it: one owner-human, a table-level Trainer configuration. */
async function legacyTable({ trainerConfiguration = true } = {}) {
  const token = randomBytes(32).toString('base64url');
  const userId = randomUUID(), tableSessionId = randomUUID(), human = randomUUID(), bot = randomUUID();
  const created = CashGame.create({ ...defaultConfiguration, seed: 'legacy-'.padEnd(64, '0') });
  if (!created.ok) throw new Error('Legacy fixture configuration is invalid.');
  const game = created.game;
  for (const result of [game.seatParticipant(human, 1), game.seatParticipant(bot, 2), game.startHand(), game.act(human, { type: 'fold' })]) if (!result.ok) throw new Error(result.rejection.code);
  const aggregate = {
    schemaVersion: 1, tableSessionId, ownerUserId: userId,
    pokerRecord: { ...game.toRecord(), schemaVersion: 1 },
    bindings: [
      { participantId: human, name: 'You', controller: { kind: 'human' }, userId },
      { participantId: bot, name: 'Bot', controller: { kind: 'bot', playingStrategy: baselinePlayingStrategy }, assignmentId: randomUUID() },
    ],
    ...(trainerConfiguration ? { trainerConfiguration: { referenceStrategy: highestProbabilityPlayingStrategy, liveAnalysis: true } } : {}),
    pokerRevision: 4, sessionRevision: 5, adminMode: true, botProvenance: [],
  };
  await administration.query(`INSERT INTO "${schema}".local_users (id, token_hash) VALUES ($1, $2)`, [userId, createHash('sha256').update(token).digest('hex')]);
  await administration.query(`INSERT INTO "${schema}".table_sessions (id, owner_user_id, aggregate) VALUES ($1, $2, $3)`, [tableSessionId, userId, aggregate]);
  return { id: tableSessionId, cookie: 'poker_local=' + token, human, bot };
}
type Table = Awaited<ReturnType<typeof legacyTable>>;
const get = (path: string, cookie: string) => fetch(base + path, { headers: { cookie } });
const post = (path: string, cookie: string, body: unknown) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(body) });
const read = async (t: Table): Promise<ObservableTableSession> => (await get('/api/table-sessions/' + t.id, t.cookie)).json();

test('a version-1 table loads as a Practice Table whose human keeps the table-level Trainer configuration and analysis', async () => {
  await revertToPreM4Schema();
  const t = await legacyTable();
  await start();
  const upgraded = await read(t);
  expect(upgraded).toMatchObject({
    tableSessionId: t.id, mode: 'practice', pokerRevision: 4, sessionRevision: 5,
    trainerConfiguration: { referenceStrategy: highestProbabilityPlayingStrategy, liveAnalysis: true },
    bindings: [{ participantId: t.human, name: 'You', controller: { kind: 'human' } }, { participantId: t.bot, name: 'Bot', controller: { kind: 'bot', playingStrategy: baselinePlayingStrategy } }],
    view: { state: { status: 'completed-hand', handId: 'hand-1', participants: [{ participantId: t.human, stack: 990 }, { participantId: t.bot, stack: 1010 }] } },
  });
  expect(upgraded.view.history[0]!.decisions[0]!.state.participants[0]!.holeCards).toHaveLength(2);
  expect(upgraded.view.history[0]!.decisions[0]!.state.participants[1]).not.toHaveProperty('holeCards');
  expect(await (await get('/api/table-sessions', t.cookie)).json()).toEqual({ tables: [{ tableSessionId: t.id, mode: 'practice' }] });
  const stranger = (await fetch(base + '/api/identity')).headers.get('set-cookie')!.split(';')[0]!;
  await nameGuest(base, stranger, 'Stranger');
  expect((await get('/api/table-sessions/' + t.id, stranger)).status).toBe(404);

  const requested = await (await post('/api/table-sessions/' + t.id + '/analysis', t.cookie, { decisionId: 'hand-1/decision-1' })).json();
  expect(requested).toMatchObject({ ok: true, participantId: t.human, referenceStrategy: highestProbabilityPlayingStrategy });
  const analysis = () => get('/api/table-sessions/' + t.id + '/analysis/' + requested.requestId, t.cookie);
  await expect.poll(async () => (await (await analysis()).json()).status, { timeout: 10000 }).toBe('complete');
  const completed = await (await analysis()).json();

  // A database still written in the pre-M4 shape, holding results stored for the owner, also upgrades.
  await stop();
  await revertToPreM4Schema();
  await start();
  expect(await read(t)).toEqual(upgraded);
  expect(await (await analysis()).json()).toEqual(completed);
  expect((await get('/api/table-sessions/' + t.id + '/analysis/' + requested.requestId, stranger)).status).toBe(404);

  const trainerConfiguration = { referenceStrategy: simpleHeuristicPlayingStrategy, liveAnalysis: false };
  expect((await post('/api/table-sessions/' + t.id + '/set-trainer-configuration', t.cookie, { requestId: randomUUID(), expectedSessionRevision: 5, trainerConfiguration })).status).toBe(200);
  expect((await post('/api/table-sessions/' + t.id + '/start-hand', t.cookie, { requestId: randomUUID(), expectedPokerRevision: 4 })).status).toBe(200);
  const resumed = await read(t);
  expect(resumed).toMatchObject({ mode: 'practice', pokerRevision: 5, sessionRevision: 7, trainerConfiguration, view: { state: { status: 'active-hand', handId: 'hand-2' } } });
  await stop();
  await start();
  expect(await read(t)).toEqual(resumed);
  expect(await (await get('/api/table-sessions', t.cookie)).json()).toEqual({ tables: [{ tableSessionId: t.id, mode: 'practice' }] });
});

test('a version-1 table without its Trainer configuration fails restoration instead of receiving a default', async () => {
  await stop();
  const t = await legacyTable({ trainerConfiguration: false });
  await start();
  const response = await get('/api/table-sessions/' + t.id, t.cookie);
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({ ok: false, rejection: { code: 'record-restoration-failed' } });
  const stranger = (await fetch(base + '/api/identity')).headers.get('set-cookie')!.split(';')[0]!;
  expect((await get('/api/table-sessions/' + t.id, stranger)).status).toBe(404);
});
