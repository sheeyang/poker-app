import { afterAll, beforeAll, expect, test } from 'vitest';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import WebSocket from 'ws';
import { baselinePlayingStrategy, defaultConfiguration, defaultTrainerConfiguration, dealBeats, presentationPhaseDurations, settleAfter, showdownBeats, streetBeats, type ConcreteAction, type ObservableGameConfiguration, type ObservableTableSession, type ObservableTableUpdate, type ServerLiveMessage, type StrategyDescriptor } from '@poker/contracts';
import { CashGame } from '@poker/engine';
import { createStrategy, HighestProbabilitySelector, isSupportedStrategy, type PolicyResult } from '@poker/strategies';
import { createServer } from '../src/server.js';
import type { TableSessionControllerCommands } from '../src/mutations.js';
import { nameGuest } from './fixtures/guest.js';
import { ManualClock } from './fixtures/clock.js';
import { backToBack } from './fixtures/phases.js';
import { dealMs } from './fixtures/presentation.js';

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

/** Each phase's shared length at a Practice Table (a heads-up deal), and the Settle that follows it. */
const deal = dealMs(2), payout = presentationPhaseDurations.payout;
const settled = { deal: settleAfter('deal', 'practice'), street: settleAfter('street', 'practice'), showdown: settleAfter('showdown', 'practice'), payout: settleAfter('payout', 'practice') };

test('a deal carries what it presents, lasts as long as its beats, and is followed by its Settle; the first Action Window opens when the Settle ends', async () => {
  const { t, human, bot } = await headsUp();
  const dealt = clock.now();
  await command(t, 'start-hand');
  const view = await read(t);
  expect(view.serverTime).toBe(dealt);
  // Heads-up the button (seat 1, the small blind) is dealt first.
  const inputs = { dealt: [{ participantId: human, cardCount: 2 }, { participantId: bot, cardCount: 2 }], blinds: [human, bot], refills: [] };
  const length = dealBeats(inputs).totalMs, opens = dealt + length + settled.deal;
  expect(view.schedule).toEqual({
    phases: [
      { kind: 'deal', handId: 'hand-1', street: 'preflop', startsAt: dealt, endsAt: dealt + length, durationMs: length, inputs },
      { kind: 'settle', handId: 'hand-1', street: 'preflop', startsAt: dealt + length, endsAt: opens, durationMs: settled.deal },
    ],
    actionWindow: { participantId: human, decisionId: 'hand-1/decision-1', opensAt: opens },
  });
  clock.advanceTo(opens - 1);
  const early = await act(t, human, { type: 'call' });
  expect(early.status).toBe(409);
  expect(await early.json()).toMatchObject({ ok: false, rejection: { code: 'action-window-not-open' } });
  expect(await read(t)).toEqual({ ...view, serverTime: opens - 1 });
  clock.advance(1);
  await accepted(t, human, { type: 'call' });
  expect((await read(t)).view.state).toMatchObject({ actorId: t.ids[1], street: 'preflop' });
});

test('a full table’s deal is dealt clockwise from left of the button and lasts longer than a heads-up deal', async () => {
  const t = await table(6);
  for (const [i, participantId] of t.ids.entries()) await command(t, 'seat-participant', { participantId, seat: i + 1 });
  await command(t, 'start-hand');
  const [full] = (await read(t)).schedule.phases;
  // The button is seat 1, so seats 2 and 3 post the blinds and seat 2 is dealt first.
  const inputs = { dealt: [...t.ids.slice(1), t.ids[0]!].map(participantId => ({ participantId, cardCount: 2 })), blinds: [t.ids[1], t.ids[2]], refills: [] };
  expect(full).toMatchObject({ kind: 'deal', inputs, durationMs: dealBeats(inputs).totalMs });
  expect(full!.durationMs).toBeGreaterThan(deal);
  expect(full!.endsAt - full!.startsAt).toBe(full!.durationMs);
});

