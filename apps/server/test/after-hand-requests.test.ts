import { afterAll, beforeAll, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import WebSocket from 'ws';
import { baselinePlayingStrategy, type ConcreteAction, type ObservableGameConfiguration, type ObservableTableSession, type ObservableTableUpdate, type ServerLiveMessage } from '@poker/contracts';
import { createServer } from '../src/server.js';
import type { TableSessionControllerCommands } from '../src/mutations.js';
import { nameGuest } from './fixtures/guest.js';
import { ManualClock } from './fixtures/clock.js';
import { connectLive, announcedCountdown } from './fixtures/online.js';

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
async function table(count = 2, configuration: Partial<ObservableGameConfiguration> = {}, options?: { actionTimeLimitSeconds: 15 | 30 | 60 }): Promise<Table> {
  const cookie = (await fetch(base + '/api/identity')).headers.get('set-cookie')!.split(';')[0]!; await nameGuest(base, cookie);
  const response = await fetch(base + '/api/table-sessions', { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ requestId: randomUUID(), configuration, ...(options ? { options } : {}), bots: Array.from({ length: count - 1 }, (_, i) => ({ name: 'Bot ' + (i + 1), playingStrategy: baselinePlayingStrategy })) }) });
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
async function accepted(t: Table, participantId: string, action: ConcreteAction) {
  const response = participantId === t.ids[0] ? await submit(t, 'act', { participantId, action })
    : Response.json(await controllers.submitAction(t.id, { requestId: randomUUID(), expectedPokerRevision: t.revision, participantId, action }));
  expect(response.status).toBe(200);
  t.revision = (await response.json()).pokerRevision;
}
async function headsUp() {
  const t = await table(2); const [human, bot] = t.ids as [string, string];
  await command(t, 'seat-participant', { participantId: human, seat: 1 }); await command(t, 'seat-participant', { participantId: bot, seat: 4 });
  return { t, human, bot };
}
/** Deals and lets the human fold at once: the Hand is over and its 2 s payout phase starts now. */
async function foldedHand(t: Table, human: string) {
  await command(t, 'start-hand'); clock.advance(1500);
  await accepted(t, human, { type: 'fold' });
  return clock.now();
}
const participant = (view: ObservableTableSession, id: string) => view.view.state.participants.find(p => p.participantId === id)!;

test('a sit-out asked for during a Hand is recorded as pending, visible to the table, and applied when the payout phase ends', async () => {
  const { t, human } = await headsUp();
  await command(t, 'start-hand'); clock.advance(1500);
  const before = await read(t);
  const asked = await command(t, 'set-sitting-out', { participantId: human, sittingOut: true });
  // Nothing at the poker table changes: only the application records the request, so just the session revision moves.
  expect(asked).toEqual({ ok: true, tableSessionId: t.id, pokerRevision: before.pokerRevision, sessionRevision: before.sessionRevision + 1, afterHand: true });
  const waiting = await read(t);
  expect(waiting.pendingChanges).toEqual([{ participantId: human, change: 'sit-out' }]);
  expect(waiting.view).toEqual(before.view);
  await accepted(t, human, { type: 'fold' });
  const paid = clock.now();
  clock.advanceTo(paid + 1999);
  expect((await read(t)).pendingChanges).toEqual([{ participantId: human, change: 'sit-out' }]);
  expect(participant(await read(t), human).sittingOut).toBe(false);
  clock.advanceTo(paid + 2000);
  await expect.poll(async () => (await read(t)).pendingChanges).toEqual([]);
  const settled = await read(t);
  expect(participant(settled, human)).toMatchObject({ seat: 1, sittingOut: true });
  expect(settled.pokerRevision).toBe(t.revision + 1);
});

