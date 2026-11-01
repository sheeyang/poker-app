import { afterAll, beforeAll, expect, test } from 'vitest';
import { nameGuest } from './fixtures/guest.js';
import { createHash, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import WebSocket from 'ws';
import { baselinePlayingStrategy, defaultTrainerConfiguration, highestProbabilityPlayingStrategy, simpleHeuristicPlayingStrategy, type ObservableTableSession, type ServerLiveMessage } from '@poker/contracts';
import { startStoredHand } from './fixtures/online.js';
import { createServer } from '../src/server.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('Set TEST_DATABASE_URL to a real PostgreSQL test database.');
const schema = 'test_' + randomUUID().replaceAll('-', '');
const administration = new Pool({ connectionString: databaseUrl });
let server: Awaited<ReturnType<typeof createServer>>;
let base: string;
async function start() {
  server = await createServer({ automaticBots: false, databaseUrl: databaseUrl!, schema });
  base = await server.listen({ host: '127.0.0.1', port: 0 });
}
/**
 * Persistence fixture for the memberships no route reaches yet: Leave Table and Removal arrive in later tickets.
 * Binds another Guest's human Participant with that membership while the server is stopped. Returns its ID.
 * A joined second human joins through the real Join Link instead.
 */
async function bindHuman(t: { id: string }, cookie: string, name: string, membership: 'joined' | 'left' | 'removed' = 'joined') {
  const token = decodeURIComponent(cookie.slice('poker_local='.length));
  const userId = (await administration.query(`SELECT id FROM "${schema}".local_users WHERE token_hash = $1`, [createHash('sha256').update(token).digest('hex')])).rows[0].id as string;
  const participantId = randomUUID();
  const binding = { participantId, name, controller: { kind: 'human' }, userId, membership, trainerConfiguration: defaultTrainerConfiguration };
  await server.close();
  await administration.query(`UPDATE "${schema}".table_sessions SET aggregate = jsonb_set(aggregate, '{bindings}', (aggregate->'bindings') || $1::jsonb) WHERE id = $2`, [JSON.stringify([binding]), t.id]);
  await administration.query(`INSERT INTO "${schema}".table_memberships (user_id, table_session_id, participant_id, status) VALUES ($1, $2, $3, $4)`, [userId, t.id, participantId, membership]);
  await start();
  return participantId;
}
beforeAll(async () => { await administration.query('CREATE SCHEMA "' + schema + '"'); await start(); });
afterAll(async () => { await server?.close(); await administration.query('DROP SCHEMA "' + schema + '" CASCADE'); await administration.end(); });

async function guest(name = 'You') {
  const cookie = (await fetch(base + '/api/identity')).headers.get('set-cookie')!.split(';')[0]!;
  await nameGuest(base, cookie, name);
  return cookie;
}
async function table(cookie: string, mode: 'practice' | 'online' = 'practice') {
  const response = await fetch(base + '/api/table-sessions', { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ requestId: randomUUID(), mode, bots: [{ name: 'Bot', playingStrategy: baselinePlayingStrategy }] }) });
  expect(response.status).toBe(201);
  const created = await response.json();
  return { id: created.tableSessionId as string, cookie, human: created.bindings[0].participantId as string, bot: created.bindings[1].participantId as string };
}
type Table = Awaited<ReturnType<typeof table>>;
const get = (path: string, cookie: string) => fetch(base + path, { headers: { cookie } });
const post = (path: string, cookie: string, body: unknown) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(body) });
const read = async (t: Table, cookie = t.cookie): Promise<ObservableTableSession> => (await get('/api/table-sessions/' + t.id, cookie)).json();
async function command(t: Table, kind: string, contents: object = {}, cookie = t.cookie) {
  const response = await post('/api/table-sessions/' + t.id + '/' + kind, cookie, { requestId: randomUUID(), expectedPokerRevision: (await read(t)).pokerRevision, ...contents });
  expect(response.status).toBe(200);
}
async function completedHand(t: Table) {
  await command(t, 'seat-participant', { participantId: t.human, seat: 1 });
  await command(t, 'seat-participant', { participantId: t.bot, seat: 2 });
  if ((await read(t)).mode === 'online') {
    // Online Tables reject Deal until Automatic Dealing exists.
    await server.close();
    await startStoredHand(administration, schema, t.id);
    await start();
  } else await command(t, 'start-hand');
  await command(t, 'act', { participantId: t.human, action: { type: 'fold' } });
}
const join = (t: Table, cookie: string) => post('/api/join-links/' + encodeURIComponent(joinTokens.get(t.id)!) + '/join', cookie, { requestId: randomUUID() });
const joinTokens = new Map<string, string>();
async function settledAnalysis(t: Table, decisionId = 'hand-1/decision-1', cookie = t.cookie) {
  const requested = await (await post('/api/table-sessions/' + t.id + '/analysis', cookie, { decisionId })).json();
  await expect.poll(async () => (await (await get('/api/table-sessions/' + t.id + '/analysis/' + requested.requestId, cookie)).json()).status, { timeout: 10000 }).toBe('complete');
  return requested.requestId as string;
}
function live(cookie: string) {
  const socket = new WebSocket(base.replace('http:', 'ws:') + '/api/live', { headers: { cookie } });
  const messages: ServerLiveMessage[] = [];
  socket.on('message', data => messages.push(JSON.parse(data.toString())));
  socket.on('error', () => {});
  return {
    socket, messages,
    async subscribe(tableSessionId: string) {
      await expect.poll(() => messages[0]).toEqual({ type: 'user-channel-ready' });
      const requestId = randomUUID();
      socket.send(JSON.stringify({ type: 'subscribe-table', requestId, tableSessionId }));
      await expect.poll(() => messages.find(message => message.type === 'table-subscription-result' && message.requestId === requestId)).toBeDefined();
      const { requestId: _requestId, ...result } = messages.find(message => message.type === 'table-subscription-result' && message.requestId === requestId) as Extract<ServerLiveMessage, { type: 'table-subscription-result' }>;
      return result;
    },
  };
}
async function legacyLive(tableSessionId: string, cookie: string) {
  const socket = new WebSocket(base.replace('http:', 'ws:') + '/api/table-sessions/' + tableSessionId + '/live', { headers: { cookie } });
  socket.on('error', () => {});
  try {
    return await new Promise<{ status: number; body: unknown }>((resolve, reject) => {
      socket.once('open', () => reject(new Error('Expected a denied upgrade.')));
      socket.once('unexpected-response', (_request, response) => {
        let body = ''; response.on('data', chunk => { body += chunk; });
        response.once('end', () => resolve({ status: response.statusCode!, body: JSON.parse(body) }));
      });
    });
  } finally { socket.terminate(); }
}

