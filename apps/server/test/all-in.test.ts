import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import WebSocket from 'ws';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { baselinePlayingStrategy, type ConcreteAction, type ObservableGameConfiguration, type ObservableTableSession, type ObservableTableUpdate, type TableLiveMessage } from '@poker/contracts';
import { createServer } from '../src/server.js';
import type { TableSessionControllerCommands } from '../src/mutations.js';

// Randomness is a system boundary. Only creation's seed draw is fixed; identity
// cookies and UUIDs retain real entropy. No game state or durable record is injected.
const randomness = vi.hoisted(() => ({ seed: undefined as string | undefined }));
vi.mock('node:crypto', async importOriginal => {
  const original = await importOriginal<typeof import('node:crypto')>();
  return { ...original, randomBytes: (size: number) => {
    if (randomness.seed === undefined) return original.randomBytes(size);
    if (size !== 32) throw new Error('Expected only the creation seed draw.');
    const bytes = Buffer.from(randomness.seed, 'hex'); randomness.seed = undefined; return bytes;
  } };
});

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('Set TEST_DATABASE_URL to a real PostgreSQL test database.');
const schema = 'test_' + randomUUID().replaceAll('-', '');
const administration = new Pool({ connectionString: databaseUrl });
let server: Awaited<ReturnType<typeof createServer>>;
let base: string;
let controllers: TableSessionControllerCommands;
let beforeCommit: (context: { tableSessionId: string; requestId: string }) => Promise<void> = async () => {};
async function startServer() {
  server = await createServer({ automaticBots: false, databaseUrl: databaseUrl!, schema, onControllerCommandsReady: commands => { controllers = commands; }, mutationTransactionFaults: { beforeCommit: context => beforeCommit(context) } });
  base = await server.listen({ host: '127.0.0.1', port: 0 });
}
beforeAll(async () => { await administration.query('CREATE SCHEMA "' + schema + '"'); await startServer(); });
afterAll(async () => { await server?.close(); await administration.query('DROP SCHEMA "' + schema + '" CASCADE'); await administration.end(); });
type Table = { id: string; cookie: string; ids: string[]; revision: number };
async function table(count: number, configuration: Partial<ObservableGameConfiguration> = {}, seed = '0'.repeat(64)): Promise<Table> {
  const identity = await fetch(base + '/api/identity'); const cookie = identity.headers.get('set-cookie')!.split(';')[0]!;
  randomness.seed = seed;
  let response: Response;
  try { response = await fetch(base + '/api/table-sessions', { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ requestId: randomUUID(), configuration: { seatCount: 9, minimumBuyIn: 1, defaultBuyIn: 1000, maximumBuyIn: 2000, ...configuration }, bots: Array.from({ length: count - 1 }, (_, i) => ({ name: 'Bot ' + (i + 1), playingStrategy: baselinePlayingStrategy })) }) }); }
  finally { randomness.seed = undefined; }
  expect(response.status).toBe(201); const created = await response.json();
  return { id: created.tableSessionId, cookie, ids: created.bindings.map((b: { participantId: string }) => b.participantId), revision: 0 };
}
const submit = (t: Table, kind: string, fields: object, requestId: string = randomUUID()) => fetch(base + '/api/table-sessions/' + t.id + '/' + kind, { method: 'POST', headers: { 'content-type': 'application/json', cookie: t.cookie }, body: JSON.stringify({ requestId, expectedPokerRevision: t.revision, ...fields }) });
const read = async (t: Table): Promise<ObservableTableSession> => (await (await fetch(base + '/api/table-sessions/' + t.id, { headers: { cookie: t.cookie } })).json());
async function command(t: Table, kind: string, fields: object = {}) {
  const response = await submit(t, kind, fields); expect(response.status).toBe(200);
  const result = await response.json(); expect(result.ok).toBe(true); t.revision = result.pokerRevision; return result;
}
async function act(t: Table, id: string, action: ConcreteAction) {
  if (id === t.ids[0]) return command(t, 'act', { participantId: id, action });
  const result = await controllers.submitAction(t.id, { requestId: randomUUID(), expectedPokerRevision: t.revision, participantId: id, action });
  expect(result).toMatchObject({ ok: true, pokerRevision: t.revision + 1 }); if (!result.ok) throw new Error(result.rejection.code); t.revision = result.pokerRevision; return result;
}
function connect(t: Table) {
  const socket = new WebSocket(base.replace('http:', 'ws:') + '/api/table-sessions/' + t.id + '/live', { headers: { cookie: t.cookie } });
  const messages: TableLiveMessage[] = []; socket.on('message', data => messages.push(JSON.parse(data.toString())));
  return { socket, messages, async next(revision: number) {
    await expect.poll(() => messages.some(m => m.type === 'table-update' && m.sessionRevision === revision)).toBe(true);
    return messages.find((m): m is ObservableTableUpdate => m.type === 'table-update' && m.sessionRevision === revision)!;
  } };
}