test('a Stand Up asked for during a Hand cashes out after it, keeps every chip, and applies once however often it is asked or the server restarts', async () => {
  const { t, human, bot } = await headsUp();
  await command(t, 'start-hand'); clock.advance(1500);
  const asked = await (await submit(t, 'stand-up-participant', { participantId: human }, 'stand-up-once')).json();
  expect(asked).toMatchObject({ ok: true, afterHand: true });
  // The same request again, and a fresh request for the same change, record nothing further.
  expect(await (await submit(t, 'stand-up-participant', { participantId: human }, 'stand-up-once')).json()).toEqual(asked);
  expect(await (await submit(t, 'stand-up-participant', { participantId: human })).json()).toEqual(asked);
  expect((await read(t)).sessionRevision).toBe(asked.sessionRevision);
  await accepted(t, human, { type: 'fold' });
  const paid = clock.now();
  const finished = await read(t);
  expect(finished.pendingChanges).toEqual([{ participantId: human, change: 'stand-up' }]);
  const chipsAtTable = finished.view.state.participants.reduce((sum, p) => sum + p.stack, 0);
  expect(chipsAtTable).toBe(2000);
  // A restart in the middle of the payout phase keeps the request pending.
  clock.advanceTo(paid + 1000);
  await server.close(); await startServer();
  expect((await read(t)).pendingChanges).toEqual([{ participantId: human, change: 'stand-up' }]);
  clock.advanceTo(paid + 2000);
  await expect.poll(async () => (await read(t)).pendingChanges).toEqual([]);
  const settled = await read(t);
  expect(participant(settled, human)).toMatchObject({ seat: null, stack: 0, sittingOut: false });
  // The stack was cashed out, not lost or moved: what left the table plus what stayed is what was there.
  const cashOut = participant(finished, human).stack;
  expect(participant(settled, bot).stack + cashOut).toBe(chipsAtTable);
  expect((await controllers.readPersistedSession(t.id))!.pokerRecord.commands.filter(command => command.type === 'stand-up-participant')).toHaveLength(1);
  // A late retry of the original request still answers with its original outcome.
  expect(await (await submit(t, 'stand-up-participant', { participantId: human, expectedPokerRevision: asked.pokerRevision }, 'stand-up-once')).json()).toEqual(asked);
});

test('a request whose Hand ended while the server was down is applied once when the server starts', async () => {
  const { t, human } = await headsUp();
  await command(t, 'start-hand'); clock.advance(1500);
  await command(t, 'leave-table', { participantId: human });
  await accepted(t, human, { type: 'fold' });
  await server.close();
  // The outage outlasts the payout phase; no timer of the closed server fires.
  clock.advance(60_000);
  await startServer();
  await expect.poll(async () => (await controllers.readPersistedSession(t.id))!.pendingChanges).toEqual([]);
  const session = (await controllers.readPersistedSession(t.id))!;
  expect(session.bindings.find(binding => binding.participantId === human)).toMatchObject({ membership: 'left' });
  expect(session.pokerRecord.commands.slice(-2).map(command => command.type)).toEqual(['stand-up-participant', 'leave-table']);
  await server.close(); await startServer();
  expect((await controllers.readPersistedSession(t.id))!.pokerRecord.commands).toHaveLength(session.pokerRecord.commands.length);
});

test('a stronger request replaces a weaker pending one, and a weaker one changes nothing', async () => {
  const { t, human } = await headsUp();
  await command(t, 'start-hand'); clock.advance(1500);
  const sitOut = await command(t, 'set-sitting-out', { participantId: human, sittingOut: true });
  const leave = await command(t, 'leave-table', { participantId: human });
  expect((await read(t)).pendingChanges).toEqual([{ participantId: human, change: 'leave-table' }]);
  const again = await command(t, 'set-sitting-out', { participantId: human, sittingOut: true });
  expect(leave.sessionRevision).toBe(sitOut.sessionRevision + 1);
  expect(again.sessionRevision).toBe(leave.sessionRevision);
  expect((await read(t)).pendingChanges).toEqual([{ participantId: human, change: 'leave-table' }]);
});

