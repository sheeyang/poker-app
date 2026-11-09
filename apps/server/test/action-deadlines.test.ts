import { afterAll, beforeAll, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { baselinePlayingStrategy, type ActionTimeLimitSeconds, type ConcreteAction, type DecisionAnalysis, type ObservableTableSession, type ScoreSummary, type StrategyDescriptor } from '@poker/contracts';
import { createStrategy, type Strategy } from '@poker/strategies';
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
/** Every Reference Strategy evaluation, by decision and the Participants it saw: analysis nobody requested shows here. */
const evaluations: { decisionId: string; participantIds: string[] }[] = [];
function observed(descriptor: StrategyDescriptor): Strategy {
  const strategy = createStrategy(descriptor);
  return { actionSelector: strategy.actionSelector, policy: {
    checkCompatibility: view => strategy.policy.checkCompatibility(view),
    evaluate: (view, options) => { evaluations.push({ decisionId: view.state.decisionId!, participantIds: view.state.participants.map(p => p.participantId) }); return strategy.policy.evaluate(view, options); },
  } };
}
type Context = { tableSessionId?: string; requestId: string };
let beforeCommit: (context: Context) => Promise<void> = async () => {};
let terminalCommit: (client: { query(sql: string): Promise<unknown> }, context: Context) => Promise<void> = async client => { await client.query('COMMIT'); };
async function startServer() {
  server = await createServer({ clock, automaticBots: false, databaseUrl: databaseUrl!, schema, strategyFactory: observed, onControllerCommandsReady: commands => { controllers = commands; },
    mutationTransactionFaults: { beforeCommit: context => beforeCommit(context), terminalCommit: (client, context) => terminalCommit(client, context) } });
  base = await server.listen({ host: '127.0.0.1', port: 0 });
}
beforeAll(async () => { await administration.query('CREATE SCHEMA "' + schema + '"'); await startServer(); });
afterAll(async () => { await server?.close(); await administration.query('DROP SCHEMA "' + schema + '" CASCADE'); await administration.end(); });

type Table = { id: string; cookie: string; ids: string[]; revision: number };
async function table(actionTimeLimitSeconds: ActionTimeLimitSeconds | null): Promise<Table> {
  const cookie = (await fetch(base + '/api/identity')).headers.get('set-cookie')!.split(';')[0]!; await nameGuest(base, cookie);
  const response = await fetch(base + '/api/table-sessions', { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ requestId: randomUUID(), options: { actionTimeLimitSeconds }, bots: [{ name: 'Bot', playingStrategy: baselinePlayingStrategy }] }) });
  expect(response.status).toBe(201); const created = await response.json();
  return { id: created.tableSessionId, cookie, ids: created.bindings.map((b: { participantId: string }) => b.participantId), revision: 0 };
}
const post = (t: Table, path: string, body: object) => fetch(base + '/api/table-sessions/' + t.id + '/' + path, { method: 'POST', headers: { 'content-type': 'application/json', cookie: t.cookie }, body: JSON.stringify(body) });
const get = async <T>(t: Table, path: string): Promise<T> => (await fetch(base + '/api/table-sessions/' + t.id + '/' + path, { headers: { cookie: t.cookie } })).json();
const submit = (t: Table, kind: string, fields: object, requestId: string = randomUUID()) => fetch(base + '/api/table-sessions/' + t.id + '/' + kind, { method: 'POST', headers: { 'content-type': 'application/json', cookie: t.cookie }, body: JSON.stringify({ requestId, expectedPokerRevision: t.revision, ...fields }) });
const read = async (t: Table): Promise<ObservableTableSession> => (await (await fetch(base + '/api/table-sessions/' + t.id, { headers: { cookie: t.cookie } })).json());
async function command(t: Table, kind: string, fields: object = {}) {
  const response = await submit(t, kind, fields); expect(response.status).toBe(200);
  const result = await response.json(); t.revision = result.pokerRevision; return result;
}
/** The human acts through HTTP; the Bot through the trusted controller commands. */
async function act(t: Table, participantId: string, action: ConcreteAction) {
  if (participantId === t.ids[0]) return submit(t, 'act', { participantId, action });
  const outcome = await controllers.submitAction(t.id, { requestId: randomUUID(), expectedPokerRevision: t.revision, participantId, action });
  return Response.json(outcome, { status: outcome.ok ? 200 : 409 });
}
async function accepted(t: Table, participantId: string, action: ConcreteAction) {
  const response = await act(t, participantId, action); expect(response.status).toBe(200);
  t.revision = (await response.json()).pokerRevision;
}
/** A heads-up Practice Table: the human holds seat 1, so they act first preflop. */
async function headsUp(limit: ActionTimeLimitSeconds | null) {
  const t = await table(limit); const [human, bot] = t.ids as [string, string];
  await command(t, 'seat-participant', { participantId: human, seat: 1 }); await command(t, 'seat-participant', { participantId: bot, seat: 4 });
  return { t, human, bot };
}