test('the last capped Call atomically publishes layered runout, preserves history, retries once, and restores an actual-play rebuy', async () => {
  const t = await table(3); const [human, bob, carol] = t.ids as [string, string, string];
  for (const [participantId, seat, buyIn] of [[human, 3, 100], [bob, 2, 300], [carol, 1, 300]] as const) await command(t, 'seat-participant', { participantId, seat, buyIn });
  await command(t, 'start-hand'); await act(t, carol, { type: 'raise', raiseTo: 300 }); await act(t, bob, { type: 'call' });
  const before = await read(t); const live = connect(t);
  const fields = { participantId: human, action: { type: 'call' } }; const requestId = 'last-capped-call';
  const entered = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>(); let held: Promise<Response> | undefined;
  try {
    await live.next(6);
    expect(before.view.state).toMatchObject({ actorId: human, amountToCall: 80, board: [], legalActions: [{ type: 'fold' }, { type: 'call' }] });
    beforeCommit = async context => { if (context.requestId === requestId) throw new Error('controlled all-in rollback'); };
    expect((await submit(t, 'act', fields, requestId)).status).toBe(503);
    expect(await read(t)).toEqual(before); expect(live.messages).toHaveLength(1);
    beforeCommit = async context => { if (context.requestId === requestId) { entered.resolve(); await release.promise; } };
    held = submit(t, 'act', fields, requestId); await entered.promise;
    expect(await read(t)).toEqual(before); expect(live.messages).toHaveLength(1);
    release.resolve(); expect((await held).status).toBe(200); beforeCommit = async () => {};
    const update = await live.next(7); const done = await read(t);
    expect(update.view).toEqual(done.view);
    expect(done.view.state).toMatchObject({ status: 'completed-hand', handId: 'hand-1', actorId: null, decisionId: null, board: ['Td', 'Qh', '5c', 'Ad', '4s'], pots: [{ amount: 300, eligibleParticipantIds: [human, bob, carol] }, { amount: 400, eligibleParticipantIds: [bob, carol] }], returns: [], payouts: [{ participantId: bob, amount: 300 }, { participantId: bob, amount: 400 }] });
    expect(done.view.state.participants.map(p => p.stack)).toEqual([0, 700, 0]);
    expect(update.presentationEvents.map(e => e.type)).toEqual(['acted', 'hole-cards-revealed', 'hole-cards-revealed', 'hole-cards-revealed', 'card-burned', 'board-dealt', 'card-burned', 'board-dealt', 'card-burned', 'board-dealt', 'pot-awarded', 'pot-awarded', 'hand-completed']);
    expect(update.presentationEvents.filter(e => e.type === 'card-burned')).toEqual([{ type: 'card-burned', street: 'flop' }, { type: 'card-burned', street: 'turn' }, { type: 'card-burned', street: 'river' }]);
    expect(done.view.history[0]!.decisions.at(-1)!.state).toEqual(before.view.state);
    expect(done.view.history[0]!.decisions.every(d => d.state.participants.filter(p => p.holeCards).length === 1)).toBe(true);
    expect(JSON.stringify(update)).not.toMatch(/"(?:seed|deck|burns|drawnCardCount|commands|ownerUserId|userId)"\s*:/);
    const acknowledgement = await (await submit(t, 'act', fields, requestId)).json();
    expect(acknowledgement).toMatchObject({ ok: true, pokerRevision: 7 }); expect(await read(t)).toEqual(done); expect(live.messages).toHaveLength(2);
    t.revision = 7;
    expect((await submit(t, 'start-hand', {})).status).toBe(400); expect(await read(t)).toEqual(done);
    await command(t, 'top-up-to', { participantId: human, targetStack: 100 });
    const rebought = await read(t); expect(rebought.view.state).toMatchObject({ status: 'completed-hand', handId: 'hand-1' }); expect(rebought.view.history).toEqual(done.view.history);
    live.socket.terminate(); await server.close(); await startServer();
    expect(await read(t)).toEqual(rebought);
    await command(t, 'start-hand'); const next = await read(t);
    expect(next.view.state).toMatchObject({ status: 'active-hand', handId: 'hand-2', buttonSeat: 2, smallBlindParticipantId: bob, bigBlindParticipantId: human });
    expect(next.view.state.participants.find(p => p.participantId === carol)).not.toHaveProperty('inHand');
  } finally { release.resolve(); beforeCommit = async () => {}; await held; live.socket.terminate(); }
});