test('top-ups and seat moves are not deferred: they wait for the Hand, which lasts until its payout phase ends', async () => {
  const { t, human } = await headsUp();
  await command(t, 'start-hand'); clock.advance(1500);
  const refused = async (kind: string, fields: object) => { const response = await submit(t, kind, fields); return { status: response.status, code: (await response.json()).rejection?.code }; };
  const attempts: [string, object][] = [['top-up-to', { participantId: human, targetStack: 1000 }], ['move-participant', { participantId: human, seat: 3 }], ['set-sitting-out', { participantId: human, sittingOut: false }]];
  for (const [kind, fields] of attempts) expect({ kind, ...await refused(kind, fields) }).toEqual({ kind, status: 400, code: 'active-hand' });
  await accepted(t, human, { type: 'fold' });
  const paid = clock.now();
  // The Hand is decided but its payout is still being shown: changing seats or chips now would reveal it early.
  for (const [kind, fields] of attempts) expect({ kind, ...await refused(kind, fields) }).toEqual({ kind, status: 400, code: 'active-hand' });
  clock.advanceTo(paid + 2000);
  await command(t, 'move-participant', { participantId: human, seat: 3 });
  expect(participant(await read(t), human)).toMatchObject({ seat: 3 });
});

test('between Hands the same requests apply at once, and Leave Table stands the Participant up in the same commit', async () => {
  const { t, human } = await headsUp();
  await foldedHand(t, human);
  clock.advance(2000);
  const revision = t.revision;
  const sat = await command(t, 'set-sitting-out', { participantId: human, sittingOut: true });
  expect(sat).toEqual({ ok: true, tableSessionId: t.id, pokerRevision: revision + 1, sessionRevision: expect.any(Number) });
  expect(participant(await read(t), human).sittingOut).toBe(true);
  expect((await read(t)).pendingChanges).toEqual([]);
  const left = await command(t, 'leave-table', { participantId: human });
  // One request, one revision step, two CashGame commands.
  expect(left).toMatchObject({ ok: true, pokerRevision: revision + 2 });
  expect(left).not.toHaveProperty('afterHand');
  expect((await controllers.readPersistedSession(t.id))!.pokerRecord.commands.slice(-2).map(command => command.type)).toEqual(['stand-up-participant', 'leave-table']);
  expect((await fetch(base + '/api/table-sessions/' + t.id, { headers: { cookie: t.cookie } })).status).toBe(404);
});

