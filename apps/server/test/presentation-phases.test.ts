import { afterAll, beforeAll, expect, test } from 'vitest';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import WebSocket from 'ws';
import { baselinePlayingStrategy, defaultConfiguration, defaultTrainerConfiguration, type ConcreteAction, type ObservableGameConfiguration, type ObservableTableSession, type ObservableTableUpdate, type ServerLiveMessage, type StrategyDescriptor } from '@poker/contracts';
import { CashGame } from '@poker/engine';
import { createStrategy, HighestProbabilitySelector, isSupportedStrategy, type PolicyResult } from '@poker/strategies';
import { createServer } from '../src/server.js';
import type { TableSessionControllerCommands } from '../src/mutations.js';
import { nameGuest } from './fixtures/guest.js';
import { ManualClock } from './fixtures/clock.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('Set TEST_DATABASE_URL to a real PostgreSQL test database.');
const schema = 'test_' + randomUUID().replaceAll('-', '');
const administration = new Pool({ connectionString: databaseUrl });
const clock = new ManualClock();
let server: Awaited<ReturnType<typeof createServer>>;
let base: string;
let controllers: TableSessionControllerCommands;
async function startServer() {
  server = await createServer({ clock, automaticBots: false, databaseUrl: databaseUrl!, schema, onControllerCommandsReady: commands => { controllers = commands; } });
  base = await server.listen({ host: '127.0.0.1', port: 0 });
}
beforeAll(async () => { await administration.query('CREATE SCHEMA "' + schema + '"'); await startServer(); });
afterAll(async () => { await server?.close(); await administration.query('DROP SCHEMA "' + schema + '" CASCADE'); await administration.end(); });

type Table = { id: string; cookie: string; ids: string[]; revision: number };
async function table(count = 2, configuration: Partial<ObservableGameConfiguration> = {}): Promise<Table> {
  const cookie = (await fetch(base + '/api/identity')).headers.get('set-cookie')!.split(';')[0]!; await nameGuest(base, cookie);
  const response = await fetch(base + '/api/table-sessions', { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ requestId: randomUUID(), configuration, bots: Array.from({ length: count - 1 }, (_, i) => ({ name: 'Bot ' + (i + 1), playingStrategy: baselinePlayingStrategy })) }) });
  expect(response.status).toBe(201); const created = await response.json();
  return { id: created.tableSessionId, cookie, ids: created.bindings.map((b: { participantId: string }) => b.participantId), revision: 0 };
}
const submit = (t: Table, kind: string, fields: object, requestId: string = randomUUID()) => fetch(base + '/api/table-sessions/' + t.id + '/' + kind, { method: 'POST', headers: { 'content-type': 'application/json', cookie: t.cookie }, body: JSON.stringify({ requestId, expectedPokerRevision: t.revision, ...fields }) });
const read = async (t: Table): Promise<ObservableTableSession> => (await (await fetch(base + '/api/table-sessions/' + t.id, { headers: { cookie: t.cookie } })).json());
async function command(t: Table, kind: string, fields: object = {}) {
  const response = await submit(t, kind, fields); expect(response.status).toBe(200);
  const result = await response.json(); t.revision = result.pokerRevision; return result;
}
/** The human acts through HTTP; Bots through the trusted controller commands. */
async function act(t: Table, participantId: string, action: ConcreteAction) {
  if (participantId === t.ids[0]) return submit(t, 'act', { participantId, action });
  const outcome = await controllers.submitAction(t.id, { requestId: randomUUID(), expectedPokerRevision: t.revision, participantId, action });
  return Response.json(outcome, { status: outcome.ok ? 200 : 409 });
}
async function accepted(t: Table, participantId: string, action: ConcreteAction) {
  const response = await act(t, participantId, action); expect(response.status).toBe(200);
  t.revision = (await response.json()).pokerRevision;
}
async function headsUp() {
  const t = await table(2); const [human, bot] = t.ids as [string, string];
  await command(t, 'seat-participant', { participantId: human, seat: 1 }); await command(t, 'seat-participant', { participantId: bot, seat: 4 });
  return { t, human, bot };
}