test('under an Action Time Limit each human Action Window carries an exact Action Deadline, and Bot windows have none', async () => {
  const { t, human, bot } = await headsUp(30);
  const dealt = clock.now();
  await command(t, 'start-hand');
  expect((await read(t)).schedule.actionWindow).toEqual({ participantId: human, decisionId: 'hand-1/decision-1', opensAt: dealt + 1500, deadlineAt: dealt + 1500 + 30_000 });
  clock.advance(1500);
  await accepted(t, human, { type: 'call' });
  expect((await read(t)).schedule.actionWindow).toEqual({ participantId: bot, decisionId: 'hand-1/decision-2', opensAt: dealt + 1500 });

  const untimed = await headsUp(null);
  await command(untimed.t, 'start-hand');
  expect((await read(untimed.t)).schedule.actionWindow).toEqual({ participantId: untimed.human, decisionId: 'hand-1/decision-1', opensAt: clock.now() + 1500 });
});

test('a Practice Table offers an Action Time Limit of 15, 30 or 60 seconds, or none', async () => {
  for (const limit of [15, 60] as const) expect((await read(await table(limit))).options).toEqual({ actionTimeLimitSeconds: limit, allowLiveAnalysis: true });
  const cookie = (await fetch(base + '/api/identity')).headers.get('set-cookie')!.split(';')[0]!; await nameGuest(base, cookie);
  const rejected = await fetch(base + '/api/table-sessions', { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ requestId: randomUUID(), options: { actionTimeLimitSeconds: 45 } }) });
  expect(rejected.status).toBe(400);
  expect(await rejected.json()).toMatchObject({ ok: false, rejection: { code: 'invalid-creation-settings', field: 'actionTimeLimitSeconds' } });
});

test('after the Action Deadline the server plays the Timeout Action, Fold when Check is not legal, and rejects the late action with its own code', async () => {
  const { t, human } = await headsUp(15);
  await command(t, 'start-hand');
  const before = await read(t);
  clock.advanceTo(before.schedule.actionWindow!.deadlineAt! + 1);
  const late = await submit(t, 'act', { participantId: human, action: { type: 'call' } });
  expect(late.status).toBe(409);
  expect(await late.json()).toMatchObject({ ok: false, rejection: { code: 'action-deadline-passed' } });
  const after = await read(t);
  expect(after.pokerRevision).toBe(before.pokerRevision + 1);
  expect(after.view.state).toMatchObject({ status: 'completed-hand', handId: 'hand-1' });
  expect(after.view.history[0]!.decisions.map(decision => decision.action)).toEqual([{ participantId: human, action: { type: 'fold' } }]);
});

test('an action the server receives at its Action Deadline is accepted and never displaced, and a Bot never times out', async () => {
  const { t, human, bot } = await headsUp(15);
  await command(t, 'start-hand');
  clock.advanceTo((await read(t)).schedule.actionWindow!.deadlineAt!);
  await accepted(t, human, { type: 'call' });
  clock.advance(10 * 60_000);
  const view = await read(t);
  expect(view.view.state).toMatchObject({ status: 'active-hand', actorId: bot });
  expect(view.view.history[0]!.decisions.map(decision => decision.action)).toEqual([{ participantId: human, action: { type: 'call' } }]);
});

test('every later decision the human misses in the Hand times out too, Check when legal; the human is not sat out and the table waits for Deal', async () => {
  const { t, human, bot } = await headsUp(15);
  await command(t, 'start-hand'); clock.advance(1500);
  await accepted(t, human, { type: 'call' });
  await accepted(t, bot, { type: 'check' });
  // On each street the Bot checks first, then the human lets the deadline pass.
  for (const street of ['flop', 'turn', 'river']) {
    clock.advance(1000);
    await accepted(t, bot, { type: 'check' });
    const waiting = await read(t);
    expect(waiting.view.state).toMatchObject({ street, actorId: human });
    expect(waiting.schedule.actionWindow).toMatchObject({ participantId: human, deadlineAt: waiting.schedule.actionWindow!.opensAt + 15_000 });
    clock.advanceTo(waiting.schedule.actionWindow!.deadlineAt! + 1);
    await expect.poll(async () => (t.revision = (await read(t)).pokerRevision)).toBe(waiting.pokerRevision + 1);
  }
  const done = await read(t);
  expect(done.view.state).toMatchObject({ status: 'completed-hand', handId: 'hand-1' });
  expect(done.view.history[0]!.decisions.filter(decision => decision.action.participantId === human).map(decision => decision.action.action)).toEqual([{ type: 'call' }, { type: 'check' }, { type: 'check' }, { type: 'check' }]);
  expect(done.view.state.participants.find(p => p.participantId === human)).toMatchObject({ sittingOut: false });
  // Nothing deals the next Hand until the human does.
  clock.advance(10 * 60_000);
  expect(await read(t)).toMatchObject({ pokerRevision: done.pokerRevision, view: { state: { status: 'completed-hand', handId: 'hand-1' } } });
  await command(t, 'start-hand');
  expect((await read(t)).view.state.participants.find(p => p.participantId === human)).toMatchObject({ inHand: true, sittingOut: false });
});