test.each(['call', 'fold'] as const)('100/300 unequal caps settle a real matched pot and return excess after the last %s', async action => {
  const t = await table(2); const [human, bot] = t.ids as [string, string];
  await command(t, 'seat-participant', { participantId: human, seat: 2, buyIn: 100 }); await command(t, 'seat-participant', { participantId: bot, seat: 1, buyIn: 300 });
  await command(t, 'start-hand'); await act(t, bot, { type: 'raise', raiseTo: 300 });
  const before = await read(t); expect(before.view.state).toMatchObject({ actorId: human, amountToCall: 80 });
  const live = connect(t);
  try {
    await live.next(4); await act(t, human, { type: action }); const update = await live.next(5); const done = await read(t);
    expect(done.view.state).toMatchObject({ status: 'completed-hand', actorId: null, pots: [{ amount: action === 'call' ? 200 : 40, eligibleParticipantIds: action === 'call' ? [human, bot] : [bot] }], returns: [{ participantId: bot, amount: action === 'call' ? 200 : 280 }], payouts: [{ participantId: bot, amount: action === 'call' ? 200 : 40 }] });
    expect(done.view.state.participants.map(p => p.stack)).toEqual(action === 'call' ? [0, 400] : [80, 320]);
    expect(done.view.state.board).toEqual(action === 'call' ? ['Kc', '3d', 'Td', '5c', 'Ad'] : []);
    if (action === 'fold') {
      expect(done.view.state.participants[1]).not.toHaveProperty('holeCards');
      expect(update.presentationEvents.some(e => e.type === 'hole-cards-revealed' || e.type === 'card-burned' || e.type === 'board-dealt')).toBe(false);
    }
    expect(update.view).toEqual(done.view); expect(JSON.stringify(update)).not.toMatch(/"(?:seed|deck|burns|drawnCardCount|commands)"\s*:/);
    live.socket.terminate(); await server.close(); await startServer(); expect(await read(t)).toEqual(done);
  } finally { live.socket.terminate(); }
});

