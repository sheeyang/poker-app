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

/** An Online Table owned by Ann, with `names` joined through the link. Nobody is seated. */
async function onlineTable(...names: string[]) {
  const ann = await guest('Ann');
  const created = await (await post('/api/table-sessions', ann, { requestId: randomUUID(), mode: 'online' })).json();
  const id = created.tableSessionId as string, annId = created.bindings[0].participantId as string;
  const view = async (cookie: string): Promise<ObservableTableSession> => (await get('/api/table-sessions/' + id, cookie)).json();
  const token = async () => (await view(ann)).joinToken!;
  const join = (cookie: string, link?: Promise<string> | string) => (async () => post('/api/join-links/' + await (link ?? token()) + '/join', cookie, { requestId: randomUUID() }))();
  const as = async (cookie: string, kind: string, fields: object) => post('/api/table-sessions/' + id + '/' + kind, cookie, { requestId: randomUUID(), expectedPokerRevision: (await view(cookie)).pokerRevision, ...fields });
  const guests: Record<string, { cookie: string; participantId: string }> = {};
  for (const name of names) {
    const cookie = await guest(name);
    guests[name] = { cookie, participantId: (await (await join(cookie)).json()).participantId as string };
  }
  return { ann, annId, id, view, token, join, as, guests };
}

test('replacing the Join Link ends the old link at once, leaves joined Participants in place, and belongs to the owner alone', async () => {
  const { ann, id, view, token, join, guests } = await onlineTable('Ben');
  const ben = guests.Ben!.cookie, cy = await guest('Cy');
  const before = await token();
  const replace = (cookie: string, fields: object = {}, requestId = randomUUID()) => post('/api/table-sessions/' + id + '/replace-join-link', cookie, { requestId, expectedSessionRevision: 0, ...fields });
  const { sessionRevision, pokerRevision } = await view(ann);

  // Only the owner replaces the link; another Participant is told so and nothing changes.
  expect(await rejection(await replace(ben, { expectedSessionRevision: sessionRevision }))).toEqual({ status: 403, code: 'table-owner-required' });
  expect(await rejection(await replace(ann, { expectedSessionRevision: sessionRevision - 1 }))).toEqual({ status: 409, code: 'stale-session-revision' });
  expect(await token()).toBe(before);

  // The owner's live view carries the new link as soon as it exists.
  const live = new WebSocket(base.replace('http:', 'ws:') + '/api/live', { headers: { cookie: ann } });
  const messages: ServerLiveMessage[] = [];
  live.on('message', data => messages.push(JSON.parse(data.toString())));
  await expect.poll(() => messages.length).toBe(1);
  live.send(JSON.stringify({ type: 'subscribe-table', requestId: 'watch', tableSessionId: id }));

  const requestId = randomUUID();
  const replaced = await replace(ann, { expectedSessionRevision: sessionRevision }, requestId);
  expect(replaced.status).toBe(200);
  // An application change: only the session revision moves, and the acknowledgement carries no link.
  expect(await replaced.json()).toEqual({ ok: true, tableSessionId: id, pokerRevision, sessionRevision: sessionRevision + 1 });
  const after = await token();
  expect(after).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(after).not.toBe(before);
  await expect.poll(() => messages.some(message => message.type === 'table-update' && message.joinToken === after)).toBe(true);
  live.close();
  // The same request again answers the same and does not replace the link a second time.
  expect(await (await replace(ann, { expectedSessionRevision: sessionRevision }, requestId)).json()).toMatchObject({ ok: true, sessionRevision: sessionRevision + 1 });
  expect(await token()).toBe(after);

  // The old link no longer opens anything, for a newcomer or for a Guest who already joined through it.
  for (const cookie of [cy, ben]) {
    expect(await rejection(await get('/api/join-links/' + before, cookie))).toEqual({ status: 404, code: 'invalid-join-link' });
    expect(await rejection(await post('/api/join-links/' + before + '/join', cookie, { requestId: randomUUID() }))).toEqual({ status: 404, code: 'invalid-join-link' });
  }
  expect(await (await join(cy, before)).json()).toMatchObject({ ok: false, rejection: { code: 'invalid-join-link' } });
  // Joined Participants are unaffected: they keep their place and the table stays in their saved list.
  expect((await get('/api/table-sessions/' + id, ben)).status).toBe(200);
  expect(await (await get('/api/table-sessions', ben)).json()).toMatchObject({ tables: [{ tableSessionId: id, mode: 'online' }] });
  // The new link works, and only the owner reads it.
  expect(await (await get('/api/join-links/' + after, cy)).json()).toMatchObject({ ok: true, placesTaken: 2 });
  expect(await (await join(cy, after)).json()).toMatchObject({ ok: true });
  expect(await view(ben)).not.toHaveProperty('joinToken');
});

test('a Practice Table has no Join Link to replace', async () => {
  const ann = await guest('Ann');
  const created = await (await post('/api/table-sessions', ann, { requestId: randomUUID() })).json();
  const refused = await post('/api/table-sessions/' + created.tableSessionId + '/replace-join-link', ann, { requestId: randomUUID(), expectedSessionRevision: 0 });
  expect(await rejection(refused)).toEqual({ status: 400, code: 'join-link-unavailable' });
});

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

