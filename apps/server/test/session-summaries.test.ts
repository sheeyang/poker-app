import { afterAll, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import WebSocket from 'ws';
import { baselinePlayingStrategy, highestProbabilityPlayingStrategy, type ObservableGameView, type ObservableTableSession, type StrategyDescriptor, type ServerLiveMessage } from '@poker/contracts';
import { HighestProbabilitySelector, type PolicyResult } from '@poker/strategies';
import { createServer, type ServerOptions } from '../src/server.js';

const databaseUrl = process.env.TEST_DATABASE_URL!;
const administration = new Pool({ connectionString: databaseUrl });
afterAll(() => administration.end());
interface Evaluation { readonly view: ObservableGameView; readonly seed: string; readonly signal?: AbortSignal; readonly result: ReturnType<typeof Promise.withResolvers<PolicyResult>> }
async function fixture(options: Partial<ServerOptions> = {}) {
  const schema = 'test_' + randomUUID().replaceAll('-', '');
  await administration.query('CREATE SCHEMA "' + schema + '"');
  const evaluations: Evaluation[] = [];
  const held = new Set<Evaluation>();
  const sockets: WebSocket[] = [];
  let server: Awaited<ReturnType<typeof createServer>>;
  let base: string;
  async function start() {
    server = await createServer({ databaseUrl, schema, automaticBots: false, supportsStrategy: value => !!value && typeof value === 'object' && ['fixture', 'uniform-choice'].includes((value as StrategyDescriptor).policy?.id), strategyFactory: descriptor => ({
      policy: { checkCompatibility: () => ({ compatible: true }), evaluate: (view, execution) => { if (descriptor.policy.id === 'uniform-choice') { const action = view.state.legalActions.find(action => action.type === 'call' || action.type === 'check') ?? view.state.legalActions[0]!; return { choices: [{ action: action.type === 'bet' ? { type: 'bet', betTo: action.minimum } : action.type === 'raise' ? { type: 'raise', raiseTo: action.minimum } : { type: action.type }, probability: 1 }] }; } const result = Promise.withResolvers<PolicyResult>(); const evaluation = { view, seed: execution.evaluationSeed, signal: execution.signal, result }; evaluations.push(evaluation); held.add(evaluation); void result.promise.then(() => held.delete(evaluation), () => held.delete(evaluation)); return result.promise; } }, actionSelector: new HighestProbabilitySelector(),
    }), ...options });
    base = await server.listen({ host: '127.0.0.1', port: 0 });
  }
  await start();
  async function table(botCount = 1) {
    const identity = await fetch(base + '/api/identity'); const cookie = identity.headers.get('set-cookie')!.split(';')[0]!;
    const response = await fetch(base + '/api/table-sessions', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ requestId: randomUUID(), configuration: { maximumBuyIn: 2000 }, bots: Array.from({length: botCount}, (_,index) => ({ name: 'Bot ' + (index + 1), playingStrategy: baselinePlayingStrategy })) }) });
    expect(response.status).toBe(201); const created = await response.json();
    return { id: created.tableSessionId as string, cookie, human: created.bindings[0].participantId as string, bot: created.bindings[1].participantId as string, bots: created.bindings.slice(1).map((binding: {participantId: string}) => binding.participantId) as string[] };
  }
  type Table = Awaited<ReturnType<typeof table>>;
  const read = async (t: Table): Promise<ObservableTableSession> => (await fetch(base + '/api/table-sessions/' + t.id, { headers: { cookie: t.cookie } })).json();
  const post = (t: Table, path: string, body: unknown, cookie = t.cookie) => fetch(base + '/api/table-sessions/' + t.id + '/' + path, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  async function command(t: Table, kind: string, body: object = {}) { const before = await read(t); const response = await post(t, kind, { requestId: randomUUID(), expectedPokerRevision: before.pokerRevision, ...body }); expect(response.status).toBe(200); }
  async function decision() { const t = await table(); await command(t, 'seat-participant', { participantId: t.human, seat: 1 }); await command(t, 'seat-participant', { participantId: t.bot, seat: 2 }); await command(t, 'start-hand'); return t; }
  async function configure(t: Table, referenceStrategy: StrategyDescriptor) { const before = await read(t); expect((await post(t, 'set-trainer-configuration', { requestId: randomUUID(), expectedSessionRevision: before.sessionRevision, trainerConfiguration: { referenceStrategy, liveAnalysis: false } })).status).toBe(200); }
  const request = (t: Table, decisionId = 'hand-1/decision-1') => post(t, 'analysis', { decisionId });
  const result = async (t: Table, requestId: string, cookie = t.cookie) => fetch(base + '/api/table-sessions/' + t.id + '/analysis/' + requestId, { headers: { cookie } });
  function connect(t: Table) { const socket = new WebSocket(base.replace('http:', 'ws:') + '/api/live', { headers: { cookie: t.cookie } }); sockets.push(socket); const messages: ServerLiveMessage[] = []; socket.on('error', () => {}); socket.on('message', data => messages.push(JSON.parse(data.toString()))); return { socket, messages }; }
  async function stop() { for (const socket of sockets) socket.terminate(); const closing = server.close(); await expect.poll(() => [...held].every(evaluation => evaluation.signal?.aborted)).toBe(true); for (const evaluation of held) evaluation.result.resolve({ choices: [{ action: { type: 'fold' }, probability: 1 }] }); await closing; }
  return { table, decision, read, post, command, configure, request, result, summary: (t: Table, requestId: string, cookie = t.cookie) => fetch(base + '/api/table-sessions/' + t.id + '/summaries/' + requestId, { headers: { cookie } }), connect, evaluations, schema, async restart() { await stop(); evaluations.length = 0; await start(); }, async close() { await stop(); await administration.query('DROP SCHEMA "' + schema + '" CASCADE'); } };
}