test('singleton genuine short Raise and Bet sizes retain the ordinary action contract through durable acceptance', async () => {
  const raised = await table(2); const [human, bot] = raised.ids as [string, string];
  await command(raised, 'seat-participant', { participantId: human, seat: 1, buyIn: 30 }); await command(raised, 'seat-participant', { participantId: bot, seat: 4 }); await command(raised, 'start-hand');
  const beforeRaise = await read(raised);
  expect(beforeRaise.view.state.legalActions).toEqual([{ type: 'fold' }, { type: 'call' }, { type: 'raise', minimum: 30, maximum: 30 }]);
  expect((await submit(raised, 'act', { participantId: human, action: { type: 'raise', raiseTo: 29 } })).status).toBe(400); expect(await read(raised)).toEqual(beforeRaise);
  await act(raised, human, { type: 'raise', raiseTo: 30 });
  const waiting = await read(raised); expect(waiting.view.state).toMatchObject({ status: 'active-hand', board: [], actorId: bot }); expect(waiting.view.state.participants[0]).toMatchObject({ allIn: true, stack: 0 });
  await act(raised, bot, { type: 'call' }); const raisedDone = await read(raised); expect(raisedDone.view.state.status).toBe('completed-hand'); expect(raisedDone.view.state.participants.reduce((sum, p) => sum + p.stack, 0)).toBe(1030);

  const bet = await table(2); const [short, deep] = bet.ids as [string, string];
  await command(bet, 'seat-participant', { participantId: short, seat: 1, buyIn: 35 }); await command(bet, 'seat-participant', { participantId: deep, seat: 4 }); await command(bet, 'start-hand');
  await act(bet, short, { type: 'call' }); await act(bet, deep, { type: 'check' }); await act(bet, deep, { type: 'check' });
  const beforeBet = await read(bet); expect(beforeBet.view.state.legalActions).toEqual([{ type: 'fold' }, { type: 'check' }, { type: 'bet', minimum: 15, maximum: 15 }]);
  expect((await submit(bet, 'act', { participantId: short, action: { type: 'bet', betTo: 14 } })).status).toBe(400); expect(await read(bet)).toEqual(beforeBet);
  await act(bet, short, { type: 'bet', betTo: 15 }); expect((await read(bet)).view.state).toMatchObject({ status: 'active-hand', actorId: deep, board: ['Kc', '3d', 'Td'] });
  await act(bet, deep, { type: 'call' }); const betDone = await read(bet); expect(betDone.view.state).toMatchObject({ status: 'completed-hand', pots: [{ amount: 70, eligibleParticipantIds: [short, deep] }], returns: [] }); expect(betDone.view.state.participants.reduce((sum, p) => sum + p.stack, 0)).toBe(1035);
});

test('folded contributions stay in matched side pots while the live unmatched layer is returned', async () => {
  const t = await table(3); const [human, bob, carol] = t.ids as [string, string, string];
  for (const [participantId, seat, buyIn] of [[human, 1, 100], [bob, 2, 400], [carol, 3, 400]] as const) await command(t, 'seat-participant', { participantId, seat, buyIn });
  await command(t, 'start-hand'); await act(t, human, { type: 'raise', raiseTo: 100 }); await act(t, bob, { type: 'call' }); await act(t, carol, { type: 'raise', raiseTo: 200 }); await act(t, bob, { type: 'call' }); await act(t, bob, { type: 'bet', betTo: 100 });
  const before = await read(t); const live = connect(t);
  try {
    await live.next(t.revision); await act(t, carol, { type: 'fold' }); const update = await live.next(t.revision); const done = await read(t);
    expect(done.view.state).toMatchObject({ pots: [{ amount: 300, eligibleParticipantIds: [human, bob] }, { amount: 200, eligibleParticipantIds: [bob] }], returns: [{ participantId: bob, amount: 100 }], payouts: [{ participantId: bob, amount: 300 }, { participantId: bob, amount: 200 }] });
    expect(done.view.state.participants.map(p => p.stack)).toEqual([0, 700, 200]); expect(done.view.state.participants[2]).not.toHaveProperty('holeCards');
    expect(update.presentationEvents.filter(e => e.type === 'hole-cards-revealed').map(e => e.participantId)).toEqual([human, bob]);
    expect(done.view.history[0]!.decisions.at(-1)!.state).toEqual(before.view.state); expect(update.view).toEqual(done.view);
    live.socket.terminate(); await server.close(); await startServer(); expect(await read(t)).toEqual(done);
  } finally { live.socket.terminate(); }
});