test('between Hands, Removal stands the Guest up at once and ends their membership, and no Join Link lets them back', async () => {
  const { ann, annId, id, view, token, join, as, guests } = await onlineTable('Ben', 'Cy');
  const { cookie: ben, participantId: benId } = guests.Ben!, cy = guests.Cy!;
  expect((await as(ben, 'seat-participant', { participantId: benId, seat: 1 })).status).toBe(200);
  expect((await as(cy.cookie, 'seat-participant', { participantId: cy.participantId, seat: 2 })).status).toBe(200);
  expect(participant(await view(ann), benId)).toMatchObject({ seat: 1, stack: 1000 });
  const bensConnection = await listen(ben, id);
  const link = await token();

  const removed = await as(ann, 'remove-participant', { participantId: benId });
  expect(removed.status).toBe(200);
  // Nothing is pending: it applied at once, as one poker step (Stand Up and Leave Table are one commit).
  expect(await removed.json()).toMatchObject({ ok: true, tableSessionId: id });
  const table = await view(ann);
  expect(table.pendingChanges).toEqual([]);
  expect(participant(table, benId)).toMatchObject({ seat: null, stack: 0 });
  expect(table.bindings.find(binding => binding.participantId === benId)).toMatchObject({ name: 'Ben' });

  // Ben is told once, then has no table: it leaves his saved list and every route refuses him as for a missing table.
  await expect.poll(() => bensConnection.messages.filter(message => message.type === 'table-membership-ended')).toEqual([{ type: 'table-membership-ended', tableSessionId: id, reason: 'removed' }]);
  bensConnection.close();
  expect((await get('/api/table-sessions/' + id, ben)).status).toBe(404);
  expect(await (await get('/api/table-sessions', ben)).json()).toEqual({ tables: [] });
  expect(await rejection(await as(ben, 'seat-participant', { participantId: benId, seat: 3, expectedPokerRevision: 0 }))).toEqual({ status: 404, code: 'not-found' });

  // The removal belongs to the Guest, not to a link: neither this link, a replacement, nor the owner's own way back admits him.
  expect(await rejection(await join(ben, link))).toEqual({ status: 403, code: 'guest-removed' });
  expect(await rejection(await get('/api/join-links/' + link, ben))).toEqual({ status: 403, code: 'guest-removed' });
  expect((await post('/api/table-sessions/' + id + '/replace-join-link', ann, { requestId: randomUUID(), expectedSessionRevision: table.sessionRevision })).status).toBe(200);
  const replacement = await token();
  expect(replacement).not.toBe(link);
  expect(await rejection(await join(ben, replacement))).toEqual({ status: 403, code: 'guest-removed' });
  expect(await rejection(await get('/api/join-links/' + replacement, ben))).toEqual({ status: 403, code: 'guest-removed' });
  expect((await post('/api/table-sessions/' + id + '/rejoin-table', ben, { requestId: randomUUID() })).status).toBe(404);
  // Still not joined after all of that, and the place he held is free for someone else.
  expect((await get('/api/table-sessions/' + id, ben)).status).toBe(404);
  expect(await (await get('/api/join-links/' + replacement, await guest('Dee'))).json()).toMatchObject({ ok: true, placesTaken: 2 });
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
  const { ann, annId, ben, benId, id, view, token, join, as } = await onlineHand();
  const link = await token();
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
  await expect.poll(() => bensConnection.messages.filter(message => message.type === 'table-membership-ended')).toEqual([{ type: 'table-membership-ended', tableSessionId: id, reason: 'removed' }]);
  bensConnection.close();
  expect(await (await get('/api/table-sessions', ben)).json()).toEqual({ tables: [] });
  // He is removed, not merely gone: his earlier request to leave did not become a way back.
  expect(await rejection(await join(ben, link))).toEqual({ status: 403, code: 'guest-removed' });
  expect(await rejection(await get('/api/join-links/' + link, ben))).toEqual({ status: 403, code: 'guest-removed' });
});

test('during a Hand, Removal of a Guest without a Seat also waits for the Hand', async () => {
  const { ann, annId, ben, id, view, join, as, token } = await onlineHand();
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
  expect(await rejection(await join(cy, await token()))).toEqual({ status: 403, code: 'guest-removed' });
});

test('only the owner can remove a human, the owner cannot be removed, and only a joined human can be', async () => {
  const bots = [{ name: 'Bot', playingStrategy: baselinePlayingStrategy }];
  const ann = await guest('Ann'), ben = await guest('Ben');
  const created = await (await post('/api/table-sessions', ann, { requestId: randomUUID(), mode: 'online', bots })).json();
  const id = created.tableSessionId as string, annId = created.bindings[0].participantId as string, botId = created.bindings[1].participantId as string;
  const view = async (cookie: string): Promise<ObservableTableSession> => (await get('/api/table-sessions/' + id, cookie)).json();
  const benId = (await (await post('/api/join-links/' + (await view(ann)).joinToken + '/join', ben, { requestId: randomUUID() })).json()).participantId as string;
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
  const cyId = (await (await post('/api/join-links/' + (await view(ann)).joinToken + '/join', cy, { requestId: randomUUID() })).json()).participantId as string;
  expect((await post('/api/table-sessions/' + id + '/leave-table', cy, { requestId: randomUUID(), expectedPokerRevision: (await view(ann)).pokerRevision, participantId: cyId })).status).toBe(200);
  expect(await rejection(await as(ann, { participantId: cyId }))).toEqual({ status: 400, code: 'participant-not-joined' });
});
