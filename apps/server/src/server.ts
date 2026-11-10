import { createScoreSummaries } from './summaries.js';
import { createAnalysis } from './analysis.js';
import { JobRunner, type JobRunnerOptions } from './job-runner.js';
import { loadCompletedHandInspection, inspectCompletedHand } from '@poker/research';
import { isSupportedStrategy, type Strategy } from '@poker/strategies';
import Fastify, { type FastifyInstance, type FastifyRequest, type FastifyReply } from 'fastify';
import cookie from '@fastify/cookie';
import websocket from '@fastify/websocket';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { AnalysisUpdate, ServerLiveMessage, ClientLiveMessage, TableLiveMessage, CreateTableSessionRequest, JoinTableRequest, PokerMutationRequest, StrategyDescriptor, SetPlayingStrategyRequest, SetTrainerConfigurationRequest, RetryBotRequest, SetTableOptionsRequest, SetTablePasswordRequest } from '@poker/contracts';
import { openDatabase, initializeDatabase } from './db/database.js';
import { localUsers, tableSessions } from './db/schema.js';
import { upgradeTableSession } from './aggregate.js';
import { createTableSessionMutations, TableSessionRestorationError, type MutationTransactionFaults, type TableSessionControllerCommands } from './mutations.js';
import { createTableSessionCreator, CommitOutcomeUnknown, type CreationTransactionFaults } from './creation.js';
import { createGuestQueue } from './guest-queue.js';
import { validateDisplayName } from './validation.js';
import { AcceptanceTransactions } from './db/acceptance.js';
import { systemClock, type ServerClock } from './clock.js';
import { createRateLimiter, waitText, type RateLimitKind, type RateLimits } from './rate-limit.js';
import { notFound, outcomeStatus, reject } from './rejections.js';

export interface ServerOptions { readonly databaseUrl: string; readonly schema?: string; readonly logger?: boolean; readonly secureCookies?: boolean; readonly beforeInitialize?: (app: FastifyInstance) => Promise<void>; readonly transactionFaults?: CreationTransactionFaults; readonly mutationTransactionFaults?: MutationTransactionFaults; readonly adminMode?: boolean; readonly automaticBots?: boolean; readonly jobRunnerOptions?: JobRunnerOptions; readonly strategyFactory?: (descriptor: StrategyDescriptor) => Strategy; readonly supportsStrategy?: (descriptor: unknown) => boolean; readonly onControllerCommandsReady?: (commands: TableSessionControllerCommands) => void;
  /** The clock for all play timing. Defaults to system time; tests substitute a manually advanced clock. */
  readonly clock?: ServerClock;
  /**
   * Addresses (or CIDR ranges) of the reverse proxy in front of the server. Forwarding headers such as
   * `X-Forwarded-For` are believed only on a connection from one of these, and `request.ip` is then the client's
   * address; from anyone else they are ignored. Omitted: no proxy is trusted.
   */
  readonly trustedProxies?: readonly string[];
  /** Per-client-address limits on creation, joining and Table Password attempts. A kind left out is unlimited. */
  readonly rateLimits?: Partial<RateLimits> }
