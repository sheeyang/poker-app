/** Real application, isolated PostgreSQL schema; transport faults live in live-transport.ts. */
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { createServer } from '../../src/server.js';
const databaseUrl = process.env.TEST_DATABASE_URL!;
if (!databaseUrl) throw new Error('Set TEST_DATABASE_URL.');
const schema = 'browser_live_' + randomUUID().replaceAll('-', '');
const administration = new Pool({ connectionString: databaseUrl });
await administration.query('CREATE SCHEMA "' + schema + '"');
const server = await createServer({ databaseUrl, schema, automaticBots: false });
await server.listen({ host: '127.0.0.1', port: Number(process.env.POKER_BROWSER_PORT ?? 4021) });
console.log('Shared connection browser fixture ready in ' + schema);
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, async () => { await server.close(); await administration.query('DROP SCHEMA "' + schema + '" CASCADE'); await administration.end(); process.exit(0); });
