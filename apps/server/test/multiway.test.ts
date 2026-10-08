import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { baselinePlayingStrategy, type ConcreteAction, type ObservableGameConfiguration, type ObservableTableSession } from '@poker/contracts';
import { createServer } from '../src/server.js';
import type { TableSessionControllerCommands } from '../src/mutations.js';

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
const submit = (t: Table, kind: string, body: unknown) => fetch(base + '/api/table-sessions/' + t.id + '/' + kind, { method: 'POST', headers: { 'content-type': 'application/json', cookie: t.cookie }, body: JSON.stringify(body) });
const read = async (t: Table): Promise<ObservableTableSession> => (await (await fetch(base + '/api/table-sessions/' + t.id, { headers: { cookie: t.cookie } })).json());
async function table(count: number, configuration: Partial<ObservableGameConfiguration> = {}): Promise<Table> {
  const identity = await fetch(base + '/api/identity'); const cookie = identity.headers.get('set-cookie')!.split(';')[0]!;
  const response = await fetch(base + '/api/table-sessions', { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ requestId: randomUUID(), configuration: { seatCount: 9, minimumBuyIn: 0, defaultBuyIn: 1000, maximumBuyIn: 2000, ...configuration }, bots: Array.from({ length: count - 1 }, (_, i) => ({ name: 'Bot ' + (i + 1), playingStrategy: baselinePlayingStrategy })) }) });
  expect(response.status).toBe(201); const created = await response.json();
  return { id: created.tableSessionId, cookie, ids: created.bindings.map((b: { participantId: string }) => b.participantId), revision: 0 };
}
async function command(t: Table, kind: string, fields: object = {}, requestId = randomUUID()) {
  const response = await submit(t, kind, { requestId, expectedPokerRevision: t.revision, ...fields });
  expect(response.status).toBe(200); const result = await response.json(); expect(result.ok).toBe(true); t.revision = result.pokerRevision;
  return result;
}
async function act(t: Table, participantId: string, action: ConcreteAction) {
  if (participantId === t.ids[0]) await command(t, 'act', { participantId, action });
  else {
    const result = await controllers.submitAction(t.id, { requestId: randomUUID(), expectedPokerRevision: t.revision, participantId, action });
    expect(result).toMatchObject({ ok: true, pokerRevision: t.revision + 1 }); if (!result.ok) throw new Error('Expected accepted Bot fixture action.'); t.revision = result.pokerRevision;
  }
}

test('sparse three-player seats preserve public position, antes, all street order, fixed membership, and restoration', async () => {
  const t = await table(3, { ante: 5 }); const [human, bob, carol] = t.ids as [string, string, string];
  for (const [participantId, seat] of [[human, 7], [bob, 9], [carol, 2]] as const) await command(t, 'seat-participant', { participantId, seat });
  await command(t, 'set-button', { seat: 7 }); await command(t, 'start-hand');
  const before = await read(t);
  expect(before).toMatchObject({ pokerRevision: 5, view: { configuration: { seatCount: 9, ante: 5 }, state: { buttonSeat: 7, smallBlindParticipantId: bob, bigBlindParticipantId: carol, actorId: human, amountToCall: 20 } } });
  expect(before.view.state.participants.map(p => [p.seat, p.stack, p.anteContribution, p.wager, p.contribution, p.cardCount])).toEqual([[7, 995, 5, 0, 5, 2], [9, 985, 5, 10, 15, 2], [2, 975, 5, 20, 25, 2]]);
  expect(before.view.state.participants[0]!.holeCards).toHaveLength(2);
  expect(before.view.state.participants[1]).not.toHaveProperty('holeCards'); expect(before.view.state.participants[2]).not.toHaveProperty('holeCards');
  for (const [kind, fields] of [['move-participant', { participantId: human, seat: 8 }], ['leave-participant', { participantId: bob }], ['set-sitting-out', { participantId: carol, sittingOut: true }], ['top-up-to', { participantId: human, targetStack: 1000 }], ['set-button', { seat: 2 }], ['start-hand', {}]] as const) {
    const response = await submit(t, kind, { requestId: randomUUID(), expectedPokerRevision: t.revision, ...fields });
    expect(response.status).toBe(400); expect(await response.json()).toMatchObject({ ok: false, rejection: { code: 'active-hand' } });
    expect(await read(t)).toEqual(before);
  }
  for (const actor of [human, bob, carol]) {
    expect((await read(t)).view.state.actorId).toBe(actor); await act(t, actor, { type: actor === carol ? 'check' : 'call' });
  }
  for (const [index, street] of ['flop', 'turn', 'river'].entries()) {
    const view = await read(t); expect(view.view.state).toMatchObject({ street, actorId: bob }); expect(view.view.state.board).toHaveLength(index + 3);
    expect(view.view.state.participants.map(p => [p.stack, p.wager, p.anteContribution, p.contribution])).toEqual([[975, 0, 5, 25], [975, 0, 5, 25], [975, 0, 5, 25]]);
    for (const actor of [bob, carol, human]) { expect((await read(t)).view.state.actorId).toBe(actor); await act(t, actor, { type: 'check' }); }
  }
  const completed = await read(t);
  expect(completed.view.state).toMatchObject({ status: 'completed-hand', actorId: null, pots: [{ amount: 75, eligibleParticipantIds: [human, bob, carol] }], returns: [] });
  expect(completed.view.state.participants.reduce((sum, p) => sum + p.stack, 0)).toBe(3000);
  expect(completed.view.history[0]!.decisions[0]!.state).toMatchObject({ actorId: human, amountToCall: 20 });
  expect(completed.view.history[0]!.decisions[0]!.state.participants[1]).not.toHaveProperty('holeCards');
  expect(completed.view.history[0]!.decisions[0]!.state.participants[1]!.anteContribution).toBe(5);
  expect(JSON.stringify(completed)).not.toMatch(/"(?:seed|deck|burns|drawnCardCount|commands)"\s*:/);
  await server.close(); await startServer(); expect(await read(t)).toEqual(completed);
  await command(t, 'move-participant', { participantId: human, seat: 8 }); await command(t, 'leave-participant', { participantId: bob }); await command(t, 'start-hand');
  const next = await read(t);
  expect(next.view.state).toMatchObject({ buttonSeat: 8, smallBlindParticipantId: human, bigBlindParticipantId: carol, actorId: human });
  expect(next.view.history[0]!.result!.buttonSeat).toBe(7); expect(next.view.history[0]!.result!.participants.map(p => p.seat)).toEqual([7, 9, 2]);
});