test('a Practice owner who leaves during a Hand is stood up after it, keeps the table in their saved list, and returns to the same Participant and history without a link', async () => {
  const { t, human, bot } = await headsUp();
  const socket = new WebSocket(base.replace('http:', 'ws:') + '/api/live', { headers: { cookie: t.cookie } });
  const messages: ServerLiveMessage[] = [];
  socket.on('message', data => messages.push(JSON.parse(data.toString())));
  socket.on('open', () => socket.send(JSON.stringify({ type: 'subscribe-table', requestId: randomUUID(), tableSessionId: t.id })));
  try {
    await command(t, 'start-hand'); clock.advance(1500);
    expect(await command(t, 'leave-table', { participantId: human })).toMatchObject({ ok: true, afterHand: true });
    await accepted(t, human, { type: 'fold' });
    const finished = await read(t);
    expect(finished.pendingChanges).toEqual([{ participantId: human, change: 'leave-table' }]);
    // Until the payout phase ends they are still at the table.
    expect((await fetch(base + '/api/table-sessions', { headers: { cookie: t.cookie } })).status).toBe(200);
    clock.advance(2000);
    await expect.poll(async () => (await fetch(base + '/api/table-sessions/' + t.id, { headers: { cookie: t.cookie } })).status).toBe(404);
    // Their client is told once, so it leaves the table instead of showing a view it can no longer refresh.
    await expect.poll(() => messages.filter(message => message.type === 'table-membership-ended')).toEqual([{ type: 'table-membership-ended', tableSessionId: t.id, reason: 'left' }]);
    // The table stays in the saved list of its owner, marked as left; the Bot's seat and the freed Seat stay at the table.
    expect(await (await fetch(base + '/api/table-sessions', { headers: { cookie: t.cookie } })).json()).toMatchObject({ tables: [{ tableSessionId: t.id, mode: 'practice', left: true }] });
    const strangerCookie = (await fetch(base + '/api/identity')).headers.get('set-cookie')!.split(';')[0]!; await nameGuest(base, strangerCookie, 'Stranger');
    const refusedStranger = await fetch(base + '/api/table-sessions/' + t.id + '/rejoin-table', { method: 'POST', headers: { 'content-type': 'application/json', cookie: strangerCookie }, body: JSON.stringify({ requestId: randomUUID() }) });
    expect(refusedStranger.status).toBe(404);
    const rejoined = await fetch(base + '/api/table-sessions/' + t.id + '/rejoin-table', { method: 'POST', headers: { 'content-type': 'application/json', cookie: t.cookie }, body: JSON.stringify({ requestId: randomUUID() }) });
    expect(rejoined.status).toBe(200);
    expect(await rejoined.json()).toMatchObject({ ok: true, participantId: human });
    const back = await read(t);
    expect(back).toMatchObject({ viewerParticipantId: human, pendingChanges: [], bindings: [{ participantId: human, name: 'You' }, { participantId: bot }] });
    expect(participant(back, human)).toMatchObject({ seat: null, stack: 0 });
    expect(back.view.history).toEqual(finished.view.history);
    expect(back.view.history).toHaveLength(1);
    const saved = await (await fetch(base + '/api/table-sessions', { headers: { cookie: t.cookie } })).json();
    expect(saved).toMatchObject({ tables: [{ tableSessionId: t.id, mode: 'practice' }] });
    expect(saved.tables[0]).not.toHaveProperty('left');
  } finally { socket.terminate(); }
});

test('a Practice human who never sat down can leave and return, and naming a Bot to leave is refused', async () => {
  const t = await table(2); const [human, bot] = t.ids as [string, string];
  const refused = await submit(t, 'leave-table', { participantId: bot });
  expect({ status: refused.status, code: (await refused.json()).rejection?.code }).toEqual({ status: 400, code: 'participant-not-human' });
  const revision = (await read(t)).pokerRevision;
  expect(await command(t, 'leave-table', { participantId: human })).toMatchObject({ ok: true, pokerRevision: revision });
  expect((await fetch(base + '/api/table-sessions/' + t.id, { headers: { cookie: t.cookie } })).status).toBe(404);
  const rejoined = await fetch(base + '/api/table-sessions/' + t.id + '/rejoin-table', { method: 'POST', headers: { 'content-type': 'application/json', cookie: t.cookie }, body: JSON.stringify({ requestId: randomUUID() }) });
  expect(await rejoined.json()).toMatchObject({ ok: true, participantId: human });
});