test('an Action Deadline that expired during an outage resolves after restart as exactly one Timeout Action, before any further action', async () => {
  const { t, human, bot } = await headsUp(15);
  await command(t, 'start-hand'); clock.advance(1500);
  await accepted(t, human, { type: 'call' });
  await accepted(t, bot, { type: 'check' });
  clock.advance(1000);
  await accepted(t, bot, { type: 'check' });
  const waiting = await read(t);
  expect(waiting.view.state).toMatchObject({ street: 'flop', actorId: human });
  await server.close();
  clock.advanceTo(waiting.schedule.actionWindow!.deadlineAt! + 60_000);
  await startServer();
  // The restarted server has already settled the expired deadline when it serves its first request.
  const resumed = await read(t);
  expect(resumed.pokerRevision).toBe(waiting.pokerRevision + 1);
  expect(resumed.view.history[0]!.decisions.at(-1)!.action).toEqual({ participantId: human, action: { type: 'check' } });
  const late = await submit(t, 'act', { participantId: human, action: { type: 'bet', betTo: 40 } });
  expect(late.status).toBe(409);
  expect(await late.json()).toMatchObject({ ok: false, rejection: { code: 'action-deadline-passed' } });
  // Neither another restart nor later wake-ups repeat it.
  await server.close(); await startServer();
  clock.advance(60_000);
  expect((await read(t)).pokerRevision).toBe(resumed.pokerRevision);
  const acts = (await controllers.readPersistedSession(t.id))!.pokerRecord.commands.filter(c => c.type === 'act');
  expect(acts.map(c => c.type === 'act' && [c.participantId === human ? 'human' : 'bot', c.action.type])).toEqual([['human', 'call'], ['bot', 'check'], ['bot', 'check'], ['human', 'check']]);
});

const humanActs = async (t: Table, human: string) => (await controllers.readPersistedSession(t.id))!.pokerRecord.commands.filter(c => c.type === 'act' && c.participantId === human);

test('a Timeout Action that could not be saved is tried again shortly, and plays once', async () => {
  const { t, human } = await headsUp(15);
  await command(t, 'start-hand');
  const waiting = await read(t);
  let failures = 0;
  beforeCommit = async ({ tableSessionId, requestId }) => { if (tableSessionId === t.id && requestId.startsWith('timeout:') && failures++ === 0) throw new Error('controlled Timeout Action rollback'); };
  try {
    clock.advanceTo(waiting.schedule.actionWindow!.deadlineAt! + 1);
    await expect.poll(() => failures).toBe(1);
    expect((await read(t)).pokerRevision).toBe(waiting.pokerRevision);
    // While the Timeout Action is still due, a late action is refused just the same.
    expect(await (await submit(t, 'act', { participantId: human, action: { type: 'call' } })).json()).toMatchObject({ ok: false, rejection: { code: 'action-deadline-passed' } });
    await expect.poll(async () => { clock.advance(250); return (await read(t)).pokerRevision; }).toBe(waiting.pokerRevision + 1);
    expect(failures).toBe(2);
    expect(await humanActs(t, human)).toHaveLength(1);
  } finally { beforeCommit = async () => {}; }
});

test('a Timeout Action whose COMMIT proves never to have applied is played once under a fresh derived request ID', async () => {
  const { t, human } = await headsUp(15);
  await command(t, 'start-hand');
  const waiting = await read(t);
  let aborted = 0;
  terminalCommit = async (client, { tableSessionId, requestId }) => {
    if (tableSessionId !== t.id || !requestId.startsWith('timeout:') || aborted++ > 0) { await client.query('COMMIT'); return; }
    await client.query('ROLLBACK');
    throw new Error('Controlled missing COMMIT acknowledgement for a transaction that aborted.');
  };
  try {
    clock.advanceTo(waiting.schedule.actionWindow!.deadlineAt! + 1);
    // Recovery proves the first attempt aborted, and the table resumes with the Timeout Action still due.
    await expect.poll(async () => (await read(t)).pokerRevision, { timeout: 5000 }).toBe(waiting.pokerRevision + 1);
    expect((await read(t)).view.history[0]!.decisions.map(decision => decision.action)).toEqual([{ participantId: human, action: { type: 'fold' } }]);
    expect(await humanActs(t, human)).toHaveLength(1);
  } finally { terminalCommit = async client => { await client.query('COMMIT'); }; }
});

