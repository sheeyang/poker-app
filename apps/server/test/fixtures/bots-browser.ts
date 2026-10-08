/** Isolated browser verification fixture. No HTTP testing or controller-authority bypass. */
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { baselineStrategy } from '@poker/strategies';
import { createServer } from '../../src/server.js';
const databaseUrl = process.env.TEST_DATABASE_URL!;
if (!databaseUrl) throw new Error('Set TEST_DATABASE_URL.');
const schema = 'browser_bot_' + randomUUID().replaceAll('-', '');
const administration = new Pool({ connectionString: databaseUrl });
await administration.query('CREATE SCHEMA "' + schema + '"');
let failOnce = process.env.POKER_BROWSER_FAIL_ONCE === '1';
const server = await createServer({ databaseUrl, schema, strategyFactory: descriptor => {
  const strategy = baselineStrategy(descriptor);
  return { ...strategy, policy: {
    checkCompatibility: view => strategy.policy.checkCompatibility(view),
    evaluate: (view, options) => {
      if (failOnce) { failOnce = false; throw new Error('Controlled browser backend failure.'); }
      return strategy.policy.evaluate(view, options);
    },
  } };
} });
await server.listen({ host: '127.0.0.1', port: 3012 });
console.log('Bot browser fixture ready on 3012, isolated schema ' + schema);
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, async () => { await server.close(); await administration.query('DROP SCHEMA "' + schema + '" CASCADE'); await administration.end(); process.exit(0); });