test('Deal received before the table has woken for the end of the payout phase still finds the Hand’s requests applied', async () => {
  // A clock whose timers never fire stands for a wake-up that arrives after the request does.
  const silent = new (class extends ManualClock { override setTimer() { return () => {}; } })();
  const quietSchema = schema + '_quiet';
  await administration.query('CREATE SCHEMA "' + quietSchema + '"');
  const quiet = await createServer({ clock: silent, automaticBots: false, databaseUrl: databaseUrl!, schema: quietSchema });
  const origin = await quiet.listen({ host: '127.0.0.1', port: 0 });
  try {
    const cookie = (await fetch(origin + '/api/identity')).headers.get('set-cookie')!.split(';')[0]!; await nameGuest(origin, cookie);
    const created = await (await fetch(origin + '/api/table-sessions', { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ requestId: randomUUID(), bots: [{ name: 'Bot', playingStrategy: baselinePlayingStrategy }] }) })).json();
    const [human, bot] = created.bindings.map((b: { participantId: string }) => b.participantId) as [string, string];
    const post = async (kind: string, fields: object, revision: number) => (await fetch(origin + '/api/table-sessions/' + created.tableSessionId + '/' + kind, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ requestId: randomUUID(), expectedPokerRevision: revision, ...fields }) })).json();
    const view = async (): Promise<ObservableTableSession> => (await fetch(origin + '/api/table-sessions/' + created.tableSessionId, { headers: { cookie } })).json();
    await post('seat-participant', { participantId: human, seat: 1 }, 0); await post('seat-participant', { participantId: bot, seat: 4 }, 1);
    await post('start-hand', {}, 2); silent.advance(1500);
    await post('set-sitting-out', { participantId: human, sittingOut: true }, 3);
    await post('act', { participantId: human, action: { type: 'fold' } }, 3);
    silent.advance(2000);
    // Nothing has woken the table, so the request is still pending.
    expect((await view()).pendingChanges).toEqual([{ participantId: human, change: 'sit-out' }]);
    // The Deal names the revision it saw, which the applied requests then make stale: nothing is dealt on a table that has since changed.
    const stale = await post('start-hand', {}, 4);
    expect(stale).toMatchObject({ ok: false, rejection: { code: 'stale-poker-revision' } });
    const settled = await view();
    expect(settled).toMatchObject({ pendingChanges: [], pokerRevision: 5 });
    expect(participant(settled, human).sittingOut).toBe(true);
    // Deal resumes them, as for any voluntary sit-out.
    expect(await post('start-hand', {}, 5)).toMatchObject({ ok: true });
    expect(participant(await view(), human)).toMatchObject({ sittingOut: false, inHand: true });
  } finally { await quiet.close(); await administration.query('DROP SCHEMA "' + quietSchema + '" CASCADE'); }
});

/** Online Tables: each cookie is a separate Guest. */
async function guest(name: string) {
  const cookie = (await fetch(base + '/api/identity')).headers.get('set-cookie')!.split(';')[0]!;
  await nameGuest(base, cookie, name);
  return cookie;
}
const get = (path: string, cookie: string) => fetch(base + path, { headers: { cookie } });
const post = (path: string, cookie: string, body: unknown) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(body) });
/**
 * An Online Table of Ann (the owner) and Ben, both joined through the link, connected and seated heads-up. Automatic
 * Dealing has dealt Hand 1, and the first Action Window is open.
 */
async function onlineHand() {
  const ann = await guest('Ann'), ben = await guest('Ben');
  const created = await (await post('/api/table-sessions', ann, { requestId: randomUUID(), mode: 'online' })).json();
  const id = created.tableSessionId as string, annId = created.bindings[0].participantId as string;
  const view = async (cookie: string): Promise<ObservableTableSession> => (await get('/api/table-sessions/' + id, cookie)).json();
  const token = (await view(ann)).joinToken!;
  const join = async (cookie: string) => post('/api/join-links/' + token + '/join', cookie, { requestId: randomUUID() });
  const benId = (await (await join(ben)).json()).participantId as string;
  const as = async (cookie: string, kind: string, fields: object) => post('/api/table-sessions/' + id + '/' + kind, cookie, { requestId: randomUUID(), expectedPokerRevision: (await view(cookie)).pokerRevision, ...fields });
  await connectLive(base, ann, id); await connectLive(base, ben, id);
  expect((await as(ann, 'seat-participant', { participantId: annId, seat: 1 })).status).toBe(200);
  expect((await as(ben, 'seat-participant', { participantId: benId, seat: 2 })).status).toBe(200);
  clock.advanceTo((await announcedCountdown(() => view(ann))).endsAt);
  await expect.poll(async () => (await view(ann)).view.state.handId).toBe('hand-1');
  clock.advance(1500);
  const cookieOf = (participantId: string) => participantId === annId ? ann : ben;
  return { ann, ben, id, annId, benId, token, view, join, as, cookieOf };
}

