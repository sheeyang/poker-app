/** Real server/browser fixture. Only Strategy completion timing/failure is controlled. */
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { baselineStrategy } from '@poker/strategies';
import { createServer } from '../../src/server.js';
const databaseUrl = process.env.TEST_DATABASE_URL!;
const schema = 'browser_evaluation_' + randomUUID().replaceAll('-', '');
const administration = new Pool({ connectionString: databaseUrl });
await administration.query('CREATE SCHEMA "' + schema + '"');
let gate: ReturnType<typeof Promise.withResolvers<void>> | undefined;
let abort = Promise.withResolvers<void>();
let held = 0;
let failed = false;
let evaluations = 0;
async function start() {
  const server = await createServer({ databaseUrl, schema, automaticBots: false, strategyFactory: descriptor => {
    const strategy = baselineStrategy(descriptor);
    return { ...strategy, policy: { checkCompatibility: view => strategy.policy.checkCompatibility(view), evaluate: async (view, execution) => {
      evaluations++;
      const captured = gate;
      if (captured) {
        held++;
        execution.signal?.addEventListener('abort', () => abort.resolve(), { once: true });
        try { await captured.promise; } finally { held--; }
      }
      if (failed) throw new Error('Controlled Strategy failure.');
      return strategy.policy.evaluate(view, execution);
    } } };
  } });
  await server.listen({ host: '127.0.0.1', port: Number(process.env.POKER_EVALUATION_PORT ?? 3024) });
  return server;
}
let server = await start();
const control = http.createServer(async (request, response) => {
  response.setHeader('access-control-allow-origin', '*');
  const path = new URL(request.url!, 'http://localhost').pathname;
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
  response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ evaluations, held: !!gate, failed }));
});
control.listen(Number(process.env.POKER_EVALUATION_CONTROL_PORT ?? 3026), '127.0.0.1');
console.log('Evaluation browser fixture ready: ' + schema);