test('a Timeout Action is scored as the human’s own decision: automatic analysis, its scores, and the Hand and Session summaries', async () => {
  const { t, human } = await headsUp(15);
  await command(t, 'start-hand');
  const { decisionId, deadlineAt } = (await read(t)).schedule.actionWindow!;
  clock.advanceTo(deadlineAt! + 1);
  // Post-action analysis starts by itself, as for an action the human chose.
  await expect.poll(() => evaluations.some(e => e.decisionId === decisionId && e.participantIds.includes(human))).toBe(true);
  const analysis = await (await post(t, 'analysis', { decisionId })).json() as DecisionAnalysis;
  expect(analysis).toMatchObject({ participantId: human, decisionId, scoredDecision: { acceptedAction: { type: 'fold' } } });
  await expect.poll(async () => (await get<DecisionAnalysis>(t, 'analysis/' + analysis.requestId)).status).toBe('complete');
  expect(await get<DecisionAnalysis>(t, 'analysis/' + analysis.requestId)).toMatchObject({ scores: { decisionScore: expect.any(Number), actionRankScore: expect.any(Number) } });
  for (const [path, body] of [['hand-summaries', { handId: 'hand-1' }], ['session-summaries', {}]] as const) {
    const summary = await (await post(t, path, body)).json() as ScoreSummary;
    expect(summary).toMatchObject({ decisionIds: [decisionId], decisionCount: 1 });
    await expect.poll(async () => (await get<ScoreSummary>(t, 'summaries/' + summary.requestId)).status).toBe('complete');
  }
});

test('Practice Tables are never left: Leave Table is refused to the human, who can still stand up and sit out', async () => {
  const { t, human } = await headsUp(null);
  const left = await submit(t, 'leave-table', { participantId: human });
  expect(left.status).toBe(403);
  expect(await left.json()).toMatchObject({ ok: false, rejection: { code: 'unavailable-at-practice-tables' } });
  await command(t, 'set-sitting-out', { participantId: human, sittingOut: true });
  await command(t, 'set-sitting-out', { participantId: human, sittingOut: false });
  await command(t, 'stand-up-participant', { participantId: human });
  // Still refused when unseated, and the table remains the human's.
  expect((await submit(t, 'leave-table', { participantId: human })).status).toBe(403);
  expect((await read(t)).viewerParticipantId).toBe(human);
});

test('an untimed Practice Hand left unattended waits for the human, and no later Hand is dealt without Deal', async () => {
  const { t, human } = await headsUp(null);
  await command(t, 'start-hand');
  const waiting = await read(t);
  clock.advance(24 * 60 * 60_000);
  expect(await read(t)).toMatchObject({ pokerRevision: waiting.pokerRevision, view: { state: { status: 'active-hand', actorId: human } } });
  await server.close(); await startServer();
  clock.advance(60 * 60_000);
  expect(await read(t)).toMatchObject({ pokerRevision: waiting.pokerRevision, view: { state: { status: 'active-hand', actorId: human } } });
});

test('a timed Practice Hand with nobody connected finishes by Timeout Actions, and nothing more is dealt', async () => {
  const { t, human } = await headsUp(15);
  await command(t, 'start-hand'); clock.advance(1500);
  const dealt = await read(t);
  // Nobody is connected: only time passes, and the server plays each missed decision for the human.
  for (let step = 0; step < 12 && (await read(t)).view.state.status === 'active-hand'; step++) {
    const current = await read(t);
    if (current.view.state.actorId === human) clock.advanceTo(current.schedule.actionWindow!.deadlineAt! + 1);
    else await accepted(t, current.view.state.actorId!, { type: 'check' });
    await expect.poll(async () => (await read(t)).pokerRevision).toBeGreaterThan(current.pokerRevision);
  }
  const done = await read(t);
  expect(done.view.state).toMatchObject({ status: 'completed-hand', handId: 'hand-1' });
  expect(done.view.history.length).toBe(dealt.view.history.length + 1);
  clock.advance(60 * 60_000);
  expect(await read(t)).toMatchObject({ pokerRevision: done.pokerRevision, view: { state: { status: 'completed-hand', handId: 'hand-1' } } });
});