test('a Guest who has not joined a table is refused every route and live subscription exactly as if it did not exist', async () => {
  const owner = await table(await guest());
  const stranger = await guest('Stranger');
  await table(stranger);
  const ownerChannel = live(owner.cookie);
  const strangerChannel = live(stranger);
  try {
    expect(await ownerChannel.subscribe(owner.id)).toEqual({ type: 'table-subscription-result', tableSessionId: owner.id, status: 'subscribed' });
    await completedHand(owner);
    const analysisRequestId = await settledAnalysis(owner);
    await expect.poll(() => ownerChannel.messages.some(message => message.type === 'analysis-update' && message.requestId === analysisRequestId)).toBe(true);
    const summary = await (await post('/api/table-sessions/' + owner.id + '/session-summaries', owner.cookie, {})).json();
    expect(summary).toMatchObject({ ok: true, decisionCount: 1 });
    const before = await read(owner);
    const missing = randomUUID();
    const pokerBody = { requestId: randomUUID(), expectedPokerRevision: before.pokerRevision, participantId: owner.human };
    const routes: [method: 'GET' | 'POST', suffix: string, body?: unknown][] = [
      ['GET', ''],
      ['POST', '/seat-participant', { ...pokerBody, participantId: owner.bot, seat: 3 }],
      ['POST', '/start-hand', { requestId: randomUUID(), expectedPokerRevision: before.pokerRevision }],
      ['POST', '/act', { ...pokerBody, action: { type: 'check' } }],
      ['POST', '/stand-up-participant', pokerBody],
      ['POST', '/move-participant', { ...pokerBody, seat: 4 }],
      ['POST', '/set-sitting-out', { ...pokerBody, sittingOut: true }],
      ['POST', '/top-up-to', { ...pokerBody, targetStack: 1000 }],
      ['POST', '/set-button', { requestId: randomUUID(), expectedPokerRevision: before.pokerRevision, seat: 2 }],
      ['POST', '/set-playing-strategy', { requestId: randomUUID(), expectedSessionRevision: before.sessionRevision, participantId: owner.bot, playingStrategy: highestProbabilityPlayingStrategy }],
      ['POST', '/retry-bot', { requestId: randomUUID(), expectedSessionRevision: before.sessionRevision, participantId: owner.bot }],
      ['POST', '/set-trainer-configuration', { requestId: randomUUID(), expectedSessionRevision: before.sessionRevision, trainerConfiguration: { referenceStrategy: highestProbabilityPlayingStrategy, liveAnalysis: true } }],
      ['POST', '/analysis', { decisionId: 'hand-1/decision-1' }],
      ['GET', '/analysis/' + analysisRequestId],
      ['POST', '/analysis/' + analysisRequestId + '/retry', {}],
      ['POST', '/hand-summaries', { handId: 'hand-1' }],
      ['POST', '/session-summaries', {}],
      ['GET', '/summaries/' + summary.requestId],
      ['POST', '/summaries/' + summary.requestId + '/retry', {}],
      ['POST', '/inspect-hand', { handId: 'hand-1' }],
    ];
    for (const [method, suffix, body] of routes) {
      const attempt = (id: string) => method === 'GET' ? get('/api/table-sessions/' + id + suffix, stranger) : post('/api/table-sessions/' + id + suffix, stranger, body);
      const refused = await attempt(owner.id);
      const absent = await attempt(missing);
      expect({ route: suffix, status: refused.status }).toEqual({ route: suffix, status: 404 });
      expect({ route: suffix, body: await refused.json() }).toEqual({ route: suffix, body: await absent.json() });
    }
    expect({ ...await strangerChannel.subscribe(owner.id), tableSessionId: missing }).toEqual(await strangerChannel.subscribe(missing));
    expect(await legacyLive(owner.id, stranger)).toEqual({ status: 404, body: (await legacyLive(missing, stranger)).body });
    const listed = await (await get('/api/table-sessions', stranger)).json();
    expect(JSON.stringify(listed)).not.toContain(owner.id);
    expect(await read(owner)).toEqual(before);
    // Neither the table's updates nor the owner's analysis notifications reach the stranger.
    expect(strangerChannel.messages.some(message => 'tableSessionId' in message && message.tableSessionId === owner.id && message.type !== 'table-subscription-result')).toBe(false);
  } finally { ownerChannel.socket.terminate(); strangerChannel.socket.terminate(); }
});