test('a deal opens the first Action Window only when its 1.5 s deal phase ends', async () => {
  const { t, human } = await headsUp();
  const dealt = clock.now();
  await command(t, 'start-hand');
  const view = await read(t);
  expect(view.serverTime).toBe(dealt);
  expect(view.schedule).toEqual({
    phases: [{ kind: 'deal', handId: 'hand-1', street: 'preflop', startsAt: dealt, endsAt: dealt + 1500, durationMs: 1500 }],
    actionWindow: { participantId: human, decisionId: 'hand-1/decision-1', opensAt: dealt + 1500 },
  });
  clock.advance(1499);
  const early = await act(t, human, { type: 'call' });
  expect(early.status).toBe(409);
  expect(await early.json()).toMatchObject({ ok: false, rejection: { code: 'action-window-not-open' } });
  expect(await read(t)).toEqual({ ...view, serverTime: dealt + 1499 });
  clock.advance(1);
  await accepted(t, human, { type: 'call' });
  expect((await read(t)).view.state).toMatchObject({ actorId: t.ids[1], street: 'preflop' });
});

test('each completed betting round reveals its street in a 1 s phase and exposes nothing of later streets', async () => {
  const { t, human, bot } = await headsUp();
  const dealt = clock.now();
  await command(t, 'start-hand');
  clock.advance(1500);
  await accepted(t, human, { type: 'call' });
  // The Bot's option follows a decision, not a phase: its window opens at once.
  const option = await read(t);
  expect(option.schedule.actionWindow).toEqual({ participantId: bot, decisionId: 'hand-1/decision-2', opensAt: dealt + 1500 });
  await accepted(t, bot, { type: 'check' });
  const flopAt = clock.now();
  const flop = await read(t);
  expect(flop.view.state).toMatchObject({ street: 'flop', actorId: bot });
  expect(flop.view.state.board).toHaveLength(3);
  expect(flop.schedule).toEqual({
    phases: [
      { kind: 'deal', handId: 'hand-1', street: 'preflop', startsAt: dealt, endsAt: dealt + 1500, durationMs: 1500 },
      { kind: 'street', handId: 'hand-1', street: 'flop', startsAt: flopAt, endsAt: flopAt + 1000, durationMs: 1000 },
    ],
    actionWindow: { participantId: bot, decisionId: flop.view.state.decisionId, opensAt: flopAt + 1000 },
  });
  // During normal betting the view holds no future street, opponent cards, burns or deck order.
  expect(flop.view.state.participants.find(p => p.participantId === bot)).not.toHaveProperty('holeCards');
  expect(JSON.stringify(flop)).not.toMatch(/"(?:seed|deck|burns|drawnCardCount|commands)"\s*:/);
  expect(JSON.stringify(flop.schedule)).not.toMatch(/turn|river/);

  expect(await (await act(t, bot, { type: 'check' })).json()).toMatchObject({ ok: false, rejection: { code: 'action-window-not-open' } });
  clock.advance(1000);
  await accepted(t, bot, { type: 'check' });
  await accepted(t, human, { type: 'check' });
  const turnAt = clock.now();
  const turn = await read(t);
  expect(turn.view.state.board).toHaveLength(4);
  expect(turn.schedule.phases.at(-1)).toEqual({ kind: 'street', handId: 'hand-1', street: 'turn', startsAt: turnAt, endsAt: turnAt + 1000, durationMs: 1000 });
  expect(turn.schedule.actionWindow).toMatchObject({ participantId: bot, opensAt: turnAt + 1000 });
  // Presentation Phases are never poker commands.
  expect((await controllers.readPersistedSession(t.id))!.pokerRecord.commands.map(c => c.type)).toEqual(['seat-participant', 'seat-participant', 'start-hand', 'act', 'act', 'act', 'act']);
});

function connect(t: Table) {
  const socket = new WebSocket(base.replace('http:', 'ws:') + '/api/live', { headers: { cookie: t.cookie } });
  const messages: ServerLiveMessage[] = [];
  socket.on('message', data => messages.push(JSON.parse(data.toString())));
  socket.on('open', () => socket.send(JSON.stringify({ type: 'subscribe-table', requestId: randomUUID(), tableSessionId: t.id })));
  const updates = () => messages.filter((m): m is ObservableTableUpdate => m.type === 'table-update');
  return { socket, updates, async next(revision: number) {
    await expect.poll(() => updates().some(m => m.sessionRevision === revision)).toBe(true);
    return updates().find(m => m.sessionRevision === revision)!;
  } };
}