test('Rebuy & deal schedules a longer deal that lands the refill first', async () => {
  const { t } = await headsUp();
  // Both go all-in until one of them is left with no chips.
  let busted: string | undefined;
  while (!busted) {
    await command(t, 'start-hand');
    clock.advanceTo((await read(t)).schedule.actionWindow!.opensAt);
    const preflop = await read(t), actor = preflop.view.state.actorId!, other = t.ids.find(id => id !== actor)!;
    const all = (id: string) => { const p = preflop.view.state.participants.find(p => p.participantId === id)!; return p.stack + (p.wager ?? 0); };
    await accepted(t, actor, { type: 'raise', raiseTo: all(actor) });
    await accepted(t, other, { type: 'call' });
    clock.advance(60_000);
    busted = (await read(t)).view.state.participants.find(p => p.stack === 0)?.participantId;
  }
  await command(t, 'top-up-to', { participantId: busted, targetStack: 1000 });
  await command(t, 'start-hand');
  const [rebought] = (await read(t)).schedule.phases;
  if (rebought?.kind !== 'deal') throw new Error('The Hand has no deal phase.');
  expect(rebought.inputs.refills).toEqual([{ participantId: busted, amount: 1000 }]);
  expect(rebought.durationMs).toBe(dealBeats(rebought.inputs).totalMs);
  expect(rebought.durationMs).toBeGreaterThan(deal);
  // The next Hand comes with no refill.
  clock.advanceTo((await read(t)).schedule.actionWindow!.opensAt);
  await accepted(t, (await read(t)).view.state.actorId!, { type: 'fold' });
  clock.advance(60_000);
  await command(t, 'start-hand');
  expect((await read(t)).schedule.phases[0]).toMatchObject({ kind: 'deal', inputs: { refills: [] }, durationMs: deal });
});

