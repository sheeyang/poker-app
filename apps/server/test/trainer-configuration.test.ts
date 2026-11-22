import { afterAll, beforeAll, expect, test } from 'vitest';
import { nameGuest } from './fixtures/guest.js';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import WebSocket from 'ws';
import { baselinePlayingStrategy, defaultPlayingStrategy, defaultTrainerConfiguration, highestProbabilityPlayingStrategy, type ObservableTableSession, type ServerLiveMessage, type TrainerConfiguration } from '@poker/contracts';
import { createServer } from '../src/server.js';
import { InstantClock } from './fixtures/clock.js';

// Not a timing test: every Presentation Phase ends at once (see fixtures/clock.ts).
const clock = new InstantClock();

const databaseUrl = process.env.TEST_DATABASE_URL!;
const schema = 'test_' + randomUUID().replaceAll('-', '');
const administration = new Pool({ connectionString: databaseUrl });
let server: Awaited<ReturnType<typeof createServer>>;
let base: string;
async function start() {
  server = await createServer({ clock, automaticBots: false, databaseUrl, schema });
  base = await server.listen({ host: '127.0.0.1', port: 0 });
}
beforeAll(async () => {
  await administration.query('CREATE SCHEMA "' + schema + '"');
  await start();
});
afterAll(async () => { await server?.close(); await administration.query('DROP SCHEMA "' + schema + '" CASCADE'); await administration.end(); });

async function guest() {
  const identity = await fetch(base + '/api/identity');
  const cookie = identity.headers.get('set-cookie')!.split(';')[0]!;
  await nameGuest(base, cookie);
  return cookie;
}
async function table(cookie: string, body: object = {}) {
  const creation = await fetch(base + '/api/table-sessions', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ requestId: randomUUID(), bots: [{ name: 'Bot', playingStrategy: baselinePlayingStrategy }], ...body }) });
  expect(creation.status).toBe(201);
  const result = await creation.json();
  return { id: result.tableSessionId as string, cookie, human: result.bindings[0].participantId as string, bot: result.bindings[1].participantId as string };
}
type Table = Awaited<ReturnType<typeof table>>;
const read = async (t: Table): Promise<ObservableTableSession> => (await fetch(base + '/api/table-sessions/' + t.id, { headers: { cookie: t.cookie } })).json();
const post = (t: Table, path: string, body: unknown) => fetch(base + '/api/table-sessions/' + t.id + '/' + path, { method: 'POST', headers: { cookie: t.cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) });
async function command(t: Table, kind: string, body: object = {}) {
  const before = await read(t);
  expect((await post(t, kind, { requestId: randomUUID(), expectedPokerRevision: before.pokerRevision, ...body })).status).toBe(200);
}
/** A table at the Guest's first decision of its first Hand. */
async function decision(cookie: string, body: object = {}) {
  const t = await table(cookie, body);
  await command(t, 'seat-participant', { participantId: t.human, seat: 1 });
  await command(t, 'seat-participant', { participantId: t.bot, seat: 2 });
  await command(t, 'start-hand');
  await expect.poll(async () => (await read(t)).view.state.actorId).toBe(t.human);
  return t;
}
const configuration = async (cookie: string) => fetch(base + '/api/trainer-configuration', { headers: { cookie } });
const configure = (cookie: string, body: object) => fetch(base + '/api/trainer-configuration', { method: 'PUT', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) });
const chosen: TrainerConfiguration = { referenceStrategy: highestProbabilityPlayingStrategy, liveAnalysis: true };
const change = (trainerConfiguration: TrainerConfiguration = chosen, requestId: string = randomUUID()) => ({ requestId, trainerConfiguration });
const analyze = async (t: Table, decisionId?: string) => (await post(t, 'analysis', { decisionId: decisionId ?? (await read(t)).view.state.decisionId })).json();

