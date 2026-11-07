// Records Demo Table fixtures from a running server: node scripts/capture-demo-fixtures.mjs [http://127.0.0.1:3190]
// The server must have online play on (POKER_ONLINE_PLAY=true). Each fixture is the participant-safe view a real
// Guest received, plus the analysis and summary resources for it, so the Demo Tables never hand-write contract data.
import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const base = process.argv[2] ?? 'http://127.0.0.1:3190';
const out = path.join(path.dirname(fileURLToPath(import.meta.url)), '../apps/web/src/demo/fixtures');
const strategy = {
  policy: { id: 'simple-heuristic', version: 'v1', configuration: {} },
  selector: { id: 'seeded-sampling', version: 'v1', configuration: {} },
};
const defaults = { seatCount: 6, smallBlind: 10, bigBlind: 20, ante: 0, minimumBuyIn: 1000, defaultBuyIn: 1000, maximumBuyIn: 1000, allowSeatChanges: true };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

class Guest {
  cookie = '';
  async req(method, route, body) {
    const response = await fetch(base + '/api' + route, {
      method, headers: { 'content-type': 'application/json', ...(this.cookie ? { cookie: this.cookie } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const set = response.headers.getSetCookie?.() ?? [];
    if (set.length) this.cookie = set.map(c => c.split(';')[0]).join('; ');
    return { status: response.status, data: await response.json() };
  }
  async start(name) {
    await this.req('GET', '/identity');
    const named = await this.req('PUT', '/display-name', { displayName: name });
    if (named.status !== 200) throw new Error('display name: ' + JSON.stringify(named.data));
    return this;
  }
  async read(id) { return (await this.req('GET', '/table-sessions/' + id)).data; }
  /** A mutation against the newest revision, retried while the table is still presenting or thinking. */
  async mutate(id, route, body, attempts = 40) {
    let last;
    for (let i = 0; i < attempts; i++) {
      const table = await this.read(id);
      last = await this.req('POST', `/table-sessions/${id}/${route}`, { requestId: randomUUID(), expectedPokerRevision: table.pokerRevision, ...body });
      if (last.data.ok) return last.data;
      if (last.status >= 500 || !['action-window-not-open', 'stale-revision', 'revision-conflict'].includes(last.data.rejection?.code)) break;
      await sleep(400);
    }
    throw new Error(`${route} refused: ${JSON.stringify(last?.data)}`);
  }
  async until(id, predicate, timeout = 60000) {
    const end = Date.now() + timeout;
    for (;;) {
      const table = await this.read(id);
      if (predicate(table)) return table;
      if (Date.now() > end) throw new Error('timed out waiting for table state');
      await sleep(400);
    }
  }
}

const yourTurn = t => t.view.state.status === 'active-hand' && t.view.state.actorId === t.viewerParticipantId && !!t.schedule.actionWindow;
const seatAll = async (g, id, ack) => {
  for (let seat = 1; seat <= ack.bindings.length; seat++) await g.mutate(id, 'seat-participant', { participantId: ack.bindings[seat - 1].participantId, seat, buyIn: defaults.defaultBuyIn });
};
async function practice(g, { seats = 6, limit } = {}) {
  const created = await g.req('POST', '/table-sessions', {
    requestId: randomUUID(), configuration: { ...defaults, seatCount: seats },
    bots: Array.from({ length: seats - 1 }, (_, i) => ({ name: `Bot ${i + 1}`, playingStrategy: strategy })),
    ...(limit ? { options: { actionTimeLimitSeconds: limit } } : {}),
  });
  if (!created.data.ok) throw new Error('create: ' + JSON.stringify(created.data));
  const id = created.data.tableSessionId;
  await seatAll(g, id, created.data);
  return id;
}
/** Plays the viewer's decisions without ever raising or folding until `done`, dealing new Hands as needed. */
async function playUntil(g, id, done, hands = 25) {
  let dealt = 0;
  for (;;) {
    const table = await g.until(id, t => done(t) || yourTurn(t) || t.view.state.status !== 'active-hand');
    if (done(table)) return table;
    const state = table.view.state;
    if (state.status !== 'active-hand') {
      if (dealt++ >= hands) throw new Error('no matching situation in ' + hands + ' hands');
      await g.mutate(id, 'start-hand', {});
    } else {
      const legal = state.legalActions.map(a => a.type);
      await g.mutate(id, 'act', { participantId: table.viewerParticipantId, action: { type: legal.includes('check') ? 'check' : 'call' } });
    }
  }
}
async function settled(g, id, read) {
  // Lets the server's presentation schedule finish so the fixture is a resting state, not a mid-deal one.
  await sleep(300);
  return read ? read(await g.read(id)) : g.read(id);
}
async function resolve(g, id, route, start) {
  let result = (await g.req('POST', `/table-sessions/${id}/${route}`, start)).data;
  for (let i = 0; i < 80 && result.status === 'pending'; i++) {
    await sleep(500);
    result = (await g.req('GET', `/table-sessions/${id}/${route === 'analysis' ? 'analysis' : 'summaries'}/${result.requestId}`)).data;
  }
  return result;
}
/** The analysis and summary resources the Trainer would request for this view. */
async function resources(g, id, table) {
  const viewer = table.viewerParticipantId, analyses = {}, handSummaries = {};
  const decisions = new Set();
  const current = table.view.history.find(h => h.handId === table.view.state.handId);
  for (const d of current?.decisions ?? []) if (d.action.participantId === viewer) decisions.add(d.decisionId);
  if (table.view.state.decisionId && table.view.state.actorId === viewer) decisions.add(table.view.state.decisionId);
  for (const decisionId of decisions) {
    const live = decisionId === table.view.state.decisionId && table.view.state.status === 'active-hand';
    const result = await resolve(g, id, 'analysis', { decisionId, ...(live ? { live: true } : {}) });
    if (result.status && result.status !== 'pending') analyses[decisionId] = result;
  }
  let sessionSummary;
  const handId = table.view.state.handId;
  if (handId && decisions.size) {
    const summary = await resolve(g, id, 'hand-summaries', { handId });
    if (summary.status && summary.status !== 'pending') handSummaries[handId] = summary;
  }
  if (table.view.history.length) {
    const summary = await resolve(g, id, 'session-summaries', {});
    if (summary.status && summary.status !== 'pending') sessionSummary = summary;
  }
  return { analyses, handSummaries, ...(sessionSummary ? { sessionSummary } : {}) };
}

const fixtures = [];
async function record(meta, g, id, tableOverride) {
  const session = tableOverride ?? await g.read(id);
  const found = await resources(g, id, session);
  const saved = (await g.req('GET', '/table-sessions')).data;
  const fixture = { ...meta, capturedAt: new Date().toISOString(), session, ...found, savedTables: saved.tables ?? [] };
  await mkdir(out, { recursive: true });
  await writeFile(path.join(out, meta.id + '.json'), JSON.stringify(fixture, null, 1) + '\n');
  fixtures.push({ id: meta.id, group: meta.group, label: meta.label, description: meta.description });
  console.log('captured', meta.id, `(${Object.keys(found.analyses).length} analyses)`);
}

const scenarios = [
  async () => {
    const g = await new Guest().start('You'), id = await practice(g);
    await record({ id: 'practice-before-deal', group: 'Practice', label: 'Before the first deal', description: 'Seated at a 6-max table, no Hand yet. Analysis is empty.' }, g, id);
  },
  async () => {
    const g = await new Guest().start('You'), id = await practice(g);
    await g.mutate(id, 'start-hand', {});
    const table = await g.until(id, t => yourTurn(t) && t.view.state.street === 'preflop');
    await record({ id: 'practice-preflop-your-turn', group: 'Practice', label: 'Preflop, your turn', description: 'Hole cards dealt, the action is on you, live analysis shown.' }, g, id, await settled(g, id));
    void table;
  },
  async () => {
    const g = await new Guest().start('You'), id = await practice(g);
    const facing = t => yourTurn(t) && t.view.state.street !== 'preflop' && t.view.state.legalActions.some(a => a.type === 'call') && (t.view.state.amountToCall ?? 0) > 0;
    try { await playUntil(g, id, facing); } catch { await playUntil(g, id, t => yourTurn(t) && t.view.state.street !== 'preflop'); }
    await record({ id: 'practice-postflop-facing-bet', group: 'Practice', label: 'Postflop, facing a bet', description: 'Board on the table and a bet to call, with the action on you.' }, g, id, await settled(g, id));
  },
  async () => {
    const g = await new Guest().start('You'), id = await practice(g);
    await playUntil(g, id, t => t.view.state.status === 'completed-hand' && t.view.state.board.length === 5 && (t.view.state.payouts?.length ?? 0) > 0);
    await record({ id: 'practice-showdown-result', group: 'Practice', label: 'Showdown result, analysis scored', description: 'A finished Hand with the result, scored decisions and summaries in the analysis panel.' }, g, id, await settled(g, id));
  },
  async () => {
    const g = await new Guest().start('You'), id = await practice(g, { limit: 30 });
    await g.mutate(id, 'start-hand', {});
    await g.until(id, t => yourTurn(t) && !!t.schedule.actionWindow?.deadlineAt);
    await record({ id: 'practice-timed-action', group: 'Practice', label: 'Timed decision (30s)', description: 'Action Time Limit countdown running on your decision. Use Restart to rerun it.' }, g, id, await settled(g, id));
  },
  async () => {
    const g = await new Guest().start('You'), id = await practice(g, { seats: 2 });
    await g.mutate(id, 'start-hand', {});
    await g.until(id, t => yourTurn(t));
    await record({ id: 'practice-heads-up', group: 'Practice', label: 'Heads-up', description: 'Two seats: the sparsest table layout.' }, g, id, await settled(g, id));
  },
  async () => {
    const g = await new Guest().start('You'), id = await practice(g, { seats: 9 });
    await g.mutate(id, 'start-hand', {});
    await g.until(id, t => yourTurn(t));
    await record({ id: 'practice-full-ring', group: 'Practice', label: 'Full ring (9 seats)', description: 'Nine seats: the densest table layout.' }, g, id, await settled(g, id));
  },
  async () => {
    const owner = await new Guest().start('Owner'), guest = await new Guest().start('Guest');
    const created = await owner.req('POST', '/table-sessions', { requestId: randomUUID(), mode: 'online', configuration: { ...defaults, seatCount: 6 }, options: { actionTimeLimitSeconds: 30 } });
    if (!created.data.ok) throw new Error('online create: ' + JSON.stringify(created.data));
    const id = created.data.tableSessionId;
    await owner.mutate(id, 'seat-participant', { participantId: created.data.bindings[0].participantId, seat: 1, buyIn: defaults.defaultBuyIn });
    for (const name of ['Ada', 'Grace']) await owner.mutate(id, 'add-bot', { name, playingStrategy: strategy });
    await record({ id: 'online-owner-lobby', group: 'Online', label: 'Owner, waiting for players', description: 'You own the table: open seats, bots added, a Join Link to share.' }, owner, id);
    const token = (await owner.read(id)).joinToken;
    const joined = await guest.req('POST', `/join-links/${token}/join`, { requestId: randomUUID() });
    if (!joined.data.ok) throw new Error('join: ' + JSON.stringify(joined.data));
    await record({ id: 'online-guest-watching', group: 'Online', label: 'Guest, watching without a seat', description: 'Joined through the link and not yet seated: the ways in are offered.' }, guest, id);
    try {
      await guest.mutate(id, 'seat-participant', { participantId: joined.data.participantId, seat: 4, buyIn: defaults.defaultBuyIn });
      await record({ id: 'online-guest-seated', group: 'Online', label: 'Guest, seated', description: 'A Guest who took a seat, waiting for the next Hand.' }, guest, id);
    } catch (error) { console.warn('skipped online-guest-seated:', error.message); }
  },
  async () => {
    const g = await new Guest().start('You');
    await practice(g); await practice(g, { seats: 2 });
    const id = await practice(g, { seats: 9 });
    await record({ id: 'home-saved-tables', group: 'Home', label: 'Tables home, saved tables', description: 'The Tables screen with several saved tables to pick up.', home: true }, g, id);
  },
];
for (const scenario of scenarios) await scenario();
await writeFile(path.join(out, 'index.json'), JSON.stringify(fixtures, null, 1) + '\n');
console.log('wrote', fixtures.length, 'fixtures to', out);