test('live updates and reads carry the schedule and server time, and a restart keeps the scheduled Action Window', async () => {
  const { t, human } = await headsUp();
  const live = connect(t);
  let reconnected: ReturnType<typeof connect> | undefined;
  try {
    const subscribed = await live.next(2);
    expect(subscribed).toMatchObject({ schedule: { phases: [], actionWindow: null }, serverTime: clock.now(), presentationEvents: [] });
    const dealt = clock.now();
    await command(t, 'start-hand');
    const update = await live.next(3);
    const read3 = await read(t);
    expect(update).toEqual({ ...read3, type: 'table-update', runtimeStatus: undefined, presentationEvents: update.presentationEvents });
    expect(update.presentationEvents.map(e => e.type)).toContain('hole-cards-dealt');
    expect(update.schedule.actionWindow).toEqual({ participantId: human, decisionId: 'hand-1/decision-1', opensAt: dealt + 1500 });

    clock.advance(500);
    live.socket.terminate();
    await server.close(); await startServer();
    const restored = await read(t);
    expect(restored).toEqual({ ...read3, serverTime: dealt + 500 });
    // A reconnecting client receives the current schedule; elapsed or running phases are not replayed as events.
    reconnected = connect(t);
    expect(await reconnected.next(3)).toMatchObject({ schedule: read3.schedule, serverTime: dealt + 500, presentationEvents: [] });
    expect(await (await act(t, human, { type: 'call' })).json()).toMatchObject({ ok: false, rejection: { code: 'action-window-not-open' } });
    clock.advance(1000);
    await accepted(t, human, { type: 'call' });
    expect((await reconnected.next(4)).serverTime).toBe(dealt + 1500);
  } finally { live.socket.terminate(); reconnected?.socket.terminate(); }
});

test('a table written before scheduled play keeps its current decision open', async () => {
  const userId = randomUUID(), token = randomBytes(32).toString('base64url'), id = randomUUID(), human = randomUUID(), bot = randomUUID();
  const created = CashGame.create({ ...defaultConfiguration, seed: 'unscheduled-'.padEnd(64, '0') });
  if (!created.ok) throw new Error(created.rejection.code);
  for (const result of [created.game.seatParticipant(human, 1), created.game.seatParticipant(bot, 2), created.game.startHand()]) if (!result.ok) throw new Error(result.rejection.code);
  const aggregate = { schemaVersion: 1, tableSessionId: id, ownerUserId: userId, pokerRecord: created.game.toRecord(), pokerRevision: 3, sessionRevision: 3, adminMode: true, botProvenance: [],
    bindings: [{ participantId: human, name: 'You', controller: { kind: 'human' }, userId }, { participantId: bot, name: 'Bot', controller: { kind: 'bot', playingStrategy: baselinePlayingStrategy }, assignmentId: randomUUID() }],
    trainerConfiguration: defaultTrainerConfiguration };
  await administration.query(`INSERT INTO "${schema}".local_users (id, token_hash) VALUES ($1, $2)`, [userId, createHash('sha256').update(token).digest('hex')]);
  await administration.query(`INSERT INTO "${schema}".table_sessions (id, owner_user_id, aggregate) VALUES ($1, $2, $3)`, [id, userId, aggregate]);
  await server.close(); await startServer(); // Startup indexes version-1 memberships.
  const t: Table = { id, cookie: 'poker_local=' + token, ids: [human, bot], revision: 3 };
  expect((await read(t)).schedule).toEqual({ phases: [], actionWindow: { participantId: human, decisionId: 'hand-1/decision-1', opensAt: 0 } });
  await accepted(t, human, { type: 'call' });
  expect((await read(t)).schedule).toEqual({ phases: [], actionWindow: { participantId: bot, decisionId: 'hand-1/decision-2', opensAt: clock.now() } });
});

