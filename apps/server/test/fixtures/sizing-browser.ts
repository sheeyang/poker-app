/** Local browser acceptance fixture; Bots Call or Check through trusted controller authority. */
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import type { ObservableTableSession } from '@poker/contracts';
import { createServer } from '../../src/server.js';
import type { TableSessionControllerCommands } from '../../src/mutations.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('Set TEST_DATABASE_URL to a real isolated PostgreSQL test database.');
const schema = 'browser_sizing_' + randomUUID().replaceAll('-', '');
const administration = new Pool({ connectionString: databaseUrl });
await administration.query('CREATE SCHEMA "' + schema + '"');
let controllers: TableSessionControllerCommands;
const app = await createServer({ automaticBots: false, databaseUrl, schema, onControllerCommandsReady: commands => { controllers = commands; } });
const running = new Set<string>();
const port = Number(process.env.PORT ?? 3006);
const base = 'http://127.0.0.1:' + port;
async function advance(id: string, cookie: string) {
  if (running.has(id)) return;
  running.add(id);
  try {
    for (;;) {
      const response = await fetch(base + '/api/table-sessions/' + id, { headers: { cookie } });
      const table = await response.json() as ObservableTableSession;
      const actor = table.bindings.find(binding => binding.participantId === table.view.state.actorId);
      if (actor?.controller.kind !== 'bot') return;
      const participant = table.view.state.participants.find(p => p.participantId === actor.participantId)!;
      const price = Math.max(...table.view.state.participants.map(p => p.wager ?? 0));
      const outcome = await controllers.submitAction(id, { requestId: randomUUID(), expectedPokerRevision: table.pokerRevision, participantId: actor.participantId, action: { type: (participant.wager ?? 0) < price ? 'call' : 'check' } });
      if (!outcome.ok) throw new Error(outcome.rejection.code);
    }
  } finally { running.delete(id); }
}
app.addHook('onResponse', async request => {
  const match = /^\/api\/table-sessions\/([^/]+)\/(?:start-hand|act)$/.exec(request.url);
  if (request.method === 'POST' && match) void advance(match[1]!, request.headers.cookie ?? '').catch(error => console.error(error));
});
await app.listen({ host: '127.0.0.1', port });
console.log('Sizing browser fixture on ' + base + ', schema ' + schema + '. Type stop to clean up.');
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await app.close();
  await administration.query('DROP SCHEMA "' + schema + '" CASCADE');
  await administration.end();
  process.exit(0);
}
process.stdin.on('data', data => { if (data.toString().trim() === 'stop') void stop(); });
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