test('a fresh or Bot-only Table Session has an authorized empty frozen summary without numerical output or analysis jobs', async () => {
  const f=await fixture({automaticBots:true});
  try {
    const t=await f.table(2), other=await f.table();
    const before=await f.read(t);
    const response=await f.post(t,'session-summaries',{});
    expect(response.status).toBe(200);
    const empty=await response.json();
    expect(empty).toMatchObject({ok:true,tableSessionId:t.id,scope:'table-session',status:'empty',decisionIds:[],decisionCount:0,capturedPokerRevision:0,referenceStrategy:baselinePlayingStrategy});
    expect(empty).not.toHaveProperty('handId'); expect(empty).not.toHaveProperty('averages');
    expect(await f.read(t)).toEqual(before); expect(f.evaluations).toHaveLength(0);
    expect((await f.post(t,'session-summaries',{},other.cookie)).status).toBe(404);
    expect((await f.post(t,'session-summaries',{},'')).status).toBe(401);
    expect((await f.post(t,'session-summaries',{handId:'hand-1'})).status).toBe(400);
    await f.command(t,'seat-participant',{participantId:t.bots[0],seat:1}); await f.command(t,'seat-participant',{participantId:t.bots[1],seat:2}); await f.command(t,'start-hand');
    await expect.poll(async()=>(await f.read(t)).view.state.status).toBe('completed-hand');
    const current=await f.read(t), botOnly=await(await f.post(t,'session-summaries',{})).json();
    expect(botOnly).toMatchObject({scope:'table-session',status:'empty',decisionCount:0,capturedPokerRevision:current.pokerRevision});
    expect(botOnly).not.toHaveProperty('averages');expect(f.evaluations).toHaveLength(0);
  }finally{await f.close();}
});