test('a Bot decision is requested only once its Action Window opens, including after a restart', async () => {
  const botSchema = 'test_' + randomUUID().replaceAll('-', '');
  await administration.query('CREATE SCHEMA "' + botSchema + '"');
  const botClock = new ManualClock();
  const evaluations: { decisionId: string; result: ReturnType<typeof Promise.withResolvers<PolicyResult>> }[] = [];
  const fixture: StrategyDescriptor = { policy: { id: 'fixture', version: 'v1', configuration: {} }, selector: { id: 'highest-probability', version: 'v1', configuration: {} } };
  let botServer: Awaited<ReturnType<typeof createServer>> | undefined;
  let botBase = '';
  const start = async () => {
    botServer = await createServer({ clock: botClock, databaseUrl: databaseUrl!, schema: botSchema, supportsStrategy: value => (value as StrategyDescriptor)?.policy?.id === 'fixture' || isSupportedStrategy(value),
      strategyFactory: descriptor => descriptor.policy.id !== 'fixture' ? createStrategy(descriptor) : { actionSelector: new HighestProbabilitySelector(), policy: {
        checkCompatibility: () => ({ compatible: true }),
        evaluate: view => { const result = Promise.withResolvers<PolicyResult>(); evaluations.push({ decisionId: view.state.decisionId!, result }); return result.promise; },
      } } });
    botBase = await botServer.listen({ host: '127.0.0.1', port: 0 });
  };
  await start();
  try {
    const cookie = (await fetch(botBase + '/api/identity')).headers.get('set-cookie')!.split(';')[0]!; await nameGuest(botBase, cookie);
    const post = (path: string, body: object) => fetch(botBase + '/api/table-sessions' + path, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ requestId: randomUUID(), ...body }) });
    const created = await (await post('', { bots: [{ name: 'Bot', playingStrategy: fixture }] })).json();
    const [human, bot] = created.bindings.map((b: { participantId: string }) => b.participantId) as [string, string];
    const readBot = async (): Promise<ObservableTableSession> => (await fetch(botBase + '/api/table-sessions/' + created.tableSessionId, { headers: { cookie } })).json();
    // The Bot holds seat 1, so it acts first in heads-up preflop.
    expect((await post('/' + created.tableSessionId + '/seat-participant', { expectedPokerRevision: 0, participantId: bot, seat: 1 })).status).toBe(200);
    expect((await post('/' + created.tableSessionId + '/seat-participant', { expectedPokerRevision: 1, participantId: human, seat: 4 })).status).toBe(200);
    expect((await post('/' + created.tableSessionId + '/start-hand', { expectedPokerRevision: 2 })).status).toBe(200);
    expect((await readBot()).view.state.actorId).toBe(bot);
    botClock.advance(1000);
    await botServer!.close(); await start();
    expect((await readBot()).view.state.actorId).toBe(bot);
    botClock.advance(499);
    await readBot();
    expect(evaluations).toEqual([]);
    botClock.advance(1);
    await expect.poll(() => evaluations.length).toBe(1);
    expect(evaluations[0]!.decisionId).toBe('hand-1/decision-1');
    evaluations[0]!.result.resolve({ choices: [{ action: { type: 'call' }, probability: 1 }] });
    await expect.poll(async () => (await readBot()).view.state.actorId).toBe(human);
    expect(evaluations).toHaveLength(1);
  } finally {
    for (const evaluation of evaluations) evaluation.result.resolve({ choices: [{ action: { type: 'fold' }, probability: 1 }] });
    await botServer?.close(); await administration.query('DROP SCHEMA "' + botSchema + '" CASCADE');
  }
});

test('an all-in runout schedules the reveals, its remaining streets and the payout one after another, and opens no Action Window', async () => {
  const { t, human, bot } = await headsUp();
  await command(t, 'start-hand');
  clock.advance(1500);
  await accepted(t, human, { type: 'raise', raiseTo: 1000 });
  await accepted(t, bot, { type: 'call' });
  const at = clock.now();
  const done = await read(t);
  expect(done.view.state).toMatchObject({ status: 'completed-hand', actorId: null });
  expect(done.view.state.board).toHaveLength(5);
  // The complete result is already in the view; it is presented step by step at these server times.
  expect(done.schedule).toEqual({
    phases: [
      { kind: 'deal', handId: 'hand-1', street: 'preflop', startsAt: at - 1500, endsAt: at, durationMs: 1500 },
      { kind: 'showdown', handId: 'hand-1', street: 'preflop', startsAt: at, endsAt: at + 2000, durationMs: 2000 },
      { kind: 'street', handId: 'hand-1', street: 'flop', startsAt: at + 2000, endsAt: at + 3000, durationMs: 1000 },
      { kind: 'street', handId: 'hand-1', street: 'turn', startsAt: at + 3000, endsAt: at + 4000, durationMs: 1000 },
      { kind: 'street', handId: 'hand-1', street: 'river', startsAt: at + 4000, endsAt: at + 5000, durationMs: 1000 },
      { kind: 'payout', handId: 'hand-1', street: 'river', startsAt: at + 5000, endsAt: at + 7000, durationMs: 2000 },
    ],
    actionWindow: null,
  });
});
