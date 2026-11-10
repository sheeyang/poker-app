import { afterAll, beforeAll, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import WebSocket from 'ws';
import { baselinePlayingStrategy, type ObservableTableSession, type ServerLiveMessage } from '@poker/contracts';
import { createServer } from '../src/server.js';
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
async function startServer() {
  server = await createServer({ clock, automaticBots: false, databaseUrl: databaseUrl!, schema });
  base = await server.listen({ host: '127.0.0.1', port: 0 });
}
beforeAll(async () => { await administration.query('CREATE SCHEMA "' + schema + '"'); await startServer(); });
afterAll(async () => { await server?.close(); await administration.query('DROP SCHEMA "' + schema + '" CASCADE'); await administration.end(); });

/** Each cookie is a separate Guest. */
async function guest(name: string) {
  const cookie = (await fetch(base + '/api/identity')).headers.get('set-cookie')!.split(';')[0]!;
  await nameGuest(base, cookie, name);
  return cookie;
}
const get = (path: string, cookie: string) => fetch(base + path, { headers: { cookie } });
const post = (path: string, cookie: string, body: unknown) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(body) });
const participant = (view: ObservableTableSession, id: string) => view.view.state.participants.find(p => p.participantId === id)!;
const rejection = async (response: Response) => { const body = await response.json(); return { status: response.status, code: body.rejection?.code as string | undefined }; };

/** An Online Table owned by Ann, with `names` joined through its Join Link, the table's own address. Nobody is seated. */
async function onlineTable(...names: string[]) {
  const ann = await guest('Ann');
  const created = await (await post('/api/table-sessions', ann, { requestId: randomUUID(), mode: 'online' })).json();
  const id = created.tableSessionId as string, annId = created.bindings[0].participantId as string;
  const view = async (cookie: string): Promise<ObservableTableSession> => (await get('/api/table-sessions/' + id, cookie)).json();
  const join = (cookie: string) => post('/api/table-sessions/' + id + '/join-table', cookie, { requestId: randomUUID() });
  const preview = (cookie: string) => get('/api/table-sessions/' + id + '/join-preview', cookie);
  const as = async (cookie: string, kind: string, fields: object) => post('/api/table-sessions/' + id + '/' + kind, cookie, { requestId: randomUUID(), expectedPokerRevision: (await view(cookie)).pokerRevision, ...fields });
  const guests: Record<string, { cookie: string; participantId: string }> = {};
  for (const name of names) {
    const cookie = await guest(name);
    guests[name] = { cookie, participantId: (await (await join(cookie)).json()).participantId as string };
  }
  return { ann, annId, id, view, join, preview, as, guests };
}

/** Listens on a Guest's live connection to one table; `messages` collects everything the table sends them. */
async function listen(cookie: string, tableSessionId: string) {
  const socket = new WebSocket(base.replace('http:', 'ws:') + '/api/live', { headers: { cookie } });
  const messages: ServerLiveMessage[] = [];
  socket.on('message', data => messages.push(JSON.parse(data.toString())));
  await expect.poll(() => messages.length).toBe(1);
  socket.send(JSON.stringify({ type: 'subscribe-table', requestId: randomUUID(), tableSessionId }));
  await expect.poll(() => messages.some(message => message.type === 'table-update')).toBe(true);
  return { messages, close: () => socket.close() };
}

test('between Hands, Removal stands the Guest up at once and leaves them as a Guest who has left, and the Join Link lets them back as the same Participant', async () => {
  const { ann, annId, id, view, join, preview, as, guests } = await onlineTable('Ben', 'Cy');
  const { cookie: ben, participantId: benId } = guests.Ben!, cy = guests.Cy!;
  expect((await as(ben, 'seat-participant', { participantId: benId, seat: 1 })).status).toBe(200);
  expect((await as(cy.cookie, 'seat-participant', { participantId: cy.participantId, seat: 2 })).status).toBe(200);
  expect(participant(await view(ann), benId)).toMatchObject({ seat: 1, stack: 1000 });
  const bensConnection = await listen(ben, id);

  const removed = await as(ann, 'remove-participant', { participantId: benId });
  expect(removed.status).toBe(200);
  // Nothing is pending: it applied at once, as one poker step (Stand Up and Leave Table are one commit).
  expect(await removed.json()).toMatchObject({ ok: true, tableSessionId: id });
  const table = await view(ann);
  expect(table.pendingChanges).toEqual([]);
  expect(participant(table, benId)).toMatchObject({ seat: null, stack: 0 });
  expect(table.bindings.find(binding => binding.participantId === benId)).toMatchObject({ name: 'Ben' });

  // Ben is told once, then has no table: his saved list keeps it as one he left, and every route refuses him as for a missing table.
  await expect.poll(() => bensConnection.messages.filter(message => message.type === 'table-membership-ended')).toEqual([{ type: 'table-membership-ended', tableSessionId: id }]);
  bensConnection.close();
  expect((await get('/api/table-sessions/' + id, ben)).status).toBe(404);
  expect((await (await get('/api/table-sessions', ben)).json()).tables).toMatchObject([{ tableSessionId: id, left: true }]);
  expect(await rejection(await as(ben, 'seat-participant', { participantId: benId, seat: 3, expectedPokerRevision: 0 }))).toEqual({ status: 404, code: 'not-found' });

  // Removal did not bar him: the Join Link shows him as returning, and joining again gives him his own Participant back.
  expect(await (await preview(ben)).json()).toMatchObject({ ok: true, returningAs: 'Ben', alreadyJoined: false, placesTaken: 2 });
  expect(await (await join(ben)).json()).toMatchObject({ ok: true, participantId: benId });
  expect((await get('/api/table-sessions/' + id, ben)).status).toBe(200);
  expect(participant(await view(ann), benId)).toMatchObject({ seat: null, stack: 0 });
  expect(annId).toBe(table.ownerParticipantId);
});