test('nine-player server acceptance retains clockwise action and conservation through showdown', async () => {
  const t = await table(9); for (const [index, participantId] of t.ids.entries()) await command(t, 'seat-participant', { participantId, seat: index + 1 }); await command(t, 'start-hand');
  const start = await read(t);
  expect(start.view.state).toMatchObject({ actorId: t.ids[3], smallBlindParticipantId: t.ids[1], bigBlindParticipantId: t.ids[2] });
  expect(start.view.state.participants).toHaveLength(9);
  expect(start.view.state.participants.filter(p => p.holeCards)).toHaveLength(1);
  for (const index of [3, 4, 5, 6, 7, 8, 0, 1, 2]) { expect((await read(t)).view.state.actorId).toBe(t.ids[index]); await act(t, t.ids[index]!, { type: index === 2 ? 'check' : 'call' }); }
  for (let street = 0; street < 3; street++) for (const index of [1, 2, 3, 4, 5, 6, 7, 8, 0]) { expect((await read(t)).view.state.actorId).toBe(t.ids[index]); await act(t, t.ids[index]!, { type: 'check' }); }
  const done = await read(t); expect(done.view.state).toMatchObject({ status: 'completed-hand', actorId: null, board: expect.any(Array), pots: [{ amount: 180, eligibleParticipantIds: t.ids }] });
  expect(done.view.state.board).toHaveLength(5); expect(done.view.state.participants.reduce((sum, p) => sum + p.stack, 0)).toBe(9000);
});

test('short forced bets expose only the real Call and commit-gate immediate reveal and runout', async () => {
  const t = await table(3); const [human, bob, carol] = t.ids as [string, string, string];
  for (const [participantId, seat, buyIn] of [[human, 1, 100], [bob, 2, 5], [carol, 3, 15]] as const) await command(t, 'seat-participant', { participantId, seat, buyIn }); await command(t, 'start-hand');
  const before = await read(t);
  expect(before.view.state).toMatchObject({ actorId: human, amountToCall: 15, legalActions: [{ type: 'fold' }, { type: 'call' }] });
  for (const action of [{ type: 'check' }, { type: 'raise', raiseTo: 40 }] as const) { const response = await submit(t, 'act', { requestId: randomUUID(), expectedPokerRevision: t.revision, participantId: human, action }); expect(response.status).toBe(400); expect(await response.json()).toMatchObject({ ok: false, rejection: { code: 'illegal-action' } }); expect(await read(t)).toEqual(before); }
  await act(t, human, { type: 'call' }); const done = await read(t);
  expect(done.view.state).toMatchObject({ status: 'completed-hand', actorId: null, pots: [{ amount: 15, eligibleParticipantIds: [human, bob, carol] }, { amount: 20, eligibleParticipantIds: [human, carol] }], returns: [] });
  expect(done.view.state.participants[0]!.contribution).toBe(15); expect(done.view.state.participants.reduce((sum, p) => sum + p.stack, 0)).toBe(120);

  const immediate = await table(2); for (const [index, participantId] of immediate.ids.entries()) await command(immediate, 'seat-participant', { participantId, seat: index + 1, buyIn: index === 0 ? 5 : 100 });
  const seated = await read(immediate);
  beforeCommit = async context => { if (context.tableSessionId === immediate.id && context.requestId === 'forced-runout') throw new Error('controlled forced-bet rollback'); };
  try { expect((await submit(immediate, 'start-hand', { requestId: 'forced-runout', expectedPokerRevision: immediate.revision })).status).toBe(503); } finally { beforeCommit = async () => {}; }
  expect(await read(immediate)).toEqual(seated);
  const entered = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
  beforeCommit = async context => { if (context.tableSessionId === immediate.id && context.requestId === 'forced-runout') { entered.resolve(); await release.promise; } };
  const starting = submit(immediate, 'start-hand', { requestId: 'forced-runout', expectedPokerRevision: immediate.revision }); await entered.promise;
  try { expect(await read(immediate)).toEqual(seated); } finally { release.resolve(); beforeCommit = async () => {}; }
  expect((await starting).status).toBe(200); const runout = await read(immediate);
  expect(runout.view.state).toMatchObject({ status: 'completed-hand', actorId: null, board: expect.any(Array), returns: [{ participantId: immediate.ids[1], amount: 15 }] });
  expect(runout.view.state.board).toHaveLength(5); expect(runout.view.state.participants.every(p => p.holeCards?.length === 2)).toBe(true); expect(runout.view.state.participants.reduce((sum, p) => sum + p.stack, 0)).toBe(105);
  expect((await submit(immediate, 'start-hand', { requestId: 'forced-runout', expectedPokerRevision: immediate.revision })).status).toBe(200); expect(await read(immediate)).toEqual(runout);
});
