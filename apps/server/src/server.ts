import Fastify, { type FastifyRequest, type FastifyReply } from 'fastify';
import cookie from '@fastify/cookie';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { CreateTableSessionRequest } from '@poker/contracts';
import { openDatabase, initializeDatabase } from './db/database.js';
import { localUsers, tableSessions } from './db/schema.js';
import { projectTableSession } from './projection.js';
import { createTableSessionCreator, CommitOutcomeUnknown, type CreationTransactionFaults } from './creation.js';

export interface ServerOptions { readonly databaseUrl: string; readonly schema?: string; readonly logger?: boolean; readonly transactionFaults?: CreationTransactionFaults }
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
    const rows = await db.select().from(tableSessions).where(and(eq(tableSessions.id, request.params.id), eq(tableSessions.ownerUserId, userId)));
    const aggregate = rows[0]?.aggregate;
    if (!aggregate) return reply.code(404).send({ ok: false, rejection: { code: 'not-found', message: 'This Table Session is unavailable to this local identity.' } });
    const participant = aggregate.bindings.find(b => b.controller.kind === 'human' && b.userId === userId);
    if (!participant) throw new Error('Owned session has no bound human Participant.');
    return projectTableSession(aggregate, participant.participantId);
  });
  return app;
}