const reference: StrategyDescriptor={policy:{id:'fixture',version:'v1',configuration:{}},selector:highestProbabilityPlayingStrategy.selector};
function independentPolicy(view: ObservableGameView): PolicyResult {
  if(view.state.handId==='hand-1'||view.state.street==='preflop')return {choices:[{action:{type:'fold'},probability:1}]};
  if(view.state.street==='flop')return {choices:[{action:{type:'fold'},probability:.6},{action:{type:'check'},probability:.3},{action:{type:'bet',betTo:20},probability:.1}]};
  return {choices:[{action:{type:'check'},probability:1}]};
}
async function twoHands(f: Awaited<ReturnType<typeof fixture>>) {
  const t=await f.decision();
  const human=()=>expect.poll(async()=>(await f.read(t)).view.state.actorId).toBe(t.human);
  await f.command(t,'act',{participantId:t.human,action:{type:'fold'}});
  await f.command(t,'start-hand');await human();
  await f.command(t,'act',{participantId:t.human,action:{type:'check'}});await human();
  expect((await f.read(t)).view.state.street).toBe('flop');
  await f.command(t,'act',{participantId:t.human,action:{type:'check'}});await human();
  expect((await f.read(t)).view.state.street).toBe('turn');
  await f.command(t,'act',{participantId:t.human,action:{type:'fold'}});
  return t;
}
test('unequal Hands produce decision-weighted session means and share member jobs with both Hand scopes without live subscriptions',async()=>{
  const f=await fixture({automaticBots:true,jobRunnerOptions:{concurrency:4,maximumQueued:16}});
  try{
    const t=await twoHands(f),stranger=await f.table();await f.configure(t,reference);const before=await f.read(t);
    const live=f.connect(t),other=f.connect(stranger);await expect.poll(()=>live.messages.some(message=>message.type==='user-channel-ready')).toBe(true);
    const [session,handA,handB]=await Promise.all([f.post(t,'session-summaries',{}),f.post(t,'hand-summaries',{handId:'hand-1'}),f.post(t,'hand-summaries',{handId:'hand-2'})].map(async response=>(await response).json()));
    expect(session).toMatchObject({scope:'table-session',status:'pending',decisionCount:4,capturedPokerRevision:before.pokerRevision,referenceStrategy:reference,decisionIds:['hand-1/decision-1','hand-2/decision-2','hand-2/decision-3','hand-2/decision-5']});
    expect(session).not.toHaveProperty('averages');expect(handA.scope).toBe('hand');
    const readable:Promise<unknown>[]=[];live.socket.on('message',raw=>{const message=JSON.parse(raw.toString());if(message.resource==='summary'&&message.requestId===session.requestId)readable.push(f.summary(t,message.requestId).then(response=>response.json()));});
    await expect.poll(()=>f.evaluations.length).toBe(2);
    for(const evaluation of f.evaluations.slice())evaluation.result.resolve(independentPolicy(evaluation.view));
    await expect.poll(()=>f.evaluations.length).toBe(4);
    for(const evaluation of f.evaluations.slice(2))evaluation.result.resolve(independentPolicy(evaluation.view));
    await expect.poll(async()=>(await(await f.summary(t,session.requestId)).json()).status).toBe('complete');
    const complete=await(await f.summary(t,session.requestId)).json();
    expect(complete.averages).toEqual({decisionScore:.325,actionRankScore:.375});
    await expect.poll(()=>readable.length).toBe(1);expect(await Promise.all(readable)).toEqual([expect.objectContaining({status:'complete',averages:{decisionScore:.325,actionRankScore:.375}})]);
    await expect.poll(async()=>(await(await f.summary(t,handA.requestId)).json()).status).toBe('complete');
    await expect.poll(async()=>(await(await f.summary(t,handB.requestId)).json()).status).toBe('complete');
    expect((await(await f.summary(t,handA.requestId)).json()).averages).toEqual({decisionScore:1,actionRankScore:1});
    const b=await(await f.summary(t,handB.requestId)).json();expect(b.averages.decisionScore).toBeCloseTo(.1,14);expect(b.averages.actionRankScore).toBeCloseTo(1/6,14);
    expect(f.evaluations).toHaveLength(4);expect(other.messages.some(message=>message.type==='analysis-update')).toBe(false);
    expect(live.messages.filter(message=>message.type==='analysis-update'&&message.resource==='summary').every(message=>!('averages'in message))).toBe(true);
    expect((await f.summary(t,session.requestId,stranger.cookie)).status).toBe(404);expect(await f.read(t)).toEqual(before);
  }finally{await f.close();}
});

test('a new session snapshot reuses an individually completed member after an earlier derived lookup failure',async()=>{
  const f=await fixture();
  try{
    const t=await f.decision();await f.command(t,'act',{participantId:t.human,action:{type:'fold'}});await f.configure(t,reference);
    await administration.query('ALTER TABLE "'+f.schema+'".analysis_scores RENAME TO temporarily_unavailable_scores');
    const failed=await(await f.post(t,'hand-summaries',{handId:'hand-1'})).json();
    await expect.poll(async()=>(await(await f.summary(t,failed.requestId)).json()).status).toBe('error');
    await administration.query('ALTER TABLE "'+f.schema+'".temporarily_unavailable_scores RENAME TO analysis_scores');
    let individual=await(await f.request(t)).json();
    if(individual.status==='error')individual=await(await f.post(t,'analysis/'+individual.requestId+'/retry',{})).json();
    await expect.poll(()=>f.evaluations.length).toBe(1);
    f.evaluations[0]!.result.resolve({choices:[{action:{type:'fold'},probability:1}]});
    await expect.poll(async()=>(await(await f.result(t,individual.requestId)).json()).status).toBe('complete');
    const fresh=await(await f.post(t,'session-summaries',{})).json();
    await expect.poll(async()=>(await(await f.summary(t,fresh.requestId)).json()).status).toBe('complete');
    expect((await(await f.summary(t,fresh.requestId)).json()).averages).toEqual({decisionScore:1,actionRankScore:1});
    expect(f.evaluations).toHaveLength(1);
    expect((await(await f.summary(t,failed.requestId)).json()).status).toBe('error');
  }finally{await f.close();}
});