export async function createServer(options: ServerOptions) {
  const app = Fastify({ logger: options.logger ?? false, trustProxy: options.trustedProxies?.length ? [...options.trustedProxies] : false });
  let closing = false;
  app.addHook('onSend', async (_request, reply) => { if (closing) reply.header('connection', 'close'); });
  const { pool, db } = openDatabase(options.databaseUrl, options.schema);
  await app.register(cookie);
  await app.register(websocket);
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
    reply.setCookie('poker_local', token, { httpOnly: true, sameSite: 'strict', secure: options.secureCookies ?? false, path: '/', maxAge: 31536000 });
    return id;
  }
  const limiter = createRateLimiter(options.rateLimits ?? {}, options.clock ?? systemClock);
  const limitMessages: Record<RateLimitKind, string> = {
    creation: 'Too many tables were created from your network recently.',
    joining: 'Too many join attempts were made from your network recently.',
    'table-password': 'Too many Table Password attempts were made from your network recently.',
  };
  /** Answers 429 with when to try again if this address has used up its allowance for `kind`; otherwise records the request. */
  function refuseIfLimited(kind: RateLimitKind, request: FastifyRequest, reply: FastifyReply) {
    const decision = limiter.take(kind, request.ip);
    if (decision.allowed) return undefined;
    return reply.code(429).header('retry-after', String(decision.retryAfterSeconds))
      .send({ ok: false, rejection: { code: 'rate-limited', message: `${limitMessages[kind]} Try again in ${waitText(decision.retryAfterSeconds)}.` } });
  }
  const acceptance = new AcceptanceTransactions(pool, options.databaseUrl, options.schema);
  // Creating and joining share each Guest's turn, so a Guest is never let in at two Online Tables at once.
  const guests = createGuestQueue();
  const create = createTableSessionCreator(db, acceptance, options.transactionFaults, options.supportsStrategy ?? isSupportedStrategy, guests);
  const jobRunner = new JobRunner(options.jobRunnerOptions);
  const mutations = createTableSessionMutations(db, acceptance, options.mutationTransactionFaults, { runner: jobRunner, automaticBots: options.automaticBots, adminMode: options.adminMode, strategyFactory: options.strategyFactory, supportsStrategy: options.supportsStrategy, onHumanActionAccepted: input => analysis.getOrStart(input, 'automatic-analysis') }, options.clock, guests);
  options.onControllerCommandsReady?.({ submitAction: mutations.submitControllerAction, readPersistedSession: mutations.readPersistedSession, loadedTables: mutations.loadedTables });
  const analysis = createAnalysis(db, jobRunner, options.strategyFactory, publishUserUpdate, mutations.acceptJobResult);
  const summaries = createScoreSummaries(analysis, jobRunner, publishUserUpdate, mutations.acceptJobResult);
  app.addHook('preClose', async () => { closing = true; acceptance.stop(); mutations.stop(); summaries.stop(); analysis.stop(); });
  app.addHook('onClose', async () => { await mutations.close(); await analysis.close(); await pool.end(); await acceptance.close(); });
  const socketOwners = new WeakMap<FastifyRequest, string>();
  // The user channel is independent of open table subscriptions. Analysis publishes here for a Participant,
  // reaching only its Human Controller, after making the HTTP state readable.
  const userChannels = new Map<string, Set<(message: ServerLiveMessage) => void>>();
  function publishUserUpdate(participantId: string, message: AnalysisUpdate) {
    const userId = mutations.controllerOf(message.tableSessionId, participantId);
    for (const deliver of userId ? userChannels.get(userId) ?? [] : []) deliver(message);
  }
  /** The requesting Guest's own joined Participant: the only one whose study results they may read or retry. */
  async function participantAt(tableSessionId: string, userId: string) {
    return /^[0-9a-f-]{36}$/.test(tableSessionId) ? (await mutations.access(tableSessionId, userId))?.participantId : undefined;
  }
  app.get('/api/live', {
    websocket: true,
    preValidation: async (request, reply) => {
      const userId = await authenticatedUser(request.cookies.poker_local);
      if (!userId) return reply.code(401).send({ ok: false, rejection: { code: 'unauthenticated', message: 'Open the Trainer to establish your local identity.' } });
      socketOwners.set(request, userId);
    },
  }, (socket, request) => {
    const userId = socketOwners.get(request)!;
    const deliver = (message: ServerLiveMessage) => { if (socket.readyState === 1) socket.send(JSON.stringify(message)); };
    const channels = userChannels.get(userId) ?? new Set();
    channels.add(deliver); userChannels.set(userId, channels);
    const subscriptions = new Map<string, () => void>();
    let disconnected = false;
    let commands = Promise.resolve();
    socket.on('message', data => {
      let message: ClientLiveMessage;
      try { message = JSON.parse(data.toString()); } catch { socket.close(1008, 'Invalid live message.'); return; }
      if (!message || !['subscribe-table', 'unsubscribe-table'].includes(message.type) || typeof message.requestId !== 'string' || message.requestId.length < 1 || message.requestId.length > 128 || typeof message.tableSessionId !== 'string') {
        socket.close(1008, 'Invalid live message.'); return;
      }
      // Serialize subscription commands so removal cannot overtake authorization/loading.
      commands = commands.then(async () => {
        if (disconnected) return;
        const result = { type: 'table-subscription-result' as const, requestId: message.requestId, tableSessionId: message.tableSessionId };
        subscriptions.get(message.tableSessionId)?.();
        subscriptions.delete(message.tableSessionId);
        if (message.type === 'unsubscribe-table') { deliver({ ...result, status: 'unsubscribed' }); return; }
        if (!/^[0-9a-f-]{36}$/.test(message.tableSessionId)) { deliver({ ...result, status: 'rejected', code: 'not-found' }); return; }
        const initial: TableLiveMessage[] = [];
        let accepted = false;
        try {
          const unsubscribe = await mutations.subscribe(message.tableSessionId, userId, update => { if (accepted) deliver(update); else initial.push(update); });
          if (disconnected) { unsubscribe?.(); return; }
          if (!unsubscribe) { deliver({ ...result, status: 'rejected', code: 'not-found' }); return; }
          subscriptions.set(message.tableSessionId, unsubscribe);
          deliver({ ...result, status: 'subscribed' });
          accepted = true;
          for (const update of initial) deliver(update);
        } catch { deliver({ ...result, status: 'rejected', code: 'unavailable' }); }
      });
    });
    socket.on('close', () => {
      disconnected = true;
      for (const unsubscribe of subscriptions.values()) unsubscribe();
      subscriptions.clear();
      channels.delete(deliver); if (channels.size === 0) userChannels.delete(userId);
    });
    socket.on('error', () => socket.close());
    deliver({ type: 'user-channel-ready' });
  });
  app.get<{ Params: { id: string } }>('/api/table-sessions/:id/live', {
    websocket: true,
    preValidation: async (request, reply) => {
      const userId = await authenticatedUser(request.cookies.poker_local);
      if (!userId) return reply.code(401).send({ ok: false, rejection: { code: 'unauthenticated', message: 'Open the Trainer to establish your local identity.' } });
      try {
        if (!/^[0-9a-f-]{36}$/.test(request.params.id) || !await mutations.read(request.params.id, userId))
          return reply.code(404).send({ ok: false, rejection: { code: 'not-found', message: 'This Table Session is unavailable to this local identity.' } });
        socketOwners.set(request, userId);
      } catch (error) {
        if (error instanceof TableSessionRestorationError) return reply.code(503).send({ ok: false, rejection: { code: 'record-restoration-failed', message: error.message } });
        return reply.code(503).send({ ok: false, rejection: { code: 'persistence-unavailable', message: 'The committed Table Session is unavailable. Refresh to try reading it again.' } });
      }
    },
  }, (socket, request) => {
    let unsubscribe: (() => void) | undefined;
    socket.on('close', () => unsubscribe?.());
    socket.on('error', () => socket.close());
    void mutations.subscribe(request.params.id, socketOwners.get(request)!, update => {
      if (socket.readyState === 1) socket.send(JSON.stringify(update));
    }).then(subscription => {
      if (socket.readyState !== 1) subscription?.();
      else if (!subscription) socket.close(1008, 'Table Session unavailable.');
      else unsubscribe = subscription;
    }).catch(() => socket.close(1011, 'The committed view could not be loaded.'));
  });
  app.get('/api/identity', async (request, reply) => {
    const userId = await ensureIdentity(request, reply);
    const displayName = (await db.select({ displayName: localUsers.displayName }).from(localUsers).where(eq(localUsers.id, userId)))[0]?.displayName;
    return displayName ? { ok: true, displayName } : { ok: true };
  });
  app.put<{ Body: { displayName?: unknown } }>('/api/display-name', async (request, reply) => {
    const userId = await authenticatedUser(request.cookies.poker_local);
    if (!userId) return reply.code(401).send({ ok: false, rejection: { code: 'unauthenticated', message: 'Open the Trainer to establish your local identity.' } });
    const body = request.body as unknown;
    const checked = validateDisplayName(body && typeof body === 'object' && !Array.isArray(body) ? (body as { displayName?: unknown }).displayName : undefined);
    if (!checked.ok) return reply.code(400).send(checked);
    try { await db.update(localUsers).set({ displayName: checked.displayName }).where(eq(localUsers.id, userId)); }
    catch { return reply.code(503).send({ ok: false, rejection: { code: 'persistence-unavailable', message: 'The display name could not be saved. Try again.' } }); }
    return { ok: true, displayName: checked.displayName };
  });
  app.post<{ Body: CreateTableSessionRequest }>('/api/table-sessions', async (request, reply) => {
    const limited = refuseIfLimited('creation', request, reply); if (limited) return limited;
    const ownerUserId = await ensureIdentity(request, reply);
    if (typeof request.body?.requestId !== 'string' || request.body.requestId.length < 1 || request.body.requestId.length > 128)
      return reply.code(400).send({ ok: false, rejection: { code: 'invalid-request-id', message: 'Supply a requestId from 1 to 128 characters.' } });
    try {
      const result = await create(ownerUserId, request.body);
      return reply.code(result.ok ? 201 : ['request-id-conflict', 'current-table-elsewhere'].includes(result.rejection.code) ? 409 : result.rejection.code === 'commit-not-applied' ? 503 : 400).send(result);
    } catch (error) {
      if (error instanceof CommitOutcomeUnknown) return reply.code(503).send({ ok: false, rejection: { code: 'commit-outcome-unknown', message: 'The creation commit outcome is unknown. Check owned sessions or explicitly retry this requestId to resolve it.' } });
      return reply.code(503).send({ ok: false, rejection: { code: 'persistence-unavailable', message: 'Creation could not be confirmed. No definitive domain rejection has been stored.' } });
    }
  });
  app.get('/api/table-sessions', async (request, reply) => {
    const userId = await authenticatedUser(request.cookies.poker_local);
    if (!userId) return reply.code(401).send({ ok: false, rejection: { code: 'unauthenticated', message: 'Open the Trainer to establish your local identity.' } });
    try { return { tables: await mutations.savedTables(userId) }; }
    catch { return reply.code(503).send({ ok: false, rejection: { code: 'persistence-unavailable', message: 'Your saved tables could not be read. Try again.' } }); }
  });
  // The Join Link is the Online Table's own address (ADR-0033): its preview and joining live under the Table Session.
  // An ID that names no Online Table, malformed or a Practice Table's, gets the one answer a missing table gets.
  const tableNotFound = (reply: FastifyReply) => reply.code(404).send(notFound());
  app.get<{ Params: { id: string } }>('/api/table-sessions/:id/join-preview', async (request, reply) => {
    const userId = await authenticatedUser(request.cookies.poker_local);
    if (!userId) return reply.code(401).send({ ok: false, rejection: { code: 'unauthenticated', message: 'Open the Trainer to establish your local identity.' } });
    try {
      const preview = await mutations.previewJoin(userId, request.params.id);
      if (!preview) return tableNotFound(reply);
      return preview.ok ? preview : reply.code(outcomeStatus(preview)).send(preview);
    } catch (error) {
      if (error instanceof TableSessionRestorationError) return reply.code(503).send({ ok: false, rejection: { code: 'record-restoration-failed', message: error.message } });
      return reply.code(503).send({ ok: false, rejection: { code: 'persistence-unavailable', message: 'The table could not be read. Try opening the link again.' } });
    }
  });
  app.post<{ Params: { id: string }; Body: JoinTableRequest }>('/api/table-sessions/:id/join-table', async (request, reply) => {
    const limited = refuseIfLimited('joining', request, reply); if (limited) return limited;
    const userId = await authenticatedUser(request.cookies.poker_local);
    if (!userId) return reply.code(401).send({ ok: false, rejection: { code: 'unauthenticated', message: 'Open the Trainer to establish your local identity.' } });
    if (typeof request.body?.requestId !== 'string' || request.body.requestId.length < 1 || request.body.requestId.length > 128)
      return reply.code(400).send({ ok: false, rejection: { code: 'invalid-request-id', message: 'Supply a requestId from 1 to 128 characters.' } });
    try {
      // Each check of a Table Password is an attempt at it, right or wrong; a join refused before any check spends none.
      let retryAfterSeconds: number | undefined;
      const passwordAttempt = () => {
        const decision = limiter.take('table-password', request.ip);
        if (decision.allowed) return undefined;
        retryAfterSeconds = decision.retryAfterSeconds;
        return reject('rate-limited', `${limitMessages['table-password']} Try again in ${waitText(decision.retryAfterSeconds)}.`);
      };
      const outcome = await mutations.join(request.params.id, userId, request.body, passwordAttempt);
      if (retryAfterSeconds !== undefined && !outcome.ok && outcome.rejection.code === 'rate-limited') return reply.code(429).header('retry-after', String(retryAfterSeconds)).send(outcome);
      return reply.code(outcomeStatus(outcome)).send(outcome);
    } catch (error) {
      if (error instanceof TableSessionRestorationError) return reply.code(503).send({ ok: false, rejection: { code: 'record-restoration-failed', message: error.message } });
      if (error instanceof CommitOutcomeUnknown) return reply.code(503).send({ ok: false, rejection: { code: 'commit-outcome-unknown', message: 'The join outcome is unknown. Try joining again with the same request.' } });
      return reply.code(503).send({ ok: false, rejection: { code: 'persistence-unavailable', message: 'Joining could not be confirmed. Try again.' } });
    }
  });
  app.get<{ Params: { id: string } }>('/api/table-sessions/:id', async (request, reply) => {
    const userId = await authenticatedUser(request.cookies.poker_local);
    if (!userId) return reply.code(401).send({ ok: false, rejection: { code: 'unauthenticated', message: 'Open the Trainer to establish your local identity.' } });
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
  for (const kind of ['seat-participant', 'start-hand', 'act', 'stand-up-participant', 'move-participant', 'set-sitting-out', 'top-up-to', 'set-button', 'leave-table', 'remove-participant', 'add-bot', 'remove-bot'] as const) app.post<{ Params: { id: string }; Body: PokerMutationRequest }>('/api/table-sessions/:id/' + kind, async (request, reply) => {
    const userId = await authenticatedUser(request.cookies.poker_local);
    if (!userId) return reply.code(401).send({ ok: false, rejection: { code: 'unauthenticated', message: 'Open the Trainer to establish your local identity.' } });
    if (!/^[0-9a-f-]{36}$/.test(request.params.id)) return reply.code(404).send({ ok: false, rejection: { code: 'not-found', message: 'This Table Session is unavailable.' } });
    if (typeof request.body?.requestId !== 'string' || request.body.requestId.length < 1 || request.body.requestId.length > 128)
      return reply.code(400).send({ ok: false, rejection: { code: 'invalid-request-id', message: 'Supply a requestId from 1 to 128 characters.' } });
    try {
      const outcome = await mutations.submit(request.params.id, userId, kind, request.body);
      return reply.code(outcomeStatus(outcome)).send(outcome);
    } catch (error) {
      if (error instanceof TableSessionRestorationError) return reply.code(503).send({ ok: false, rejection: { code: 'record-restoration-failed', message: error.message } });
      if (error instanceof CommitOutcomeUnknown) return reply.code(503).send({ ok: false, rejection: { code: 'commit-outcome-unknown', message: 'The commit outcome is unknown. This Table Session is paused pending durable recovery.' } });
      return reply.code(503).send({ ok: false, rejection: { code: 'persistence-unavailable', message: 'The mutation could not be confirmed. Refresh the committed view before submitting another attempt.' } });
    }
  });
  for (const kind of ['set-playing-strategy', 'retry-bot', 'set-trainer-configuration', 'set-table-options'] as const) app.post<{ Params: { id: string }; Body: SetPlayingStrategyRequest | RetryBotRequest | SetTrainerConfigurationRequest | SetTableOptionsRequest }>('/api/table-sessions/:id/' + kind, async (request, reply) => {
    const userId = await authenticatedUser(request.cookies.poker_local);
    if (!userId) return reply.code(401).send({ ok: false, rejection: { code: 'unauthenticated', message: 'Open the Trainer to establish your local identity.' } });
    if (!/^[0-9a-f-]{36}$/.test(request.params.id)) return reply.code(404).send({ ok: false, rejection: { code: 'not-found', message: 'This Table Session is unavailable.' } });
    if (typeof request.body?.requestId !== 'string' || request.body.requestId.length < 1 || request.body.requestId.length > 128) return reply.code(400).send({ ok: false, rejection: { code: 'invalid-request-id', message: 'Supply a requestId from 1 to 128 characters.' } });
    try {
      const outcome = await mutations.configure(request.params.id, userId, kind, request.body);
      return reply.code(outcomeStatus(outcome)).send(outcome);
    } catch (error) {
      if (error instanceof TableSessionRestorationError) return reply.code(503).send({ ok: false, rejection: { code: 'record-restoration-failed', message: error.message } });
      if (error instanceof CommitOutcomeUnknown) return reply.code(503).send({ ok: false, rejection: { code: 'commit-outcome-unknown', message: 'The configuration commit outcome is unknown. This Table Session is paused pending durable recovery.' } });
      return reply.code(503).send({ ok: false, rejection: { code: 'persistence-unavailable', message: 'The configuration change could not be confirmed. Refresh its committed view.' } });
    }
  });
  app.post<{ Params: { id: string }; Body: SetTablePasswordRequest }>('/api/table-sessions/:id/set-table-password', async (request, reply) => {
    const userId = await authenticatedUser(request.cookies.poker_local);
    if (!userId) return reply.code(401).send({ ok: false, rejection: { code: 'unauthenticated', message: 'Open the Trainer to establish your local identity.' } });
    if (!/^[0-9a-f-]{36}$/.test(request.params.id)) return reply.code(404).send(notFound());
    if (typeof request.body?.requestId !== 'string' || request.body.requestId.length < 1 || request.body.requestId.length > 128) return reply.code(400).send({ ok: false, rejection: { code: 'invalid-request-id', message: 'Supply a requestId from 1 to 128 characters.' } });
    try {
      const outcome = await mutations.setTablePassword(request.params.id, userId, request.body);
      return reply.code(outcomeStatus(outcome)).send(outcome);
    } catch (error) {
      if (error instanceof TableSessionRestorationError) return reply.code(503).send({ ok: false, rejection: { code: 'record-restoration-failed', message: error.message } });
      if (error instanceof CommitOutcomeUnknown) return reply.code(503).send({ ok: false, rejection: { code: 'commit-outcome-unknown', message: 'The Table Password change’s commit outcome is unknown. This Table Session is paused pending durable recovery.' } });
      return reply.code(503).send({ ok: false, rejection: { code: 'persistence-unavailable', message: 'The Table Password change could not be confirmed. Refresh the table before trying again.' } });
    }
  });
  app.post<{ Params: { id: string; requestId: string }; Body: Record<string, never> }>('/api/table-sessions/:id/summaries/:requestId/retry', async (request, reply) => {
    const userId = await authenticatedUser(request.cookies.poker_local);
    if (!userId) return reply.code(401).send({ ok: false, rejection: { code: 'unauthenticated', message: 'Establish your local identity first.' } });
    if (request.body !== undefined && (!request.body || Array.isArray(request.body) || typeof request.body !== 'object' || Object.keys(request.body).length)) return reply.code(400).send({ ok: false, rejection: { code: 'invalid-summary-request', message: 'Retry uses the captured summary. Supply an empty request.' } });
    try {
      const participantId = await participantAt(request.params.id, userId);
      const state = participantId && await summaries.retry(request.params.id, request.params.requestId, participantId);
      if (!state) return reply.code(404).send({ ok: false, rejection: { code: 'not-found', message: 'This transient summary request is unavailable. Request a new snapshot explicitly.' } });
      return reply.code(state.status === 'error' && state.error.code === 'capacity' ? 503 : 200).send(state);
    } catch { return reply.code(503).send({ ok: false, rejection: { code: 'persistence-unavailable', message: 'The summary could not be retried. Read its state before trying again.' } }); }
  });
  app.get<{ Params: { id: string; requestId: string } }>('/api/table-sessions/:id/summaries/:requestId', async (request, reply) => {
    const userId = await authenticatedUser(request.cookies.poker_local);
    if (!userId) return reply.code(401).send({ ok: false, rejection: { code: 'unauthenticated', message: 'Establish your local identity first.' } });
    try {
      const participantId = await participantAt(request.params.id, userId);
      const state = participantId && summaries.read(request.params.id, request.params.requestId, participantId);
      return state || reply.code(404).send({ ok: false, rejection: { code: 'not-found', message: 'This transient summary request is unavailable. Request a new snapshot explicitly.' } });
    } catch { return reply.code(503).send({ ok: false, rejection: { code: 'persistence-unavailable', message: 'The summary could not be read. Try reading it again.' } }); }
  });
  app.post<{ Params: { id: string }; Body: Record<string, never> }>('/api/table-sessions/:id/session-summaries', async (request, reply) => {
    const userId = await authenticatedUser(request.cookies.poker_local);
    if (!userId) return reply.code(401).send({ ok: false, rejection: { code: 'unauthenticated', message: 'Establish your local identity first.' } });
    if (!/^[0-9a-f-]{36}$/.test(request.params.id)) return reply.code(404).send({ ok: false, rejection: { code: 'not-found', message: 'This Table Session is unavailable.' } });
    if (request.body !== undefined && (!request.body || Array.isArray(request.body) || typeof request.body !== 'object' || Object.keys(request.body).length)) return reply.code(400).send({ ok: false, rejection: { code: 'invalid-summary-request', message: 'Session summaries capture the committed decisions. Supply an empty request.' } });
    try {
      const input = await mutations.captureSessionSummary(request.params.id, userId);
      if (!input) return reply.code(404).send({ ok: false, rejection: { code: 'not-found', message: 'This Table Session is unavailable.' } });
      const state = await summaries.create(input);
      return reply.code(state.status === 'error' && state.error.code === 'capacity' ? 503 : 200).send(state);
    } catch { return reply.code(503).send({ ok: false, rejection: { code: 'persistence-unavailable', message: 'The summary snapshot could not be captured.' } }); }
  });
  app.post<{ Params: { id: string }; Body: { handId: string } }>('/api/table-sessions/:id/hand-summaries', async (request, reply) => {
    const userId = await authenticatedUser(request.cookies.poker_local);
    if (!userId) return reply.code(401).send({ ok: false, rejection: { code: 'unauthenticated', message: 'Establish your local identity first.' } });
    if (!/^[0-9a-f-]{36}$/.test(request.params.id)) return reply.code(404).send({ ok: false, rejection: { code: 'not-found', message: 'This Table Session is unavailable.' } });
    if (!request.body || typeof request.body.handId !== 'string' || request.body.handId.length < 1 || request.body.handId.length > 128 || Object.keys(request.body).some(key => key !== 'handId')) return reply.code(400).send({ ok: false, rejection: { code: 'invalid-summary-request', message: 'Supply only the Hand ID.' } });
    try {
      const input = await mutations.captureHandSummary(request.params.id, userId, request.body.handId);
      if (input === undefined) return reply.code(404).send({ ok: false, rejection: { code: 'not-found', message: 'This Table Session is unavailable.' } });
      if (input === null) return reply.code(400).send({ ok: false, rejection: { code: 'hand-unavailable', message: 'Choose an existing Hand.' } });
      const state = await summaries.create(input);
      return reply.code(state.status === 'error' && state.error.code === 'capacity' ? 503 : 200).send(state);
    } catch { return reply.code(503).send({ ok: false, rejection: { code: 'persistence-unavailable', message: 'The summary snapshot could not be captured.' } }); }
  });
  app.post<{ Params: { id: string }; Body: { decisionId: string; live?: true } }>('/api/table-sessions/:id/analysis', async (request, reply) => {
    const userId = await authenticatedUser(request.cookies.poker_local);
    if (!userId) return reply.code(401).send({ ok: false, rejection: { code: 'unauthenticated', message: 'Establish your local identity first.' } });
    if (!/^[0-9a-f-]{36}$/.test(request.params.id)) return reply.code(404).send({ ok: false, rejection: { code: 'not-found', message: 'This Table Session is unavailable.' } });
    if (!request.body || typeof request.body.decisionId !== 'string' || request.body.decisionId.length < 1 || request.body.decisionId.length > 128 || request.body.live !== undefined && request.body.live !== true || Object.keys(request.body).some(key => !['decisionId', 'live'].includes(key))) return reply.code(400).send({ ok: false, rejection: { code: 'invalid-analysis-request', message: 'Supply a Decision ID and an optional Live Analysis request.' } });
    try {
      const input = await mutations.captureEvaluation(request.params.id, userId, request.body.decisionId);
      if (input === undefined) return reply.code(404).send({ ok: false, rejection: { code: 'not-found', message: 'This Table Session is unavailable.' } });
      if (input === null) return reply.code(400).send({ ok: false, rejection: { code: 'decision-unavailable', message: 'Choose a current or accepted human decision.' } });
      if ('ok' in input) return reply.code(outcomeStatus(input)).send(input);
      const state = await analysis.getOrStart(input, request.body.live ? 'live-analysis' : 'interactive-analysis');
      return reply.code(state.status === 'error' && state.error.code === 'capacity' ? 503 : 200).send(state);
    } catch { return reply.code(503).send({ ok: false, rejection: { code: 'persistence-unavailable', message: 'Analysis could not be loaded. Try reading it again.' } }); }
  });
  app.post<{ Params: { id: string; requestId: string }; Body: Record<string, never> }>('/api/table-sessions/:id/analysis/:requestId/retry', async (request, reply) => {
    const userId = await authenticatedUser(request.cookies.poker_local);
    if (!userId) return reply.code(401).send({ ok: false, rejection: { code: 'unauthenticated', message: 'Establish your local identity first.' } });
    if (!/^[0-9a-f-]{36}$/.test(request.params.id) || !/^[0-9a-f-]{36}$/.test(request.params.requestId)) return reply.code(404).send({ ok: false, rejection: { code: 'not-found', message: 'This analysis is unavailable.' } });
    if (request.body !== undefined && (!request.body || Array.isArray(request.body) || typeof request.body !== 'object' || Object.keys(request.body).length)) return reply.code(400).send({ ok: false, rejection: { code: 'invalid-analysis-request', message: 'Retry uses the original analysis inputs. Supply an empty request.' } });
    try {
      const participantId = await participantAt(request.params.id, userId);
      const state = participantId && await analysis.retry(request.params.id, request.params.requestId, participantId);
      if (!state) return reply.code(404).send({ ok: false, rejection: { code: 'not-found', message: 'This analysis is unavailable.' } });
      return reply.code(state.status === 'error' && state.error.code === 'capacity' ? 503 : 200).send(state);
    } catch { return reply.code(503).send({ ok: false, rejection: { code: 'persistence-unavailable', message: 'Analysis could not be retried. Try reading it again.' } }); }
  });
  app.get<{ Params: { id: string; requestId: string } }>('/api/table-sessions/:id/analysis/:requestId', async (request, reply) => {
    const userId = await authenticatedUser(request.cookies.poker_local);
    if (!userId) return reply.code(401).send({ ok: false, rejection: { code: 'unauthenticated', message: 'Establish your local identity first.' } });
    if (!/^[0-9a-f-]{36}$/.test(request.params.id) || !/^[0-9a-f-]{36}$/.test(request.params.requestId)) return reply.code(404).send({ ok: false, rejection: { code: 'not-found', message: 'This analysis is unavailable.' } });
    try {
      const participantId = await participantAt(request.params.id, userId);
      const state = participantId && await analysis.read(request.params.id, request.params.requestId, participantId);
      if (!state) return reply.code(404).send({ ok: false, rejection: { code: 'not-found', message: 'This analysis is unavailable.' } });
      return state;
    } catch { return reply.code(503).send({ ok: false, rejection: { code: 'persistence-unavailable', message: 'Analysis could not be loaded. Try reading it again.' } }); }
  });
  app.post<{ Params: { id: string }; Body: { handId: string } }>('/api/table-sessions/:id/inspect-hand', async (request, reply) => {
    const userId = await authenticatedUser(request.cookies.poker_local);
    if (!userId) return reply.code(401).send({ ok: false, rejection: { code: 'unauthenticated', message: 'Open the Trainer to establish your local identity.' } });
    if (!/^[0-9a-f-]{36}$/.test(request.params.id)) return reply.code(404).send({ ok: false, rejection: { code: 'not-found', message: 'This Table Session is unavailable.' } });
    if (options.adminMode === false) return reply.code(403).send({ ok: false, rejection: { code: 'admin-mode-disabled', message: 'Completed-Hand inspection is disabled on this server.' } });
    if (!request.body || typeof request.body.handId !== 'string' || request.body.handId.length < 1 || request.body.handId.length > 128 || Object.keys(request.body).some(key => key !== 'handId'))
      return reply.code(400).send({ ok: false, rejection: { code: 'invalid-inspection-request', message: 'Supply only the completed Hand ID.' } });
    try {
      const access = await mutations.access(request.params.id, userId);
      if (access && !access.owner) return reply.code(403).send({ ok: false, rejection: { code: 'table-owner-required', message: 'Only the Table Owner can inspect completed Hands.' } });
      if (access?.mode === 'online') return reply.code(403).send({ ok: false, rejection: { code: 'unavailable-at-online-tables', message: 'Admin Mode and completed-Hand inspection are not available at Online Tables.' } });
      const input = access && await loadCompletedHandInspection(request.params.id, request.body.handId, async id => {
        // Load authorized durable inputs; reconstruction belongs to the admitted Research job.
        const owned = await db.select({ aggregate: tableSessions.aggregate }).from(tableSessions).where(and(eq(tableSessions.id, id), eq(tableSessions.ownerUserId, userId)));
        if (!owned[0]) return undefined;
        const aggregate = upgradeTableSession(owned[0].aggregate);
        if (!aggregate) throw new TableSessionRestorationError();
        return aggregate.ownerUserId === userId ? { pokerRecord: aggregate.pokerRecord } : undefined;
      });
      if (!input) return reply.code(404).send({ ok: false, rejection: { code: 'not-found', message: 'This Table Session is unavailable to this local identity.' } });
      const result = await jobRunner.submit('interactive-analysis', input, inspectCompletedHand).result;
      if (!result.ok) return reply.code(503).send({ ok: false, rejection: { code: 'inspection-' + result.code, message: result.code === 'capacity' ? 'The computation queue is full. Try revealing this completed Hand again.' : 'Inspection could not complete. Try revealing this completed Hand again.' } });
      const outcome = result.value;
      return reply.code(outcome.ok ? 200 : outcome.rejection.code === 'hand-not-found' ? 404 : outcome.rejection.code === 'record-restoration-failed' ? 503 : 400).send(outcome);
    } catch (error) {
      if (error instanceof TableSessionRestorationError) return reply.code(503).send({ ok: false, rejection: { code: 'record-restoration-failed', message: error.message } });
      return reply.code(503).send({ ok: false, rejection: { code: 'persistence-unavailable', message: 'The committed Hand could not be read. Try revealing it again.' } });
    }
  });
  try {
    // Hosted transports may bind with gated routes while waiting for authority.
    // No schema work, restoration, or Bot work is allowed before this gate.
    await options.beforeInitialize?.(app);
    await initializeDatabase(pool);
    await mutations.startRecovery();
    await mutations.loadScheduledTables();
    return app;
  } catch (error) {
    await app.close().catch(() => {});
    throw error;
  }
}
