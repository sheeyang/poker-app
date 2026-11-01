/**
 * Real application on an isolated schema, with automatic Bots and the system clock, so Presentation
 * Phases and Action Windows run at their real pace. Pair it with live-transport.ts to drop, hold or
 * replay frames mid-schedule.
 */
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { createServer } from '../../src/server.js';
const databaseUrl = process.env.TEST_DATABASE_URL!;
if (!databaseUrl) throw new Error('Set TEST_DATABASE_URL.');
const schema = 'browser_schedule_' + randomUUID().replaceAll('-', '');
const administration = new Pool({ connectionString: databaseUrl });
await administration.query('CREATE SCHEMA "' + schema + '"');
const server = await createServer({ databaseUrl, schema });
const port = Number(process.env.POKER_BROWSER_PORT ?? 4031);
await server.listen({ host: '127.0.0.1', port });
console.log('Schedule browser fixture on http://127.0.0.1:' + port + ', schema ' + schema + '. Type stop to clean up.');
let stopping = false;
async function stop() {
  if (stopping) return; stopping = true;
  await server.close(); await administration.query('DROP SCHEMA "' + schema + '" CASCADE'); await administration.end();
  process.exit(0);
}
process.stdin.on('data', data => { if (data.toString().trim() === 'stop') void stop(); });
process.on('SIGINT', () => void stop()); process.on('SIGTERM', () => void stop());