test('session failure takes precedence and Retry preserves a frozen cross-Hand snapshot while later play and preferences change', async () => {
  const f = await fixture({ automaticBots: true, jobRunnerOptions: { concurrency: 4, maximumQueued: 16 } });
  try {
    const t = await twoHands(f); await f.configure(t, reference);
    const captured = await f.read(t);
    const original = await (await f.post(t, 'session-summaries', {})).json();
    await expect.poll(() => f.evaluations.length).toBe(2);
    const failedView = f.evaluations[1]!.view, failedSeed = f.evaluations[1]!.seed;
    f.evaluations[0]!.result.resolve(independentPolicy(f.evaluations[0]!.view));
    f.evaluations[1]!.result.reject(new Error('Controlled external failure'));
    await expect.poll(() => f.evaluations.length).toBe(4);
    await expect.poll(async () => (await (await f.summary(t, original.requestId)).json()).status).toBe('error');
    expect(await (await f.summary(t, original.requestId)).json()).not.toHaveProperty('averages');
    // Accepted actions and settings continue while the captured summary has failed.
    await f.configure(t, baselinePlayingStrategy);
    await f.command(t, 'start-hand');
    await expect.poll(async () => (await f.read(t)).view.state.actorId).toBe(t.human);
    await f.command(t, 'act', { participantId: t.human, action: { type: 'fold' } });
    const retried = await (await f.post(t, 'summaries/' + original.requestId + '/retry', {})).json();
    expect(retried).toMatchObject({ requestId: original.requestId, status: 'pending', scope: 'table-session', decisionIds: original.decisionIds, decisionCount: 4, capturedPokerRevision: captured.pokerRevision, referenceStrategy: reference });
    expect(retried.attemptId).not.toBe(original.attemptId); expect(f.evaluations).toHaveLength(4);
    expect((await (await f.post(t, 'summaries/' + original.requestId + '/retry', {})).json()).attemptId).toBe(retried.attemptId);
    for (const evaluation of f.evaluations.slice(2)) evaluation.result.resolve(independentPolicy(evaluation.view));
    await expect.poll(() => f.evaluations.length).toBe(5);
    expect(f.evaluations[4]!.view).toEqual(failedView); expect(f.evaluations[4]!.seed).toBe(failedSeed);
    f.evaluations[4]!.result.resolve(independentPolicy(f.evaluations[4]!.view));
    await expect.poll(async () => (await (await f.summary(t, original.requestId)).json()).status).toBe('complete');
    const complete = await (await f.summary(t, original.requestId)).json();
    expect(complete.averages).toEqual({ decisionScore: .325, actionRankScore: .375 });
    expect(await (await f.post(t, 'summaries/' + original.requestId + '/retry', {})).json()).toEqual(complete);
    const current = await f.read(t), fresh = await (await f.post(t, 'session-summaries', {})).json();
    expect(fresh).toMatchObject({ decisionCount: 5, referenceStrategy: baselinePlayingStrategy, capturedPokerRevision: current.pokerRevision });
    expect(fresh.requestId).not.toBe(original.requestId); expect(f.evaluations).toHaveLength(5);
  } finally { await f.close(); }
});


test('cold restart loses the exact session request and an explicit new snapshot reuses every successful cross-Hand member', async () => {
  const f = await fixture({ automaticBots: true });
  try {
    const t = await twoHands(f); await f.configure(t, reference);
    const original = await (await f.post(t, 'session-summaries', {})).json();
    await expect.poll(() => f.evaluations.length).toBe(2);
    for (const evaluation of f.evaluations.slice()) evaluation.result.resolve(independentPolicy(evaluation.view));
    await expect.poll(() => f.evaluations.length).toBe(4);
    for (const evaluation of f.evaluations.slice(2)) evaluation.result.resolve(independentPolicy(evaluation.view));
    await expect.poll(async () => (await (await f.summary(t, original.requestId)).json()).status).toBe('complete');
    const before = await f.read(t); await f.restart();
    expect((await f.summary(t, original.requestId)).status).toBe(404);
    expect((await f.post(t, 'summaries/' + original.requestId + '/retry', {})).status).toBe(404);
    const fresh = await (await f.post(t, 'session-summaries', {})).json();
    expect(fresh).toMatchObject({ decisionIds: original.decisionIds, decisionCount: 4, referenceStrategy: reference, capturedPokerRevision: before.pokerRevision });
    expect(fresh.requestId).not.toBe(original.requestId);
    await expect.poll(async () => (await (await f.summary(t, fresh.requestId)).json()).status).toBe('complete');
    expect((await (await f.summary(t, fresh.requestId)).json()).averages).toEqual({ decisionScore: .325, actionRankScore: .375 });
    expect(f.evaluations).toHaveLength(0); expect(await f.read(t)).toEqual(before);
  } finally { await f.close(); }
});
