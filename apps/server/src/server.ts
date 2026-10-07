import Fastify, { type FastifyRequest, type FastifyReply } from 'fastify';
import cookie from '@fastify/cookie';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { CreateTableSessionRequest, PokerMutationRequest } from '@poker/contracts';
import { openDatabase, initializeDatabase } from './db/database.js';
import { localUsers, tableSessions } from './db/schema.js';
import { createTableSessionMutations, TableSessionRestorationError, type MutationTransactionFaults, type TableSessionControllerCommands } from './mutations.js';
import { createTableSessionCreator, CommitOutcomeUnknown, type CreationTransactionFaults } from './creation.js';

export interface ServerOptions { readonly databaseUrl: string; readonly schema?: string; readonly logger?: boolean; readonly transactionFaults?: CreationTransactionFaults; readonly mutationTransactionFaults?: MutationTransactionFaults; readonly onControllerCommandsReady?: (commands: TableSessionControllerCommands) => void }
export async function createServer(options: ServerOptions) {
  const app = Fastify({ logger: options.logger ?? false });
  const { pool, db } = openDatabase(options.databaseUrl, options.schema);
  await initializeDatabase(pool);
  await app.register(cookie);
  app.addHook('onClose', async () => { await pool.end(); });
  const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');
  async function authenticatedUser(token: string | undefined) {
    if (!token) return undefined;
    const rows = await db.select().from(localUsers).where(eq(localUsers.tokenHash, tokenHash(token)));
    return rows[0]?.id;
  }
  async function ensureIdentity(request: FastifyRequest, reply: FastifyReply): Promise<string> {
    const known = await authenticatedUser(request.cookies.poker_local);
    if (known) return known;
    const token = randomBytes(32).toString('base64url');
    const id = randomUUID();
    await db.insert(localUsers).values({ id, tokenHash: tokenHash(token) });
    reply.setCookie('poker_local', token, { httpOnly: true, sameSite: 'strict', path: '/', maxAge: 31536000 });
    return id;
  }
  const create = createTableSessionCreator(db, options.transactionFaults);
  const mutations = createTableSessionMutations(db, options.mutationTransactionFaults);
  options.onControllerCommandsReady?.({ submitAction: mutations.submitControllerAction });
  app.get('/api/identity', async (request, reply) => { await ensureIdentity(request, reply); return { ok: true }; });
  app.post<{ Body: CreateTableSessionRequest }>('/api/table-sessions', async (request, reply) => {
    const ownerUserId = await ensureIdentity(request, reply);
    if (typeof request.body?.requestId !== 'string' || request.body.requestId.length < 1 || request.body.requestId.length > 128)
      return reply.code(400).send({ ok: false, rejection: { code: 'invalid-request-id', message: 'Supply a requestId from 1 to 128 characters.' } });
    try {
      const result = await create(ownerUserId, request.body);
      return reply.code(result.ok ? 201 : result.rejection.code === 'request-id-conflict' ? 409 : 400).send(result);
    } catch (error) {
      if (error instanceof CommitOutcomeUnknown) return reply.code(503).send({ ok: false, rejection: { code: 'commit-outcome-unknown', message: 'The creation commit outcome is unknown. Check owned sessions or explicitly retry this requestId to resolve it.' } });
      return reply.code(503).send({ ok: false, rejection: { code: 'persistence-unavailable', message: 'Creation could not be confirmed. No definitive domain rejection has been stored.' } });
    }
  });
  app.get('/api/table-sessions', async (request, reply) => {
    const userId = await authenticatedUser(request.cookies.poker_local);
    if (!userId) return reply.code(401).send({ ok: false, rejection: { code: 'unauthenticated', message: 'Open the Playground to establish your local identity.' } });
    const rows = await db.select({ id: tableSessions.id }).from(tableSessions).where(eq(tableSessions.ownerUserId, userId));
    return { tableSessionIds: rows.map(row => row.id) };
  });
  app.get<{ Params: { id: string } }>('/api/table-sessions/:id', async (request, reply) => {
    const userId = await authenticatedUser(request.cookies.poker_local);
    if (!userId) return reply.code(401).send({ ok: false, rejection: { code: 'unauthenticated', message: 'Open the Playground to establish your local identity.' } });
    if (!/^[0-9a-f-]{36}$/.test(request.params.id)) return reply.code(404).send({ ok: false, rejection: { code: 'not-found', message: 'This Table Session is unavailable.' } });
    try {
      const view = await mutations.read(request.params.id, userId);
      if (!view) return reply.code(404).send({ ok: false, rejection: { code: 'not-found', message: 'This Table Session is unavailable to this local identity.' } });
      return view;
    } catch (error) {
      if (error instanceof TableSessionRestorationError) return reply.code(503).send({ ok: false, rejection: { code: 'record-restoration-failed', message: error.message } });
      return reply.code(503).send({ ok: false, rejection: { code: 'persistence-unavailable', message: 'The committed Table Session is unavailable. Refresh to try reading it again.' } });
    }
  });
  for (const kind of ['seat-participant', 'start-hand', 'act', 'leave-participant', 'move-participant', 'set-sitting-out', 'top-up-to', 'set-button'] as const) app.post<{ Params: { id: string }; Body: PokerMutationRequest }>('/api/table-sessions/:id/' + kind, async (request, reply) => {
    const userId = await authenticatedUser(request.cookies.poker_local);
    if (!userId) return reply.code(401).send({ ok: false, rejection: { code: 'unauthenticated', message: 'Open the Playground to establish your local identity.' } });
    if (!/^[0-9a-f-]{36}$/.test(request.params.id)) return reply.code(404).send({ ok: false, rejection: { code: 'not-found', message: 'This Table Session is unavailable.' } });
    if (typeof request.body?.requestId !== 'string' || request.body.requestId.length < 1 || request.body.requestId.length > 128)
      return reply.code(400).send({ ok: false, rejection: { code: 'invalid-request-id', message: 'Supply a requestId from 1 to 128 characters.' } });
    try {
      const outcome = await mutations.submit(request.params.id, userId, kind, request.body);
      return reply.code(outcome.ok ? 200 : outcome.rejection.code === 'not-found' ? 404 : outcome.rejection.code === 'actor-not-authorized' ? 403 : outcome.rejection.code === 'session-recovering' ? 503 : ['request-id-conflict', 'stale-poker-revision'].includes(outcome.rejection.code) ? 409 : 400).send(outcome);
    } catch (error) {
      if (error instanceof TableSessionRestorationError) return reply.code(503).send({ ok: false, rejection: { code: 'record-restoration-failed', message: error.message } });
      if (error instanceof CommitOutcomeUnknown) return reply.code(503).send({ ok: false, rejection: { code: 'commit-outcome-unknown', message: 'The commit outcome is unknown. This Table Session is paused pending durable recovery.' } });
      return reply.code(503).send({ ok: false, rejection: { code: 'persistence-unavailable', message: 'The mutation could not be confirmed. Refresh the committed view before submitting another attempt.' } });
    }
  });
  return app;
}