test('at an Online Table a seated Guest who leaves during a Hand is stood up after it, frees a place, and rejoins through the Join Link as the same Participant with their history', async () => {
  const { ann, ben, id, annId, benId, token, view, join, as, cookieOf } = await onlineHand();
  const watcher = await guest('Cy');
  const placesTaken = async () => (await (await get('/api/join-links/' + token, watcher)).json()).placesTaken as number;
  expect(await placesTaken()).toBe(2);
  const asked = await as(ben, 'leave-table', { participantId: benId });
  expect(await asked.json()).toMatchObject({ ok: true, afterHand: true });
  // Everyone at the table sees it coming; nothing has changed yet.
  expect((await view(ann)).pendingChanges).toEqual([{ participantId: benId, change: 'leave-table' }]);
  expect(participant(await view(ann), benId)).toMatchObject({ seat: 2, stack: expect.any(Number) });
  const actor = (await view(ann)).view.state.actorId!;
  expect((await as(cookieOf(actor), 'act', { participantId: actor, action: { type: 'fold' } })).status).toBe(200);
  const decided = await view(ben);
  expect(decided.view.state.status).toBe('completed-hand');
  const stacks = decided.view.state.participants.map(p => p.stack);
  clock.advance(2000);
  await expect.poll(async () => (await get('/api/table-sessions/' + id, ben)).status).toBe(404);
  expect(await (await get('/api/table-sessions', ben)).json()).toEqual({ tables: [] });
  expect(await placesTaken()).toBe(1);
  const after = await view(ann);
  expect(after.pendingChanges).toEqual([]);
  expect(participant(after, benId)).toMatchObject({ seat: null, stack: 0 });
  expect(participant(after, annId).stack + participant(decided, benId).stack).toBe(stacks.reduce((sum, stack) => sum + stack, 0));
  // The link tells the returning Guest who they will be, then gives them back the same Participant.
  expect(await (await get('/api/join-links/' + token, ben)).json()).toMatchObject({ alreadyJoined: false, returningAs: 'Ben' });
  const rejoined = await join(ben);
  expect(await rejoined.json()).toMatchObject({ ok: true, participantId: benId });
  const back = await view(ben);
  expect(back).toMatchObject({ viewerParticipantId: benId, pendingChanges: [] });
  expect(back.bindings.find(b => b.participantId === benId)).toMatchObject({ name: 'Ben' });
  expect(back.view.history).toEqual(decided.view.history);
  expect(back.view.history).toHaveLength(1);
  expect(await placesTaken()).toBe(2);
});

