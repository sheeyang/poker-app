/** Real PostgreSQL browser faults controlled only through the fixture's stdin. */
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { Client, Pool } from 'pg';
import { createServer } from '../../src/server.js';
import type { AcceptanceFaults } from '../../src/db/acceptance.js';
const databaseUrl = process.env.TEST_DATABASE_URL!;
if (!databaseUrl) throw new Error('Set TEST_DATABASE_URL.');
const schema = process.env.POKER_BROWSER_SCHEMA ?? 'browser_recovery_' + randomUUID().replaceAll('-', '');
if (!/^browser_recovery_[a-f0-9]{32}$/.test(schema)) throw new Error('Use a fixture-owned recovery schema.');
const administration = new Pool({ connectionString: databaseUrl });
await administration.query('CREATE SCHEMA IF NOT EXISTS "' + schema + '"');
let armed = false;
let heldId: string | undefined;
let terminal: ReturnType<typeof Promise.withResolvers<'COMMIT' | 'ROLLBACK'>> | undefined;
let target: Promise<void> | undefined;
const faults: AcceptanceFaults = {
  async openClient(context) {
    if (!armed) return;
    armed = false; heldId = context.requestId;
    const client = new Client({ connectionString: databaseUrl, options: '-c search_path=' + schema });
    await client.connect(); return { client, release: () => {} };
  },
  async terminalCommit(client, context) {
    if (context.requestId !== heldId) { await client.query('COMMIT'); return; }
    terminal = Promise.withResolvers<'COMMIT' | 'ROLLBACK'>();
    target = terminal.promise.then(async sql => { try { await client.query(sql); console.log('Target SQL ' + sql + ' confirmed.'); } finally { await (client as Client).end(); } });
    console.log('Real transaction in progress, attempt ' + heldId);
    throw new Error('Controlled lost terminal SQL acknowledgement.');
  },
};
let server!: Awaited<ReturnType<typeof createServer>>;
async function start(adminMode = true) {
  server = await createServer({ databaseUrl, schema, adminMode, transactionFaults: faults, mutationTransactionFaults: faults });
  await server.listen({ host: '127.0.0.1', port: Number(process.env.POKER_BROWSER_PORT ?? 3015) });
  console.log('Recovery browser fixture ready; isolated schema ' + schema);
}
await start();
for await (const line of createInterface({ input: process.stdin })) {
  if (line === 'hold-next') { armed = true; console.log('Next acceptance armed.'); }
  else if (line === 'commit' || line === 'rollback') { terminal?.resolve(line === 'commit' ? 'COMMIT' : 'ROLLBACK'); await target; heldId = undefined; terminal = undefined; target = undefined; }
  else if (line === 'restart' || line === 'restart-off') { await server.close(); await start(line !== 'restart-off'); }
  else if (line === 'stop') {
    terminal?.resolve('ROLLBACK'); await target; await server.close();
    await administration.query('DROP SCHEMA "' + schema + '" CASCADE'); await administration.end();
    console.log('Removed isolated schema ' + schema); process.exit(0);
  }
}
