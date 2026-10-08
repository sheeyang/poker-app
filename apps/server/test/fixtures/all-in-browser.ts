/** Isolated all-in acceptance server; only entropy and trusted Bot intentions are controlled. */
import crypto, { randomUUID } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { Pool } from 'pg';
import type { ConcreteAction, ObservableTableSession } from '@poker/contracts';
import { createServer } from '../../src/server.js';
import type { TableSessionControllerCommands } from '../../src/mutations.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('Set TEST_DATABASE_URL to a real isolated PostgreSQL database.');
const schema = 'browser_all_in_' + randomUUID().replaceAll('-', '');
const administration = new Pool({ connectionString: databaseUrl });
await administration.query('CREATE SCHEMA "' + schema + '"');
// The browser first establishes a real identity. Arm one 32-byte entropy draw
// only for creation, using the independent all-zero hex master-seed vector.
const realRandomBytes = crypto.randomBytes;
let seedPending = false;
let seedHex = '0'.repeat(64);
const potBoundaries = process.env.BROWSER_POT_BOUNDARIES === '1';
crypto.randomBytes = ((size: number) => {
  if (!seedPending) return realRandomBytes(size);
  if (size !== 32) throw new Error('Expected creation seed allocation.');
  seedPending = false; return Buffer.from(seedHex, 'hex');
}) as typeof crypto.randomBytes;
syncBuiltinESMExports();
let controllers: TableSessionControllerCommands;
const app = await createServer({ automaticBots: false, databaseUrl, schema, onControllerCommandsReady: commands => { controllers = commands; } });
const running = new Set<string>();
const port = Number(process.env.PORT ?? 3008); const base = 'http://127.0.0.1:' + port;
async function advance(id: string, cookie: string) {
  if (running.has(id)) return;
  running.add(id);
  try {
    for (;;) {
      const table = await (await fetch(base + '/api/table-sessions/' + id, { headers: { cookie } })).json() as ObservableTableSession;
      const actor = table.bindings.find(b => b.participantId === table.view.state.actorId);
      if (actor?.controller.kind !== 'bot') return;
      const state = table.view.state; const member = state.participants.find(p => p.participantId === actor.participantId)!;
      const price = Math.max(...state.participants.map(p => p.wager ?? 0));
      const canRespond = state.participants.some(p => p.inHand && p.participantId !== actor.participantId && !p.folded && !p.allIn);
      const boundaryAction: ConcreteAction = member.seat === 1 || member.seat === 4 || member.seat === 5 && state.street !== 'preflop'
        ? { type: 'fold' } : { type: (member.wager ?? 0) < price ? 'call' : 'check' };
      const action: ConcreteAction = potBoundaries ? boundaryAction : state.street === 'preflop' && canRespond && member.stack + (member.wager ?? 0) > price
        ? { type: 'raise', raiseTo: member.stack + (member.wager ?? 0) }
        : { type: (member.wager ?? 0) < price ? 'call' : 'check' };
      const outcome = await controllers.submitAction(id, { requestId: randomUUID(), expectedPokerRevision: table.pokerRevision, participantId: actor.participantId, action });
      if (!outcome.ok) throw new Error(outcome.rejection.code);
    }
  } finally { running.delete(id); }
}
app.addHook('preHandler', async request => {
  if (request.method === 'POST' && request.url === '/api/table-sessions') {
    const body = request.body as { configuration?: { defaultBuyIn?: number } };
    seedHex = (potBoundaries ? body.configuration?.defaultBuyIn === 1 ? 'ba' : '6d7' : '0').padStart(64, '0');
    seedPending = true;
  }
});
app.addHook('onResponse', async request => {
  if (request.url === '/api/table-sessions') seedPending = false;
  const match = /^\/api\/table-sessions\/([^/]+)\/(?:start-hand|act)$/.exec(request.url);
  if (request.method === 'POST' && match) void advance(match[1]!, request.headers.cookie ?? '').catch(error => console.error(error));
});
await app.listen({ host: '127.0.0.1', port });
console.log('All-in browser fixture on ' + base + ', schema ' + schema + '. Type stop to clean up.');
let stopping = false;
async function stop() {
  if (stopping) return; stopping = true;
  await app.close(); await administration.query('DROP SCHEMA "' + schema + '" CASCADE'); await administration.end();
  crypto.randomBytes = realRandomBytes; syncBuiltinESMExports(); process.exit(0);
}
process.stdin.on('data', data => { if (data.toString().trim() === 'stop') void stop(); });
process.on('SIGINT', () => void stop()); process.on('SIGTERM', () => void stop());