test('nobody manages another human, and an owner who leaves keeps their table, which keeps running without them', async () => {
  const { ann, ben, id, annId, benId, token, view, as } = await onlineHand();
  // Both are seated in a Hand. Requests naming the other human are refused for the owner and everyone else.
  for (const [cookie, target] of [[ben, annId], [ann, benId]] as const) {
    for (const [kind, fields] of [['leave-table', {}], ['stand-up-participant', {}], ['set-sitting-out', { sittingOut: true }]] as const) {
      const refused = await as(cookie, kind, { participantId: target, ...fields });
      expect({ kind, status: refused.status, code: (await refused.json()).rejection?.code }).toEqual({ kind, status: 403, code: 'not-your-participant' });
    }
  }
  expect((await view(ann)).pendingChanges).toEqual([]);
  // Finish the Hand so the owner, not seated at the end of it, can leave at once: she stands up, then leaves.
  const actor = (await view(ann)).view.state.actorId!;
  expect((await as(actor === annId ? ann : ben, 'act', { participantId: actor, action: { type: 'fold' } })).status).toBe(200);
  clock.advance(2000);
  await expect.poll(async () => (await view(ann)).view.state.status).toBe('completed-hand');
  expect((await as(ann, 'leave-table', { participantId: annId })).status).toBe(200);
  expect((await get('/api/table-sessions/' + id, ann)).status).toBe(404);
  expect(await (await get('/api/table-sessions', ann)).json()).toMatchObject({ tables: [{ tableSessionId: id, mode: 'online', left: true }] });
  // The table keeps running, and ownership stays with her.
  const running = await view(ben);
  expect(running.ownerParticipantId).toBe(annId);
  expect(running).not.toHaveProperty('joinToken');
  const ownerOnly = await as(ben, 'set-button', { seat: 2 });
  expect({ status: ownerOnly.status, code: (await ownerOnly.json()).rejection?.code }).toEqual({ status: 403, code: 'table-owner-required' });
  expect((await as(ben, 'move-participant', { participantId: benId, seat: 3 })).status).toBe(200);
  // Only the owner returns without the link; nobody else can use that route.
  expect((await post('/api/table-sessions/' + id + '/rejoin-table', ben, { requestId: randomUUID() })).status).toBe(404);
  const returned = await post('/api/table-sessions/' + id + '/rejoin-table', ann, { requestId: randomUUID() });
  expect(await returned.json()).toMatchObject({ ok: true, participantId: annId });
  const owner = await view(ann);
  expect(owner).toMatchObject({ viewerParticipantId: annId, ownerParticipantId: annId, joinToken: token });
  expect(participant(owner, annId)).toMatchObject({ seat: null, stack: 0 });
});

test('at a Practice Table a missed Action Deadline plays the Timeout Action without sitting the human out, and a sit-out asked for meanwhile applies after the Hand, before Deal', async () => {
  const t = await table(2, {}, { actionTimeLimitSeconds: 15 }); const [human, bot] = t.ids as [string, string];
  await command(t, 'seat-participant', { participantId: human, seat: 1 }); await command(t, 'seat-participant', { participantId: bot, seat: 4 });
  await command(t, 'start-hand'); clock.advance(1500);
  expect(await command(t, 'set-sitting-out', { participantId: human, sittingOut: true })).toMatchObject({ afterHand: true });
  clock.advance(15_001);
  // The human never acted: the server folded for them, as their own decision.
  await expect.poll(async () => (await read(t)).view.state.status).toBe('completed-hand');
  const timedOut = await read(t);
  expect(timedOut.view.history[0]!.decisions.map(decision => decision.action)).toEqual([{ participantId: human, action: { type: 'fold' } }]);
  // The Timeout Action sat nobody out: only the request does, and not before the Hand has been paid out.
  expect(participant(timedOut, human).sittingOut).toBe(false);
  expect(timedOut.pendingChanges).toEqual([{ participantId: human, change: 'sit-out' }]);
  clock.advance(2000);
  await expect.poll(async () => (await read(t)).pendingChanges).toEqual([]);
  expect(participant(await read(t), human).sittingOut).toBe(true);
  // Deal then resumes them, as for any voluntary sit-out.
  t.revision = (await read(t)).pokerRevision;
  await command(t, 'start-hand');
  expect(participant(await read(t), human)).toMatchObject({ sittingOut: false, inHand: true });
});

test('at a Practice Table a missed Action Deadline with nothing requested leaves the human playing and the table waiting for their Deal', async () => {
  const t = await table(2, {}, { actionTimeLimitSeconds: 15 }); const [human, bot] = t.ids as [string, string];
  await command(t, 'seat-participant', { participantId: human, seat: 1 }); await command(t, 'seat-participant', { participantId: bot, seat: 4 });
  await command(t, 'start-hand'); clock.advance(1500);
  clock.advance(15_001);
  await expect.poll(async () => (await read(t)).view.state.status).toBe('completed-hand');
  clock.advance(2000);
  const after = await read(t);
  expect(after.pendingChanges).toEqual([]);
  expect(participant(after, human)).toMatchObject({ seat: 1, sittingOut: false });
  expect(after.view.state.status).toBe('completed-hand');
});