const refusal = async (response: Response) => ({ status: response.status, code: (await response.json()).rejection?.code });
test('each human acts, manages and studies only through their own Participant, and only the owner manages the table', async () => {
  const owner = await table(await guest('Ann'), 'online');
  joinTokens.set(owner.id, (await read(owner)).joinToken!);
  await completedHand(owner);
  const ownerAnalysis = await settledAnalysis(owner);
  const ownerSummary = await (await post('/api/table-sessions/' + owner.id + '/session-summaries', owner.cookie, {})).json();
  const otherCookie = await guest('Ben'), leftCookie = await guest('Cy'), removedCookie = await guest('Di');
  const joined = await join(owner, otherCookie);
  expect(joined.status).toBe(200);
  const other = (await joined.json()).participantId as string;
  await bindHuman(owner, leftCookie, 'Cy', 'left');
  await bindHuman(owner, removedCookie, 'Di', 'removed');
  const ben = { ...owner, cookie: otherCookie };

  const seen = await read(ben);
  // Joining after the Hand, Ben observes none of it.
  expect(seen).toMatchObject({ mode: 'online', trainerConfiguration: defaultTrainerConfiguration, viewerParticipantId: other, view: { history: [] } });
  expect(seen.view.state.participants).toEqual(expect.arrayContaining([{ participantId: owner.human, seat: 1, stack: 990, sittingOut: false }, { participantId: owner.bot, seat: 2, stack: 1010, sittingOut: false }]));
  expect(seen.bindings).toContainEqual({ participantId: other, name: 'Ben', controller: { kind: 'human' } });
  for (const cookie of [leftCookie, removedCookie]) {
    expect((await get('/api/table-sessions/' + owner.id, cookie)).status).toBe(404);
    expect(await (await get('/api/table-sessions', cookie)).json()).toEqual({ tables: [] });
  }
  expect(await (await get('/api/table-sessions', otherCookie)).json()).toEqual({ tables: [{ tableSessionId: owner.id, mode: 'online' }] });
  expect((await (await get('/api/table-sessions', owner.cookie)).json()).tables).toContainEqual({ tableSessionId: owner.id, mode: 'online' });

  // Trainer configuration belongs to each Participant. Another Guest's identical retry never receives its outcome.
  const ownerStudy = { referenceStrategy: highestProbabilityPlayingStrategy, liveAnalysis: true };
  const otherStudy = { referenceStrategy: baselinePlayingStrategy, liveAnalysis: false };
  const study = { requestId: 'study', expectedSessionRevision: (await read(owner)).sessionRevision, trainerConfiguration: ownerStudy };
  const configure = (cookie: string, body: object) => post('/api/table-sessions/' + owner.id + '/set-trainer-configuration', cookie, body);
  expect((await configure(owner.cookie, study)).status).toBe(200);
  expect(await refusal(await configure(otherCookie, study))).toEqual({ status: 409, code: 'request-id-conflict' });
  expect(await read(ben)).toMatchObject({ trainerConfiguration: defaultTrainerConfiguration });
  expect((await configure(otherCookie, { requestId: randomUUID(), expectedSessionRevision: (await read(ben)).sessionRevision, trainerConfiguration: otherStudy })).status).toBe(200);
  expect(await read(owner)).toMatchObject({ trainerConfiguration: ownerStudy });
  expect(await read(ben)).toMatchObject({ trainerConfiguration: otherStudy });

  // Nobody acts for or manages another human, the owner included; only the owner deals and manages Bots.
  const revision = (await read(owner)).pokerRevision, sessionRevision = (await read(owner)).sessionRevision;
  const poker = (t: Table, kind: string, contents: object) => post('/api/table-sessions/' + t.id + '/' + kind, t.cookie, { requestId: randomUUID(), expectedPokerRevision: revision, ...contents });
  for (const [t, target] of [[ben, owner.human], [owner, other]] as const) {
    for (const [kind, contents] of [['seat-participant', { seat: 4 }], ['act', { action: { type: 'check' } }], ['stand-up-participant', {}], ['move-participant', { seat: 5 }], ['set-sitting-out', { sittingOut: true }], ['top-up-to', { targetStack: 1000 }]] as const)
      expect({ kind, ...await refusal(await poker(t, kind, { participantId: target, ...contents })) }).toEqual({ kind, status: 403, code: 'not-your-participant' });
  }
  const ownerOnly: [string, object][] = [
    ['seat-participant', { requestId: randomUUID(), expectedPokerRevision: revision, participantId: owner.bot, seat: 4 }],
    ['set-sitting-out', { requestId: randomUUID(), expectedPokerRevision: revision, participantId: owner.bot, sittingOut: true }],
    ['start-hand', { requestId: randomUUID(), expectedPokerRevision: revision }],
    ['set-button', { requestId: randomUUID(), expectedPokerRevision: revision, seat: 2 }],
    ['set-playing-strategy', { requestId: randomUUID(), expectedSessionRevision: sessionRevision, participantId: owner.bot, playingStrategy: simpleHeuristicPlayingStrategy }],
    ['retry-bot', { requestId: randomUUID(), expectedSessionRevision: sessionRevision, participantId: owner.bot }],
    ['inspect-hand', { handId: 'hand-1' }],
  ];
  for (const [kind, body] of ownerOnly) expect({ kind, ...await refusal(await post('/api/table-sessions/' + owner.id + '/' + kind, otherCookie, body)) }).toEqual({ kind, status: 403, code: 'table-owner-required' });
  expect(await read(owner)).toMatchObject({ pokerRevision: revision, sessionRevision });
  expect((await poker(ben, 'seat-participant', { participantId: other, seat: 3 })).status).toBe(200);
  expect((await read(owner)).view.state.participants).toContainEqual({ participantId: other, seat: 3, stack: 1000, sittingOut: false });

  // Analysis, scores and summaries are read, retried and notified only for their own Participant.
  const ownerChannel = live(owner.cookie), otherChannel = live(otherCookie);
  try {
    expect(await otherChannel.subscribe(owner.id)).toMatchObject({ status: 'subscribed' });
    await expect.poll(() => otherChannel.messages.find(message => message.type === 'table-update')).toMatchObject({ trainerConfiguration: otherStudy });
    await expect.poll(() => ownerChannel.messages[0]).toEqual({ type: 'user-channel-ready' });
    const restudied = await settledAnalysis(owner);
    expect(restudied).not.toBe(ownerAnalysis);
    await expect.poll(() => ownerChannel.messages.some(message => message.type === 'analysis-update' && message.requestId === restudied)).toBe(true);
    expect(otherChannel.messages.some(message => message.type === 'analysis-update')).toBe(false);
  } finally { ownerChannel.socket.terminate(); otherChannel.socket.terminate(); }
  expect((await get('/api/table-sessions/' + owner.id + '/analysis/' + ownerAnalysis, otherCookie)).status).toBe(404);
  expect((await post('/api/table-sessions/' + owner.id + '/analysis/' + ownerAnalysis + '/retry', otherCookie, {})).status).toBe(404);
  expect(await (await get('/api/table-sessions/' + owner.id + '/analysis/' + ownerAnalysis, owner.cookie)).json()).toMatchObject({ status: 'complete', participantId: owner.human });
  expect(await refusal(await post('/api/table-sessions/' + owner.id + '/analysis', otherCookie, { decisionId: 'hand-1/decision-1' }))).toEqual({ status: 400, code: 'decision-unavailable' });
  expect((await get('/api/table-sessions/' + owner.id + '/summaries/' + ownerSummary.requestId, otherCookie)).status).toBe(404);
  expect((await post('/api/table-sessions/' + owner.id + '/summaries/' + ownerSummary.requestId + '/retry', otherCookie, {})).status).toBe(404);
  expect(await (await post('/api/table-sessions/' + owner.id + '/session-summaries', otherCookie, {})).json()).toMatchObject({ ok: true, status: 'empty', decisionCount: 0, referenceStrategy: baselinePlayingStrategy });
});