/**
 * An Online Table of Ann (the owner) and Ben, connected and seated heads-up. Automatic Dealing has dealt a Hand,
 * and its first Action Window is open.
 */
async function onlineHand() {
  const table = await onlineTable('Ben');
  const { ann, annId, id, as, view } = table;
  const { cookie: ben, participantId: benId } = table.guests.Ben!;
  await connectLive(base, ann, id); await connectLive(base, ben, id);
  expect((await as(ann, 'seat-participant', { participantId: annId, seat: 1 })).status).toBe(200);
  expect((await as(ben, 'seat-participant', { participantId: benId, seat: 2 })).status).toBe(200);
  clock.advanceTo((await announcedCountdown(() => view(ann))).endsAt);
  await expect.poll(async () => (await view(ann)).view.state.handId).toBe('hand-1');
  clock.advance(1500);
  return { ...table, ben, benId };
}

test('during a Hand, Removal is an After-Hand Request that outranks the Guest’s own, and applies once the payout phase ends, even across a restart', async () => {
  const { ann, annId, ben, benId, id, view, join, preview, as } = await onlineHand();
  // Ben asks to leave after the Hand; the owner's Removal replaces that, and nothing at the poker table changes yet.
  expect(await (await as(ben, 'leave-table', { participantId: benId })).json()).toMatchObject({ ok: true, afterHand: true });
  const views = { ann: await view(ann), ben: await view(ben) };
  const asked = await as(ann, 'remove-participant', { participantId: benId });
  expect(asked.status).toBe(200);
  expect(await asked.json()).toEqual({ ok: true, tableSessionId: id, pokerRevision: views.ann.pokerRevision, sessionRevision: views.ann.sessionRevision + 1, afterHand: true });
  for (const [name, cookie] of [['ann', ann], ['ben', ben]] as const) {
    const seen = await view(cookie);
    expect(seen.pendingChanges).toEqual([{ participantId: benId, change: 'remove' }]);
    expect(seen.view).toEqual(views[name].view);
  }
  expect(participant(await view(ann), benId)).toMatchObject({ seat: 2, inHand: true });
  // Nothing a Guest asks for undoes it, and asking for it again changes nothing.
  const waiting = await view(ann);
  for (const [cookie, kind, fields] of [[ben, 'leave-table', { participantId: benId }], [ben, 'stand-up-participant', { participantId: benId }], [ben, 'set-sitting-out', { participantId: benId, sittingOut: true }], [ann, 'remove-participant', { participantId: benId }]] as const) {
    expect(await (await as(cookie, kind, fields)).json()).toMatchObject({ ok: true, afterHand: true, sessionRevision: waiting.sessionRevision });
  }
  expect((await view(ann)).pendingChanges).toEqual([{ participantId: benId, change: 'remove' }]);
  // Ben is still at the table and plays the Hand he is in.
  const actor = waiting.view.state.actorId!;
  expect((await as(actor === annId ? ann : ben, 'act', { participantId: actor, action: { type: 'fold' } })).status).toBe(200);
  const decided = await view(ben);
  expect(decided.view.state.status).toBe('completed-hand');
  const stacks = decided.view.state.participants.map(p => p.stack);
  clock.advance(1999);
  expect((await get('/api/table-sessions/' + id, ben)).status).toBe(200);
  expect((await view(ann)).pendingChanges).toEqual([{ participantId: benId, change: 'remove' }]);

  // The server restarts before the payout phase ends. The request survives, and applies exactly once when it does.
  await server.close(); await startServer();
  const bensConnection = await listen(ben, id);
  expect((await view(ben)).pendingChanges).toEqual([{ participantId: benId, change: 'remove' }]);
  clock.advance(1);
  await expect.poll(async () => (await get('/api/table-sessions/' + id, ben)).status).toBe(404);
  const after = await view(ann);
  expect(after.pendingChanges).toEqual([]);
  expect(participant(after, benId)).toMatchObject({ seat: null, stack: 0 });
  // He cashed out the stack he finished with, so no chip is lost.
  expect(participant(after, annId).stack + participant(decided, benId).stack).toBe(stacks.reduce((sum, stack) => sum + stack, 0));
  expect(after.pokerRevision).toBe(decided.pokerRevision + 1);
  await expect.poll(() => bensConnection.messages.filter(message => message.type === 'table-membership-ended')).toEqual([{ type: 'table-membership-ended', tableSessionId: id }]);
  bensConnection.close();
  // His table stays in his saved list, as one he has left, and the Join Link takes him back as the same Participant.
  expect((await (await get('/api/table-sessions', ben)).json()).tables).toMatchObject([{ tableSessionId: id, left: true }]);
  expect(await (await join(ben)).json()).toMatchObject({ ok: true, participantId: benId });
  expect((await get('/api/table-sessions/' + id, ben)).status).toBe(200);
});

