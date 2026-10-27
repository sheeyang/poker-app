/** Combined M2 fixture: real transport/storage/engine; externally controlled Strategy behavior. */
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { createStrategy, type PolicyResult } from '@poker/strategies';
import { createServer } from '../../src/server.js';
const databaseUrl = process.env.TEST_DATABASE_URL!;
const schema = 'browser_session_summary_' + randomUUID().replaceAll('-', '');
const administration = new Pool({ connectionString: databaseUrl });
await administration.query('CREATE SCHEMA "' + schema + '"');
let gate: ReturnType<typeof Promise.withResolvers<void>> | undefined;
let abort = Promise.withResolvers<void>();
let held = 0;
let failed = false;
let evaluations = 0;
let mode: 'baseline' | 'passive' | 'numerical' = 'baseline';
const humans = new Set<string>();
async function start() {
  const server = await createServer({ databaseUrl, schema, automaticBots: true, strategyFactory: descriptor => {
    const strategy = createStrategy(descriptor);
    return { ...strategy, policy: { checkCompatibility: view => strategy.policy.checkCompatibility(view), evaluate: async (view, execution) => {
      const controlled = mode === 'baseline' || humans.has(view.state.actorId!);
      if (!controlled) {
        const action = view.state.legalActions.find(action => action.type === 'call' || action.type === 'check') ?? view.state.legalActions[0]!;
        return { choices: [{ action: action.type === 'bet' ? { type: 'bet', betTo: action.minimum } : action.type === 'raise' ? { type: 'raise', raiseTo: action.minimum } : { type: action.type }, probability: 1 }] };
      }
      evaluations++;
      const captured = gate;
      if (captured) {
        held++;
        execution.signal?.addEventListener('abort', () => abort.resolve(), { once: true });
        try { await captured.promise; } finally { held--; }
      }
      if (failed) throw new Error('Controlled Strategy failure.');
      if (mode === 'numerical') {
        if (view.state.handId === 'hand-1' || view.state.street === 'preflop') return { choices: [{ action: { type: 'fold' }, probability: 1 }] } satisfies PolicyResult;
        if (view.state.street === 'flop') return { choices: [{ action: { type: 'fold' }, probability: .6 }, { action: { type: 'check' }, probability: .3 }, { action: { type: 'bet', betTo: 20 }, probability: .1 }] } satisfies PolicyResult;
        return { choices: [{ action: { type: 'check' }, probability: 1 }] } satisfies PolicyResult;
      }
      return strategy.policy.evaluate(view, execution);
    } } };
  } });
  await server.listen({ host: '127.0.0.1', port: Number(process.env.POKER_EVALUATION_PORT ?? 3094) });
  return server;
}
let server = await start();
const control = http.createServer(async (request, response) => {
  response.setHeader('access-control-allow-origin', '*');
  const url = new URL(request.url!, 'http://localhost');
  const path = url.pathname;
  if (path === '/baseline') mode = 'baseline';
  if (path === '/passive' || path === '/numerical') { mode = path.slice(1) as 'passive' | 'numerical'; const human = url.searchParams.get('human'); if (human) humans.add(human); }
  if (path === '/hold') { gate ??= Promise.withResolvers<void>(); failed = false; }
  if (path === '/fail') { failed = true; }
  if (path === '/release') { gate?.resolve(); gate = undefined; }
  if (path === '/restart' || path === '/stop') {
    const closing = server.close();
    if (held) await abort.promise;
    gate?.resolve(); gate = undefined;
    await closing;
    if (path === '/restart') { abort = Promise.withResolvers<void>(); failed = false; server = await start(); }
    else { await administration.query('DROP SCHEMA "' + schema + '" CASCADE'); await administration.end(); response.end('Stopped'); control.close(); return; }
  }
  response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ evaluations, held: !!gate, failed, mode }));
});
control.listen(Number(process.env.POKER_EVALUATION_CONTROL_PORT ?? 3096), '127.0.0.1');
console.log('Evaluation browser fixture ready: ' + schema);