test('a Guest starts from the default Trainer Configuration, with Live Analysis on', async () => {
  const cookie = await guest();
  const response = await configuration(cookie);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true, trainerConfiguration: defaultTrainerConfiguration });
  expect(await read(await table(cookie))).toMatchObject({ trainerConfiguration: { referenceStrategy: defaultPlayingStrategy, liveAnalysis: true } });
});

test('a Reference Strategy set once is used by new analysis at two different tables and presented by both table views', async () => {
  const cookie = await guest();
  const first = await decision(cookie);
  const before = await read(first);
  const response = await configure(cookie, change());
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true, trainerConfiguration: chosen });
  // The change is the Guest's, not the table's: it advances no revision.
  expect(await read(first)).toMatchObject({ pokerRevision: before.pokerRevision, sessionRevision: before.sessionRevision, trainerConfiguration: chosen });
  const second = await decision(cookie);
  expect(await read(second)).toMatchObject({ trainerConfiguration: chosen });
  expect(await analyze(first)).toMatchObject({ ok: true, tableSessionId: first.id, referenceStrategy: highestProbabilityPlayingStrategy });
  expect(await analyze(second)).toMatchObject({ ok: true, tableSessionId: second.id, referenceStrategy: highestProbabilityPlayingStrategy });
  expect(await (await configuration(cookie)).json()).toEqual({ ok: true, trainerConfiguration: chosen });
});

test('repeating a change with the same request ID applies it once, and a request ID cannot be reused for another configuration', async () => {
  const cookie = await guest();
  const first = change(chosen, 'first');
  const responses = await Promise.all([configure(cookie, first), configure(cookie, first)]);
  expect(responses.map(response => response.status)).toEqual([200, 200]);
  expect(await responses[1]!.json()).toEqual(await responses[0]!.json());
  const later: TrainerConfiguration = { referenceStrategy: baselinePlayingStrategy, liveAnalysis: false };
  expect((await configure(cookie, change(later))).status).toBe(200);
  // The repeated first request answers as it did, and does not undo the later change.
  expect(await (await configure(cookie, first)).json()).toEqual({ ok: true, trainerConfiguration: chosen });
  expect(await (await configuration(cookie)).json()).toEqual({ ok: true, trainerConfiguration: later });
  const conflict = await configure(cookie, change(later, 'first'));
  expect(conflict.status).toBe(409);
  expect(await conflict.json()).toMatchObject({ ok: false, rejection: { code: 'request-id-conflict' } });
  // Another Guest's request IDs are their own.
  const other = await guest();
  expect(await (await configure(other, change(later, 'first'))).json()).toEqual({ ok: true, trainerConfiguration: later });
});

test('a change notifies every connection of the Guest, and theirs only, which then read the new configuration', async () => {
  const cookie = await guest(), other = await guest();
  const listen = (owner: string) => {
    const socket = new WebSocket(base.replace('http:', 'ws:') + '/api/live', { headers: { cookie: owner } });
    const messages: ServerLiveMessage[] = [];
    socket.on('error', () => {});
    socket.on('message', data => messages.push(JSON.parse(data.toString())));
    return { socket, messages, changes: () => messages.filter(message => message.type === 'trainer-configuration-changed').length };
  };
  const tabs = [listen(cookie), listen(cookie)], stranger = listen(other);
  try {
    for (const tab of [...tabs, stranger]) await expect.poll(() => tab.messages[0]).toEqual({ type: 'user-channel-ready' });
    const request = change();
    expect((await configure(cookie, request)).status).toBe(200);
    for (const tab of tabs) await expect.poll(() => tab.changes()).toBe(1);
    expect(tabs[0]!.messages.at(-1)).toEqual({ type: 'trainer-configuration-changed' });
    expect(await (await configuration(cookie)).json()).toEqual({ ok: true, trainerConfiguration: chosen });
    // A repeated request changes nothing, so nobody is told again.
    expect((await configure(cookie, request)).status).toBe(200);
    expect((await configure(other, change(defaultTrainerConfiguration))).status).toBe(200);
    await expect.poll(() => stranger.changes()).toBe(1);
    for (const tab of tabs) expect(tab.changes()).toBe(1);
  } finally { for (const tab of [...tabs, stranger]) tab.socket.terminate(); }
});