test('during a Hand, Removal of a Guest without a Seat also waits for the Hand', async () => {
  const { ann, annId, ben, id, view, join, as } = await onlineHand();
  const cy = await guest('Cy');
  const cyId = (await (await join(cy)).json()).participantId as string;
  const asked = await as(ann, 'remove-participant', { participantId: cyId });
  expect(await asked.json()).toMatchObject({ ok: true, afterHand: true });
  expect((await view(ann)).pendingChanges).toEqual([{ participantId: cyId, change: 'remove' }]);
  expect((await get('/api/table-sessions/' + id, cy)).status).toBe(200);
  const actor = (await view(ann)).view.state.actorId!;
  expect(await (await as(actor === annId ? ann : ben, 'act', { participantId: actor, action: { type: 'fold' } })).json()).toMatchObject({ ok: true });
  clock.advance(2000);
  await expect.poll(async () => (await get('/api/table-sessions/' + id, cy)).status).toBe(404);
  expect(await (await join(cy)).json()).toMatchObject({ ok: true, participantId: cyId });
});

test('only the owner can remove a human, the owner cannot be removed, and only a joined human can be', async () => {
  const bots = [{ name: 'Bot', playingStrategy: baselinePlayingStrategy }];
  const ann = await guest('Ann'), ben = await guest('Ben');
  const created = await (await post('/api/table-sessions', ann, { requestId: randomUUID(), mode: 'online', bots })).json();
  const id = created.tableSessionId as string, annId = created.bindings[0].participantId as string, botId = created.bindings[1].participantId as string;
  const view = async (cookie: string): Promise<ObservableTableSession> => (await get('/api/table-sessions/' + id, cookie)).json();
  const join = (cookie: string) => post('/api/table-sessions/' + id + '/join-table', cookie, { requestId: randomUUID() });
  const benId = (await (await join(ben)).json()).participantId as string;
  const as = async (cookie: string, fields: object) => post('/api/table-sessions/' + id + '/remove-participant', cookie, { requestId: randomUUID(), expectedPokerRevision: (await view(cookie)).pokerRevision, ...fields });
  const before = await view(ann);
  // A Guest cannot remove anyone: not the owner, and not themselves.
  expect(await rejection(await as(ben, { participantId: annId }))).toEqual({ status: 403, code: 'table-owner-required' });
  expect(await rejection(await as(ben, { participantId: benId }))).toEqual({ status: 403, code: 'table-owner-required' });
  // The owner cannot be removed, and Removal is for humans.
  expect(await rejection(await as(ann, { participantId: annId }))).toEqual({ status: 400, code: 'cannot-remove-owner' });
  expect(await rejection(await as(ann, { participantId: botId }))).toEqual({ status: 400, code: 'participant-not-human' });
  expect(await rejection(await as(ann, { participantId: randomUUID() }))).toEqual({ status: 400, code: 'participant-not-bound' });
  expect(await rejection(await as(ann, { participantId: benId, surplus: true }))).toEqual({ status: 400, code: 'invalid-mutation-request' });
  expect(await view(ann)).toEqual(before);
  // Once he is gone there is no one left to remove, and asking again is no different from asking about anyone who has left.
  expect((await as(ann, { participantId: benId })).status).toBe(200);
  expect(await rejection(await as(ann, { participantId: benId }))).toEqual({ status: 400, code: 'participant-not-joined' });
  // A Guest who left on their own has already gone: Removal is for the people who are at the table.
  const cy = await guest('Cy');
  const cyId = (await (await join(cy)).json()).participantId as string;
  expect((await post('/api/table-sessions/' + id + '/leave-table', cy, { requestId: randomUUID(), expectedPokerRevision: (await view(ann)).pokerRevision, participantId: cyId })).status).toBe(200);
  expect(await rejection(await as(ann, { participantId: cyId }))).toEqual({ status: 400, code: 'participant-not-joined' });
});