test('an ante-all-in retains cards and capped eligibility through a later flop all-in runout', async () => {
  const t = await table(3, { ante: 5 }); const [human, bob, carol] = t.ids as [string, string, string];
  for (const [participantId, seat, buyIn] of [[human, 1, 3], [bob, 2, 100], [carol, 3, 100]] as const) await command(t, 'seat-participant', { participantId, seat, buyIn });
  await command(t, 'start-hand'); const initial = await read(t);
  expect(initial.view.state.participants[0]).toMatchObject({ stack: 0, allIn: true, contribution: 3, anteContribution: 3, wager: 0, cardCount: 2 });
  await act(t, bob, { type: 'call' }); await act(t, carol, { type: 'check' }); await act(t, bob, { type: 'bet', betTo: 75 });
  const live = connect(t);
  try {
    await live.next(t.revision); await act(t, carol, { type: 'call' }); const update = await live.next(t.revision); const done = await read(t);
    expect(done.view.state).toMatchObject({ status: 'completed-hand', board: ['Td', 'Qh', '5c', 'Ad', '4s'], pots: [{ amount: 9, eligibleParticipantIds: [human, bob, carol] }, { amount: 194, eligibleParticipantIds: [bob, carol] }], returns: [], payouts: [{ participantId: bob, amount: 9 }, { participantId: bob, amount: 194 }] });
    expect(done.view.state.participants.map(p => p.stack)).toEqual([0, 203, 0]); expect(done.view.state.participants.every(p => p.holeCards?.length === 2)).toBe(true);
    expect(update.presentationEvents.filter(e => e.type === 'card-burned')).toEqual([{ type: 'card-burned', street: 'turn' }, { type: 'card-burned', street: 'river' }]);
    expect(update.presentationEvents.findIndex(e => e.type === 'hole-cards-revealed')).toBeLessThan(update.presentationEvents.findIndex(e => e.type === 'card-burned'));
    expect(done.view.history[0]!.decisions[0]!.state).toEqual(initial.view.state); expect(JSON.stringify(update)).not.toMatch(/"(?:seed|deck|burns|drawnCardCount|commands)"\s*:/);
  } finally { live.socket.terminate(); }
});

test('real main and side pot ties retain independent payouts and restoration', async () => {
  const t = await table(3, {}, '489'.padStart(64, '0')); const [human, bob, carol] = t.ids as [string, string, string];
  for (const [participantId, seat, buyIn] of [[human, 1, 100], [bob, 2, 300], [carol, 3, 300]] as const) await command(t, 'seat-participant', { participantId, seat, buyIn });
  await command(t, 'start-hand'); await act(t, human, { type: 'raise', raiseTo: 100 }); await act(t, bob, { type: 'raise', raiseTo: 300 });
  const live = connect(t);
  try {
    await live.next(t.revision); await act(t, carol, { type: 'call' }); const update = await live.next(t.revision); const done = await read(t);
    // Independent hex-seed vector: all three play the board's six-high straight.
    expect(done.view.state).toMatchObject({ board: ['4d', '2s', '5d', '6c', '3h'], pots: [{ amount: 300, eligibleParticipantIds: [human, bob, carol] }, { amount: 400, eligibleParticipantIds: [bob, carol] }], payouts: [{ participantId: bob, amount: 100 }, { participantId: carol, amount: 100 }, { participantId: human, amount: 100 }, { participantId: bob, amount: 200 }, { participantId: carol, amount: 200 }] });
    expect(done.view.state.participants.map(p => p.stack)).toEqual([100, 300, 300]); expect(update.presentationEvents.flatMap(e => e.type === 'pot-awarded' ? [e.amount] : [])).toEqual([100, 100, 100, 200, 200]);
    live.socket.terminate(); await server.close(); await startServer(); expect(await read(t)).toEqual(done);
  } finally { live.socket.terminate(); }
});

