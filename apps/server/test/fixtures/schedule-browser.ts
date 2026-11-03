/**
 * Real application on an isolated schema, with automatic Bots and the system clock, so Presentation
 * Phases, Action Windows, Action Deadlines and Next-Hand Countdowns run at their real pace. Pair it with
 * live-transport.ts to drop, hold or replay frames mid-schedule. Control it through stdin, or through
 * `POST /restart` and `POST /stop` on `POKER_BROWSER_CONTROL_PORT` when set: `restart` closes the server
 * and starts it again on the same schema and port; `stop` removes the schema and exits.
 */
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { createServer } from '../../src/server.js';
const databaseUrl = process.env.TEST_DATABASE_URL!;
if (!databaseUrl) throw new Error('Set TEST_DATABASE_URL.');
const schema = 'browser_schedule_' + randomUUID().replaceAll('-', '');
const administration = new Pool({ connectionString: databaseUrl });
await administration.query('CREATE SCHEMA "' + schema + '"');
const port = Number(process.env.POKER_BROWSER_PORT ?? 4031);
async function start() {
  const started = await createServer({ databaseUrl, schema });
  await started.listen({ host: '127.0.0.1', port });
  return started;
}
let server = await start();
let stopping = false;
async function restart() {
  if (stopping) return;
  await server.close(); server = await start();
  console.log('Restarted on the same schema.');
}
async function stop() {
  if (stopping) return; stopping = true;
  await server.close(); await administration.query('DROP SCHEMA "' + schema + '" CASCADE'); await administration.end();
  process.exit(0);
}
process.stdin.on('data', data => {
  const command = data.toString().trim();
  if (command === 'stop') void stop();
  if (command === 'restart') void restart();
});
process.on('SIGINT', () => void stop()); process.on('SIGTERM', () => void stop());
if (process.env.POKER_BROWSER_CONTROL_PORT) {
  http.createServer((request, response) => {
    const path = new URL(request.url!, 'http://localhost').pathname;
    if (request.method !== 'POST' || !['/restart', '/stop'].includes(path)) { response.statusCode = 404; response.end(); return; }
    response.end(path === '/restart' ? 'Restarting' : 'Stopping');
    void (path === '/restart' ? restart() : stop());
  }).listen(Number(process.env.POKER_BROWSER_CONTROL_PORT), '127.0.0.1');
}
console.log('Schedule browser fixture on http://127.0.0.1:' + port + ', schema ' + schema + '. Type restart or stop.');
