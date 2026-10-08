import { afterAll, beforeAll, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import WebSocket from 'ws';
import { baselinePlayingStrategy, type ObservableTableUpdate, type TableLiveMessage } from '@poker/contracts';
import { createServer } from '../src/server.js';
import type { TableSessionControllerCommands } from '../src/mutations.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('Set TEST_DATABASE_URL to a real PostgreSQL test database.');
const schema = 'test_' + randomUUID().replaceAll('-', '');
const administration = new Pool({ connectionString: databaseUrl });
let server: Awaited<ReturnType<typeof createServer>>;
let base: string;
let beforeCommit: (context: { tableSessionId: string; requestId: string }) => Promise<void> = async () => {};
let afterCommit: () => Promise<void> = async () => {};
let controllers: TableSessionControllerCommands;
beforeAll(async () => {
  await administration.query('CREATE SCHEMA "' + schema + '"');
  server = await createServer({ automaticBots: false, databaseUrl, schema, mutationTransactionFaults: { beforeCommit: context => beforeCommit(context), afterCommit: () => afterCommit() }, onControllerCommandsReady: commands => { controllers = commands; } });
  base = await server.listen({ host: '127.0.0.1', port: 0 });
});
afterAll(async () => { await server?.close(); await administration.query('DROP SCHEMA "' + schema + '" CASCADE'); await administration.end(); });
async function table(configuration?: { maximumBuyIn: number }) {
  const identity = await fetch(base + '/api/identity');
  const cookie = identity.headers.get('set-cookie')!.split(';')[0]!;
  const response = await fetch(base + '/api/table-sessions', { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ requestId: randomUUID(), configuration, bots: [{ name: 'Bot', playingStrategy: baselinePlayingStrategy }] }) });
  const created = await response.json();
  return { id: created.tableSessionId as string, cookie, human: created.bindings[0].participantId as string, bot: created.bindings[1].participantId as string };
}
type Table = Awaited<ReturnType<typeof table>>;
const submit = (t: Table, kind: string, body: unknown) => fetch(base + '/api/table-sessions/' + t.id + '/' + kind, { method: 'POST', headers: { 'content-type': 'application/json', cookie: t.cookie }, body: JSON.stringify(body) });
const read = async (t: Table) => (await (await fetch(base + '/api/table-sessions/' + t.id, { headers: { cookie: t.cookie } })).json());
function connect(t: Table, cookie = t.cookie, suffix = '') {
  const socket = new WebSocket(base.replace('http:', 'ws:') + '/api/table-sessions/' + t.id + '/live' + suffix, { headers: { cookie } });
  const messages: TableLiveMessage[] = [];
  socket.on('message', data => messages.push(JSON.parse(data.toString())));
  return { socket, messages, async next(revision: number) {
    await expect.poll(() => messages.find(m => m.type === 'table-update' && m.sessionRevision === revision)).toBeDefined();
    return messages.find((m): m is ObservableTableUpdate => m.type === 'table-update' && m.sessionRevision === revision)!;
  } };
}
test('a real connection receives the latest complete view for the owner’s bound human, independently of a client-supplied observer', async () => {
  const t = await table();
  await submit(t, 'seat-participant', { requestId: 'human', expectedPokerRevision: 0, participantId: t.human, seat: 1 });
  await submit(t, 'seat-participant', { requestId: 'bot', expectedPokerRevision: 1, participantId: t.bot, seat: 4 });
  await submit(t, 'start-hand', { requestId: 'start', expectedPokerRevision: 2 });
  const live = connect(t, t.cookie, '?participantId=' + t.bot);
  live.socket.on('error', () => {});
  try {
    const update = await live.next(3);
    expect(update).toMatchObject({ tableSessionId: t.id, pokerRevision: 3, sessionRevision: 3, presentationEvents: [], view: { state: { status: 'active-hand', actorId: t.human, legalActions: expect.arrayContaining([{ type: 'fold' }]) } } });
    expect(update.view.state.participants[0]?.holeCards).toHaveLength(2);
    expect(update.view.state.participants[1]).not.toHaveProperty('holeCards');
    expect(update.view).not.toHaveProperty('sessionRevision');
    expect(JSON.stringify(update)).not.toMatch(/"(?:seed|deck|burns|commands|ownerUserId|userId|schemaVersion|engineVersion)"\s*:/);
  } finally { live.socket.terminate(); }
});
test('held or failed PostgreSQL COMMIT publishes no working state, and successful promotion publishes fresh safe views and events once', async () => {
  const t = await table();
  const live = connect(t);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let held: Promise<Response> | undefined;
  try {
    await live.next(0);
    beforeCommit = async context => { if (context.tableSessionId === t.id && context.requestId === 'held-human') { entered.resolve(); await release.promise; } };
    held = submit(t, 'seat-participant', { requestId: 'held-human', expectedPokerRevision: 0, participantId: t.human, seat: 1 });
    await entered.promise;
    const reconnectWhileHeld = connect(t);
    try {
      expect(await reconnectWhileHeld.next(0)).toMatchObject({ view: { state: { participants: [] } } });
      expect(await read(t)).toMatchObject({ pokerRevision: 0, sessionRevision: 0, view: { state: { participants: [] } } });
      expect(live.messages).toHaveLength(1);
    } finally { reconnectWhileHeld.socket.terminate(); }
    release.resolve();
    expect((await held).status).toBe(200);
    expect(await live.next(1)).toMatchObject({ pokerRevision: 1, presentationEvents: [{ type: 'participant-seated', participantId: t.human, seat: 1, buyIn: 1000 }], view: { state: { participants: [{ participantId: t.human, seat: 1, stack: 1000 }] } } });
    beforeCommit = async () => { throw new Error('controlled rollback'); };
    expect((await submit(t, 'seat-participant', { requestId: 'failed-bot', expectedPokerRevision: 1, participantId: t.bot, seat: 4 })).status).toBe(503);
    expect(await read(t)).toMatchObject({ pokerRevision: 1, sessionRevision: 1 });
    expect(live.messages).toHaveLength(2);
    beforeCommit = async () => {};
    await submit(t, 'seat-participant', { requestId: 'bot', expectedPokerRevision: 1, participantId: t.bot, seat: 4 });
    await live.next(2);
    await submit(t, 'start-hand', { requestId: 'start', expectedPokerRevision: 2 });
    const dealt = await live.next(3);
    expect(dealt.presentationEvents.filter(e => e.type === 'hole-cards-dealt')).toEqual([
      { type: 'hole-cards-dealt', participantId: t.human, cardCount: 2, cards: dealt.view.state.participants[0]?.holeCards },
      { type: 'hole-cards-dealt', participantId: t.bot, cardCount: 2 },
    ]);
    expect(dealt.view.state.participants[1]).not.toHaveProperty('holeCards');
    expect(JSON.stringify(dealt)).not.toMatch(/"(?:seed|deck|burns|commands|ownerUserId|userId|schemaVersion|engineVersion)"\s*:/);
    await submit(t, 'start-hand', { requestId: 'start', expectedPokerRevision: 2 });
    await submit(t, 'start-hand', { requestId: 'rejected-start', expectedPokerRevision: 3 });
    expect(await read(t)).toMatchObject({ sessionRevision: 3 });
    expect(live.messages.filter(m => m.type === 'table-update').map(m => m.sessionRevision)).toEqual([0, 1, 2, 3]);
  } finally { release.resolve(); beforeCommit = async () => {}; await held; live.socket.terminate(); }
});
test('WebSocket upgrades require a known cookie and Table Ownership before exposing any participant view', async () => {
  const t = await table();
  const other = await table();
  for (const [cookie, expectedStatus] of [['', 401], ['poker_local=unrecognized', 401], [other.cookie, 404]] as const) {
    const live = connect(t, cookie, '?participantId=' + t.human);
    live.socket.on('error', () => {});
    const status = await new Promise<number>(resolve => live.socket.once('unexpected-response', (_request, response) => { response.resume(); resolve(response.statusCode!); }));
    expect(status).toBe(expectedStatus);
    expect(live.messages).toEqual([]);
    live.socket.terminate();
  }
});
test('disconnect submits no poker command, and reconnect supplies the latest complete view across missed revisions with no replayed events', async () => {
  const t = await table();
  await submit(t, 'seat-participant', { requestId: 'human', expectedPokerRevision: 0, participantId: t.human, seat: 1 });
  await submit(t, 'seat-participant', { requestId: 'bot', expectedPokerRevision: 1, participantId: t.bot, seat: 4 });
  await submit(t, 'start-hand', { requestId: 'start', expectedPokerRevision: 2 });
  const live = connect(t);
  const decision = await live.next(3);
  live.socket.close();
  await new Promise<void>(resolve => live.socket.once('close', () => resolve()));
  const humanWaiting = await read(t);
  expect(humanWaiting).toMatchObject({ pokerRevision: 3, sessionRevision: 3, view: decision.view });
  await submit(t, 'act', { requestId: 'fold', expectedPokerRevision: 3, participantId: t.human, action: { type: 'fold' } });
  await submit(t, 'start-hand', { requestId: 'next-hand', expectedPokerRevision: 4 });
  const reconnected = connect(t);
  try {
    const current = await reconnected.next(5);
    expect(current).toMatchObject({ pokerRevision: 5, sessionRevision: 5, presentationEvents: [], view: { state: { handId: 'hand-2', status: 'active-hand', actorId: t.bot, legalActions: [] } } });
    expect(current.view).toEqual((await read(t)).view);
    expect(current.view.state.participants[1]).not.toHaveProperty('holeCards');
  } finally { reconnected.socket.terminate(); }
});
test('lost COMMIT confirmation publishes recovery feedback independently of unchanged gameplay revisions and reconnect preserves that pause', async () => {
  const t = await table();
  const live = connect(t);
  try {
    const before = await live.next(0);
    afterCommit = async () => { throw new Error('controlled lost COMMIT confirmation'); };
    expect((await submit(t, 'seat-participant', { requestId: 'unknown-human', expectedPokerRevision: 0, participantId: t.human, seat: 1 })).status).toBe(503);
    afterCommit = async () => {};
    await expect.poll(() => live.messages.find(m => m.type === 'table-status')).toMatchObject({ type: 'table-status', tableSessionId: t.id, status: { phase: 'recovering' } });
    expect(live.messages.filter(m => m.type === 'table-update')).toEqual([before]);
    expect(await read(t)).toMatchObject({ pokerRevision: 0, sessionRevision: 0, view: before.view });
    const reconnected = connect(t);
    try {
      expect(await reconnected.next(0)).toMatchObject({ pokerRevision: 0, sessionRevision: 0, presentationEvents: [], view: before.view });
      await expect.poll(() => reconnected.messages.find(m => m.type === 'table-status')).toMatchObject({ status: { phase: 'recovering' } });
    } finally { reconnected.socket.terminate(); }
  } finally { afterCommit = async () => {}; live.socket.terminate(); }
});
test('committed management commands automatically synchronize their complete views and explicit safe presentation events', async () => {
  const t = await table({ maximumBuyIn: 2000 });
  const live = connect(t);
  try {
    await live.next(0);
    const steps = [
      ['seat-participant', { participantId: t.human, seat: 1 }, { type: 'participant-seated', participantId: t.human, seat: 1, buyIn: 1000 }],
      ['seat-participant', { participantId: t.bot, seat: 4 }, { type: 'participant-seated', participantId: t.bot, seat: 4, buyIn: 1000 }],
      ['top-up-to', { participantId: t.human, targetStack: 1500 }, { type: 'participant-topped-up', participantId: t.human, targetStack: 1500, amount: 500 }],
      ['move-participant', { participantId: t.bot, seat: 2 }, { type: 'participant-moved', participantId: t.bot, fromSeat: 4, seat: 2 }],
      ['set-sitting-out', { participantId: t.bot, sittingOut: true }, { type: 'sitting-out-changed', participantId: t.bot, sittingOut: true }],
      ['set-sitting-out', { participantId: t.bot, sittingOut: false }, { type: 'sitting-out-changed', participantId: t.bot, sittingOut: false }],
      ['set-button', { seat: 1 }, { type: 'button-set', seat: 1 }],
      ['leave-participant', { participantId: t.bot }, { type: 'participant-left', participantId: t.bot, seat: 2, cashOut: 1000 }],
    ] as const;
    for (let index = 0; index < steps.length; index++) {
      const [kind, contents, event] = steps[index]!;
      expect((await submit(t, kind, { requestId: randomUUID(), expectedPokerRevision: index, ...contents })).status).toBe(200);
      const update = await live.next(index + 1);
      expect(update.presentationEvents).toEqual([event]);
      expect(update.view).toEqual((await read(t)).view);
    }
    expect((await live.next(8)).view.state.participants).toEqual([
      { participantId: t.human, seat: 1, stack: 1500, sittingOut: false },
      { participantId: t.bot, seat: null, stack: 0, sittingOut: false },
    ]);
  } finally { live.socket.terminate(); }
});
test('trusted controller Check and human Call share committed publication, burn events omit identities, and Showdown alone reveals live cards', async () => {
  const t = await table();
  await submit(t, 'seat-participant', { requestId: 'human', expectedPokerRevision: 0, participantId: t.human, seat: 1 });
  await submit(t, 'seat-participant', { requestId: 'bot', expectedPokerRevision: 1, participantId: t.bot, seat: 4 });
  await submit(t, 'start-hand', { requestId: 'start', expectedPokerRevision: 2 });
  const live = connect(t);
  try {
    await live.next(3);
    expect((await submit(t, 'act', { requestId: 'call', expectedPokerRevision: 3, participantId: t.human, action: { type: 'call' } })).status).toBe(200);
    await live.next(4);
    for (let revision = 4; revision < 11; revision++) {
      const current = await live.next(revision);
      const actor = current.view.state.actorId!;
      const request = { requestId: randomUUID(), expectedPokerRevision: revision, participantId: actor, action: { type: 'check' as const } };
      if (actor === t.bot) expect((await controllers.submitAction(t.id, request)).ok).toBe(true);
      else expect((await submit(t, 'act', request)).status).toBe(200);
      const update = await live.next(revision + 1);
      if (revision + 1 < 11) expect(update.view.state.participants.find(p => p.participantId === t.bot)).not.toHaveProperty('holeCards');
    }
    const updates = live.messages.filter((message): message is ObservableTableUpdate => message.type === 'table-update');
    const events = updates.flatMap(update => update.presentationEvents);
    expect(events.filter(event => event.type === 'card-burned')).toEqual([{ type: 'card-burned', street: 'flop' }, { type: 'card-burned', street: 'turn' }, { type: 'card-burned', street: 'river' }]);
    expect(events.filter(event => event.type === 'board-dealt').map(event => event.cards.length)).toEqual([3, 1, 1]);
    expect(events.filter(event => event.type === 'hole-cards-revealed')).toHaveLength(2);
    const completed = await live.next(11);
    expect(completed.view.state).toMatchObject({ status: 'completed-hand', actorId: null });
    expect(completed.view.state.board).toHaveLength(5);
    expect(completed.view.state.participants.every(p => p.holeCards?.length === 2)).toBe(true);
    expect(JSON.stringify(updates)).not.toMatch(/"(?:seed|deck|burns|commands|ownerUserId|userId|schemaVersion|engineVersion)"\s*:/);
  } finally { live.socket.terminate(); }
});