test('folded-only caps publish one 8-chip pot and an equal split to the tied live hands', async () => {
  const t = await table(5, { smallBlind: 1, bigBlind: 1, ante: 1 }, '6d7'.padStart(64, '0')); const [alice, bob, carol, dave, eve] = t.ids as [string, string, string, string, string];
  for (const [participantId, seat] of [[alice, 2], [bob, 3], [carol, 5], [dave, 1], [eve, 4]] as const) await command(t, 'seat-participant', { participantId, seat, buyIn: 10 });
  await command(t, 'start-hand'); await act(t, eve, { type: 'fold' }); await act(t, carol, { type: 'call' }); await act(t, dave, { type: 'fold' }); await act(t, alice, { type: 'check' }); await act(t, bob, { type: 'check' });
  await act(t, alice, { type: 'check' }); await act(t, bob, { type: 'check' }); await act(t, carol, { type: 'fold' });
  for (let street = 0; street < 2; street++) for (const id of [alice, bob]) await act(t, id, { type: 'check' });
  const done = await read(t);
  // Independent vector: Alice and Bob play the jack-high board straight.
  expect(done.view.state).toMatchObject({ board: ['8s', 'Jc', 'Th', '9c', '7h'], pots: [{ amount: 8, eligibleParticipantIds: [alice, bob] }], returns: [], payouts: [{ participantId: alice, amount: 4 }, { participantId: bob, amount: 4 }] });
  expect(done.view.state.participants.map(p => [p.stack, p.contribution])).toEqual([[12, 2], [12, 2], [8, 2], [9, 1], [9, 1]]); expect(done.view.state.participants.filter(p => p.holeCards).map(p => p.participantId)).toEqual([alice, bob]);
  expect(done.view.history[0]!.decisions.every(d => d.state.participants.filter(p => p.holeCards).length === 1)).toBe(true);
  await server.close(); await startServer(); expect(await read(t)).toEqual(done);
});

test('genuine live all-in caps keep separate 5-chip and 3-chip pots even when the same tied winners take both', async () => {
  const t = await table(5, { smallBlind: 1, bigBlind: 1, ante: 1 }, 'ba'.padStart(64, '0')); const [alice, bob, carol, dave, eve] = t.ids as [string, string, string, string, string];
  for (const [participantId, seat, buyIn] of [[alice, 2, 10], [bob, 3, 10], [carol, 5, 2], [dave, 1, 1], [eve, 4, 1]] as const) await command(t, 'seat-participant', { participantId, seat, buyIn });
  await command(t, 'start-hand'); await act(t, carol, { type: 'call' }); await act(t, alice, { type: 'check' }); await act(t, bob, { type: 'check' });
  const before = await read(t);
  expect(before.view.state.pots).toEqual([{ amount: 5, eligibleParticipantIds: [alice, bob, carol, dave, eve] }, { amount: 3, eligibleParticipantIds: [alice, bob, carol] }]);
  expect(before.view.state.participants.filter(p => p.allIn).map(p => p.participantId)).toEqual([carol, dave, eve]);
  for (let street = 0; street < 2; street++) for (const id of [alice, bob]) await act(t, id, { type: 'check' });
  await act(t, alice, { type: 'check' }); const live = connect(t);
  try {
    await live.next(t.revision); await act(t, bob, { type: 'check' }); const update = await live.next(t.revision); const done = await read(t);
    // Alice/Bob pair the board's nine: queens and nines, ace kicker. Short hands have only queens.
    expect(done.view.state).toMatchObject({ board: ['Qh', 'Qc', 'Ad', '9c', '6c'], pots: [{ amount: 5, eligibleParticipantIds: [alice, bob, carol, dave, eve] }, { amount: 3, eligibleParticipantIds: [alice, bob, carol] }], returns: [], payouts: [{ participantId: alice, amount: 3 }, { participantId: bob, amount: 2 }, { participantId: alice, amount: 2 }, { participantId: bob, amount: 1 }] });
    expect(done.view.state.participants.map(p => [p.stack, p.contribution, p.folded])).toEqual([[13, 2, false], [11, 2, false], [0, 2, false], [0, 1, false], [0, 1, false]]);
    expect(done.view.state.participants.every(p => p.holeCards?.length === 2)).toBe(true); expect(update.view).toEqual(done.view);
    expect(update.presentationEvents.flatMap(e => e.type === 'pot-awarded' ? [e.amount] : [])).toEqual([3, 2, 2, 1]);
    expect(done.view.history[0]!.decisions.every(d => d.state.participants.filter(p => p.holeCards).length === 1)).toBe(true);
    expect(JSON.stringify(update)).not.toMatch(/"(?:seed|deck|burns|drawnCardCount|commands)"\s*:/);
    live.socket.terminate(); await server.close(); await startServer(); expect(await read(t)).toEqual(done);
  } finally { live.socket.terminate(); }
});