test('analysis and summaries requested before a change keep the Strategy they captured', async () => {
  const cookie = await guest();
  const t = await decision(cookie);
  const live = await analyze(t);
  expect(live).toMatchObject({ referenceStrategy: defaultPlayingStrategy });
  const summary = await (await post(t, 'session-summaries', {})).json();
  expect(summary).toMatchObject({ referenceStrategy: defaultPlayingStrategy });
  expect((await configure(cookie, change())).status).toBe(200);
  const kept = await (await fetch(base + '/api/table-sessions/' + t.id + '/analysis/' + live.requestId, { headers: { cookie } })).json();
  expect(kept).toMatchObject({ requestId: live.requestId, referenceStrategy: defaultPlayingStrategy });
  const keptSummary = await (await fetch(base + '/api/table-sessions/' + t.id + '/summaries/' + summary.requestId, { headers: { cookie } })).json();
  expect(keptSummary).toMatchObject({ requestId: summary.requestId, referenceStrategy: defaultPlayingStrategy });
  // A new request captures the configuration as it is now.
  expect(await analyze(t)).toMatchObject({ referenceStrategy: highestProbabilityPlayingStrategy });
  expect(await (await post(t, 'session-summaries', {})).json()).toMatchObject({ referenceStrategy: highestProbabilityPlayingStrategy });
});

test.each([
  { trainerConfiguration: { ...chosen, unknown: true } },
  { trainerConfiguration: { referenceStrategy: highestProbabilityPlayingStrategy } },
  { trainerConfiguration: { ...chosen, liveAnalysis: 'true' } },
  { trainerConfiguration: { ...chosen, referenceStrategy: { ...highestProbabilityPlayingStrategy, selector: { id: 'unknown', version: 'v1', configuration: {} } } } },
  { trainerConfiguration: chosen, expectedSessionRevision: 0 },
  {},
])('an invalid or unsupported configuration changes nothing: %j', async contents => {
  const cookie = await guest();
  const response = await configure(cookie, { requestId: randomUUID(), ...contents });
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ ok: false });
  expect(await (await configuration(cookie)).json()).toEqual({ ok: true, trainerConfiguration: defaultTrainerConfiguration });
});

test('an unidentified caller can neither read nor change a Trainer Configuration, and a request needs a request ID', async () => {
  expect((await configuration('')).status).toBe(401);
  expect((await configure('', change())).status).toBe(401);
  expect((await configure(await guest(), { trainerConfiguration: chosen })).status).toBe(400);
});

test('a change survives a restart, and a table persisted with per-Participant configurations loads with each Guest on their own configuration', async () => {
  const cookie = await guest(), untouched = await guest();
  const t = await table(cookie), u = await table(untouched);
  expect((await configure(cookie, change())).status).toBe(200);
  await server.close();
  // An external persistence fixture simulates rows written before M6: each human Participant kept its own configuration.
  const legacy = JSON.stringify({ referenceStrategy: baselinePlayingStrategy, liveAnalysis: false });
  await administration.query('UPDATE "' + schema + '".table_sessions SET aggregate = jsonb_set(jsonb_set(aggregate, \'{schemaVersion}\', \'2\'), \'{bindings,0,trainerConfiguration}\', $2::jsonb) WHERE id = ANY($1)', [[t.id, u.id], legacy]);
  await start();
  expect(await read(t)).toMatchObject({ trainerConfiguration: chosen });
  expect(await read(u)).toMatchObject({ trainerConfiguration: defaultTrainerConfiguration });
  expect(await (await configuration(untouched)).json()).toEqual({ ok: true, trainerConfiguration: defaultTrainerConfiguration });
  // The old per-table route is gone: the configuration is no table's.
  expect((await post(t, 'set-trainer-configuration', { requestId: randomUUID(), expectedSessionRevision: 0, trainerConfiguration: chosen })).status).toBe(404);
});