test('each completed betting round reveals its street, followed by its Settle, and exposes nothing of later streets', async () => {
  const { t, human, bot } = await headsUp();
  const dealt = clock.now(), opens = dealt + deal + settled.deal;
  await command(t, 'start-hand');
  clock.advanceTo(opens);
  await accepted(t, human, { type: 'call' });
  // The Bot's option follows a decision, not a phase: its window opens at once.
  const option = await read(t);
  expect(option.schedule.actionWindow).toEqual({ participantId: bot, decisionId: 'hand-1/decision-2', opensAt: opens });
  await accepted(t, bot, { type: 'check' });
  const flopAt = clock.now();
  const flop = await read(t);
  expect(flop.view.state).toMatchObject({ street: 'flop', actorId: bot });
  expect(flop.view.state.board).toHaveLength(3);
  // The flop sweeps both preflop wagers into the pot, then reveals three board cards, and lasts as long as those beats.
  const flopInputs = { swept: [human, bot], cardCount: 3 }, street = streetBeats(flopInputs).totalMs;
  expect(flop.schedule).toEqual({
    phases: [
      { kind: 'deal', handId: 'hand-1', street: 'preflop', startsAt: dealt, endsAt: dealt + deal, durationMs: deal, inputs: expect.any(Object) },
      { kind: 'settle', handId: 'hand-1', street: 'preflop', startsAt: dealt + deal, endsAt: opens, durationMs: settled.deal },
      { kind: 'street', handId: 'hand-1', street: 'flop', startsAt: flopAt, endsAt: flopAt + street, durationMs: street, inputs: flopInputs },
      { kind: 'settle', handId: 'hand-1', street: 'flop', startsAt: flopAt + street, endsAt: flopAt + street + settled.street, durationMs: settled.street },
    ],
    actionWindow: { participantId: bot, decisionId: flop.view.state.decisionId, opensAt: flopAt + street + settled.street },
  });
  // During normal betting the view holds no future street, opponent cards, burns or deck order.
  expect(flop.view.state.participants.find(p => p.participantId === bot)).not.toHaveProperty('holeCards');
  expect(JSON.stringify(flop)).not.toMatch(/"(?:seed|deck|burns|drawnCardCount|commands)"\s*:/);
  expect(JSON.stringify(flop.schedule)).not.toMatch(/turn|river/);

  clock.advance(street);
  expect(await (await act(t, bot, { type: 'check' })).json()).toMatchObject({ ok: false, rejection: { code: 'action-window-not-open' } });
  clock.advance(settled.street);
  await accepted(t, bot, { type: 'check' });
  await accepted(t, human, { type: 'check' });
  const turnAt = clock.now();
  const turn = await read(t);
  expect(turn.view.state.board).toHaveLength(4);
  // A street checked through leaves nothing on the line: the turn sweeps nothing, and reveals one card sooner.
  const turnInputs = { swept: [], cardCount: 1 }, turned = streetBeats(turnInputs).totalMs;
  expect(turned).toBeLessThan(street);
  expect(turn.schedule.phases.slice(-2)).toEqual([
    { kind: 'street', handId: 'hand-1', street: 'turn', startsAt: turnAt, endsAt: turnAt + turned, durationMs: turned, inputs: turnInputs },
    { kind: 'settle', handId: 'hand-1', street: 'turn', startsAt: turnAt + turned, endsAt: turnAt + turned + settled.street, durationMs: settled.street },
  ]);
  expect(turn.schedule.actionWindow).toMatchObject({ participantId: bot, opensAt: turnAt + turned + settled.street });
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
    expect(update.schedule.actionWindow).toEqual({ participantId: human, decisionId: 'hand-1/decision-1', opensAt: dealt + deal + settled.deal });

    clock.advance(500);
    live.socket.terminate();
    await server.close(); await startServer();
    const restored = await read(t);
    expect(restored).toEqual({ ...read3, serverTime: dealt + 500 });
    // A reconnecting client receives the current schedule; elapsed or running phases are not replayed as events.
    reconnected = connect(t);
    expect(await reconnected.next(3)).toMatchObject({ schedule: read3.schedule, serverTime: dealt + 500, presentationEvents: [] });
    expect(await (await act(t, human, { type: 'call' })).json()).toMatchObject({ ok: false, rejection: { code: 'action-window-not-open' } });
    clock.advanceTo(dealt + deal + settled.deal);
    await accepted(t, human, { type: 'call' });
    expect((await reconnected.next(4)).serverTime).toBe(dealt + deal + settled.deal);
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
    botClock.advance(deal + settled.deal - 1000 - 1);
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

test('an all-in runout schedules the showdown, its remaining streets and the payout one after another, each with its Settle, and opens no Action Window', async () => {
  const { t, human, bot } = await headsUp();
  const dealt = clock.now();
  await command(t, 'start-hand');
  clock.advance(deal + settled.deal);
  await accepted(t, human, { type: 'raise', raiseTo: 1000 });
  await accepted(t, bot, { type: 'call' });
  const done = await read(t);
  expect(done.view.state).toMatchObject({ status: 'completed-hand', actorId: null });
  expect(done.view.state.board).toHaveLength(5);
  // The showdown comes first, so it sweeps the line; each street after it is played from its own inputs, sweeping nothing.
  const shown = { swept: [human, bot], shown: [{ participantId: human, cardCount: 2 }, { participantId: bot, cardCount: 2 }] }, showdown = showdownBeats(shown).totalMs;
  const flop = { swept: [], cardCount: 3 }, card = { swept: [], cardCount: 1 };
  const inputs = [undefined, undefined, shown, undefined, flop, undefined, card, undefined, card, undefined, undefined, undefined];
  // The complete result is already in the view; it is presented step by step at these server times, each phase
  // starting when the one before it ends, from the deal to the Settle after the payout.
  const phases = backToBack(dealt, [['deal', 'preflop', deal], ['settle', 'preflop', settled.deal], ['showdown', 'preflop', showdown], ['settle', 'preflop', settled.showdown],
    ['street', 'flop', streetBeats(flop).totalMs], ['settle', 'flop', settled.street], ['street', 'turn', streetBeats(card).totalMs], ['settle', 'turn', settled.street], ['street', 'river', streetBeats(card).totalMs], ['settle', 'river', settled.street],
    ['payout', 'river', payout], ['settle', 'river', settled.payout]]);
  expect(done.schedule).toEqual({
    phases: phases.map((phase, i) => ({ ...phase, handId: 'hand-1', ...(phase.kind === 'deal' ? { inputs: expect.any(Object) } : inputs[i] ? { inputs: inputs[i] } : {}) })),
    actionWindow: null,
  });
});
