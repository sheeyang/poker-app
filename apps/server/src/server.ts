import { createScoreSummaries } from './summaries.js';
import { createAnalysis } from './analysis.js';
import { JobRunner, type JobRunnerOptions } from './job-runner.js';
import { createHistoryAnalysisScheduler } from './history-analysis.js';
import { loadCompletedHandInspection, inspectCompletedHand } from '@poker/research';
import { isSupportedStrategy, type Strategy } from '@poker/strategies';
import Fastify, { type FastifyInstance, type FastifyRequest, type FastifyReply } from 'fastify';
import cookie from '@fastify/cookie';
import websocket from '@fastify/websocket';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { decodeHistoryFilter, hasScoreFilter, isHistoryBreakdown, type HistoryBreakdown, type OverallHistory, type OverallHistorySummaryRequest } from '@poker/contracts';
import type { AnalysisUpdate, GetOrStartAnalysisRequest, ServerLiveMessage, ClientLiveMessage, TableLiveMessage, CreateTableSessionRequest, JoinTableRequest, PokerMutationRequest, StrategyDescriptor, SetPlayingStrategyRequest, RetryBotRequest, SetTableOptionsRequest, SetTablePasswordRequest } from '@poker/contracts';
import { createTrainerConfigurations, TrainerConfigurationRestorationError } from './trainer-configuration.js';
import { openDatabase, initializeDatabase } from './db/database.js';
import { localUsers, tableSessions } from './db/schema.js';
import { upgradeTableSession } from './aggregate.js';
import { createTableSessionMutations, TableSessionRestorationError, type MutationTransactionFaults, type TableSessionControllerCommands } from './mutations.js';
import { createTableSessionCreator, CommitOutcomeUnknown, type CreationTransactionFaults } from './creation.js';
import { createGuestQueue } from './guest-queue.js';
import { validateDisplayName } from './validation.js';
import { recordOpened } from './membership.js';
import { guestCookieSeconds, guestSeenIntervalMs, startGuestSweep } from './guests.js';
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
  const clock = options.clock ?? systemClock;
  const identityCookie = { httpOnly: true, sameSite: 'strict', secure: options.secureCookies ?? false, path: '/', maxAge: guestCookieSeconds } as const;
  // A Guest seen again after a day gets their cookie set again for a fresh year, so a regular player never lapses (ADR-0037).
  const renewals = new WeakMap<FastifyRequest, string>();
  app.addHook('onSend', async (request, reply) => { const token = renewals.get(request); if (token) reply.setCookie('poker_local', token, identityCookie); });
  async function authenticatedUser(request: FastifyRequest) {
    const token = request.cookies.poker_local;
    if (!token) return undefined;
    const rows = await db.select().from(localUsers).where(eq(localUsers.tokenHash, tokenHash(token)));
    const guest = rows[0];
    const now = clock.now();
    // A socket upgrade has no response for a cookie to ride on, so only a plain request counts as the day's visit.
    if (guest && !request.headers.upgrade && now - guest.lastSeenAt >= guestSeenIntervalMs) {
      // Housekeeping: a failed write never fails the request, and the Guest is counted at their next visit. No row
      // written means the purge just deleted them, so the cookie names nobody.
      const seen = await db.update(localUsers).set({ lastSeenAt: now }).where(eq(localUsers.id, guest.id)).returning({ id: localUsers.id }).catch(() => undefined);
      if (seen && !seen.length) return undefined;
      if (seen) renewals.set(request, token);
    }
    return guest?.id;
  }
  async function ensureIdentity(request: FastifyRequest, reply: FastifyReply): Promise<string> {
    const known = await authenticatedUser(request);
    if (known) return known;
    const token = randomBytes(32).toString('base64url');
    const id = randomUUID();
    await db.insert(localUsers).values({ id, tokenHash: tokenHash(token), lastSeenAt: clock.now() });
    reply.setCookie('poker_local', token, identityCookie);
    return id;
  }
  const limiter = createRateLimiter(options.rateLimits ?? {}, clock);
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
  const create = createTableSessionCreator(db, acceptance, options.transactionFaults, options.supportsStrategy ?? isSupportedStrategy, guests, options.clock);
  const jobRunner = new JobRunner(options.jobRunnerOptions);
  // A change reaches every connection of its Guest, which reads it again over HTTP.
  const trainerConfigurations = createTrainerConfigurations(db, userId => { for (const deliver of userChannels.get(userId) ?? []) deliver({ type: 'trainer-configuration-changed' }); }, options.supportsStrategy ?? isSupportedStrategy);
  const mutations = createTableSessionMutations(db, acceptance, options.mutationTransactionFaults, { runner: jobRunner, automaticBots: options.automaticBots, adminMode: options.adminMode, strategyFactory: options.strategyFactory, supportsStrategy: options.supportsStrategy, onHumanActionAccepted: input => analysis.getOrStart(input, 'automatic-analysis'), trainerConfigurations }, options.clock, guests);
  options.onControllerCommandsReady?.({ submitAction: mutations.submitControllerAction, readPersistedSession: mutations.readPersistedSession, loadedTables: mutations.loadedTables });
  // Every analysis a Table History or Overall History request schedules shares one per-Guest bound.
  const historyAnalysis = createHistoryAnalysisScheduler(jobRunner);
  const analysis = createAnalysis(db, jobRunner, options.strategyFactory, publishUserUpdate, mutations.acceptJobResult, historyAnalysis);
  const summaries = createScoreSummaries(analysis, jobRunner, publishUserUpdate, mutations.acceptJobResult, historyAnalysis);
  app.addHook('preClose', async () => { closing = true; acceptance.stop(); mutations.stop(); summaries.stop(); analysis.stop(); });
  app.addHook('onClose', async () => { await mutations.close(); await analysis.close(); await pool.end(); await acceptance.close(); });
  const socketOwners = new WeakMap<FastifyRequest, string>();
  // The user channel is independent of open table subscriptions. Analysis publishes here for a Participant,
  // reaching only its Human Controller, after making the HTTP state readable.
  const userChannels = new Map<string, Set<(message: ServerLiveMessage) => void>>();
  function publishUserUpdate(participantId: string, message: AnalysisUpdate, guestId?: string) {
    const deliverTo = (userId: string | undefined) => { for (const deliver of userId ? userChannels.get(userId) ?? [] : []) deliver(message); };
    // A history request names its Guest. Otherwise a former Participant studies too, so their Guest may have to be
    // found in the membership index.
    if (guestId) return deliverTo(guestId);
    void mutations.studentOf(message.tableSessionId, participantId).then(deliverTo, () => { /* Delivery cannot change a readable result. */ });
  }
  /**
   * The requesting Guest's own Participant, joined or former (ADR-0041): the only one whose study results they may read
   * or retry.
   */
  async function participantAt(tableSessionId: string, userId: string) {
    return /^[0-9a-f-]{36}$/.test(tableSessionId) ? (await mutations.participant(tableSessionId, userId))?.participantId : undefined;
  }
  app.get('/api/live', {
    websocket: true,
    preValidation: async (request, reply) => {
      const userId = await authenticatedUser(request);
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
      const userId = await authenticatedUser(request);
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
    const userId = await authenticatedUser(request);
    if (!userId) return reply.code(401).send({ ok: false, rejection: { code: 'unauthenticated', message: 'Open the Trainer to establish your local identity.' } });
    const body = request.body as unknown;
    const checked = validateDisplayName(body && typeof body === 'object' && !Array.isArray(body) ? (body as { displayName?: unknown }).displayName : undefined);
    if (!checked.ok) return reply.code(400).send(checked);
    try { await db.update(localUsers).set({ displayName: checked.displayName }).where(eq(localUsers.id, userId)); }
    catch { return reply.code(503).send({ ok: false, rejection: { code: 'persistence-unavailable', message: 'The display name could not be saved. Try again.' } }); }
    return { ok: true, displayName: checked.displayName };
  });
  // The Guest's Trainer Configuration, for every table (ADR-0041). Changing it is the Guest's own request, not a table's.
  app.get('/api/trainer-configuration', async (request, reply) => {
    const userId = await authenticatedUser(request);
    if (!userId) return reply.code(401).send({ ok: false, rejection: { code: 'unauthenticated', message: 'Open the Trainer to establish your local identity.' } });
    try { return { ok: true, trainerConfiguration: await trainerConfigurations.current(userId) }; }
    catch (error) {
      if (error instanceof TrainerConfigurationRestorationError) return reply.code(503).send({ ok: false, rejection: { code: 'record-restoration-failed', message: error.message } });
      return reply.code(503).send({ ok: false, rejection: { code: 'persistence-unavailable', message: 'Your Trainer Configuration could not be read. Try again.' } });
    }
  });
  app.put<{ Body: unknown }>('/api/trainer-configuration', async (request, reply) => {
    const userId = await authenticatedUser(request);
    if (!userId) return reply.code(401).send({ ok: false, rejection: { code: 'unauthenticated', message: 'Open the Trainer to establish your local identity.' } });
    const requestId = (request.body as { requestId?: unknown } | null)?.requestId;
    if (typeof requestId !== 'string' || requestId.length < 1 || requestId.length > 128) return reply.code(400).send({ ok: false, rejection: { code: 'invalid-request-id', message: 'Supply a requestId from 1 to 128 characters.' } });
    try {
      const outcome = await trainerConfigurations.set(userId, request.body);
      return reply.code(outcome.ok ? 200 : outcome.rejection.code === 'request-id-conflict' ? 409 : 400).send(outcome);
    } catch { return reply.code(503).send({ ok: false, rejection: { code: 'persistence-unavailable', message: 'The change could not be confirmed. Try it again with the same request.' } }); }
  });
  app.post<{ Body: CreateTableSessionRequest }>('/api/table-sessions', async (request, reply) => {
    const limited = refuseIfLimited('creation', request, reply); if (limited) return limited;
    const ownerUserId = await ensureIdentity(request, reply);
    if (typeof request.body?.requestId !== 'string' || request.body.requestId.length < 1 || request.body.requestId.length > 128)
      return reply.code(400).send({ ok: false, rejection: { code: 'invalid-request-id', message: 'Supply a requestId from 1 to 128 characters.' } });
    try {
      const result = await create(ownerUserId, request.body);
      // Bot names repeated within the creation request make the request itself wrong, not a conflict with a table.
      return reply.code(result.ok ? 201 : result.rejection.code === 'name-taken' ? 400 : outcomeStatus(result)).send(result);
    } catch (error) {
      if (error instanceof CommitOutcomeUnknown) return reply.code(503).send({ ok: false, rejection: { code: 'commit-outcome-unknown', message: 'The creation commit outcome is unknown. Check owned sessions or explicitly retry this requestId to resolve it.' } });
      return reply.code(503).send({ ok: false, rejection: { code: 'persistence-unavailable', message: 'Creation could not be confirmed. No definitive domain rejection has been stored.' } });
    }
  });
  app.get('/api/table-sessions', async (request, reply) => {
    const userId = await authenticatedUser(request);
    if (!userId) return reply.code(401).send({ ok: false, rejection: { code: 'unauthenticated', message: 'Open the Trainer to establish your local identity.' } });
    try { return { tables: await mutations.savedTables(userId) }; }
    catch { return reply.code(503).send({ ok: false, rejection: { code: 'persistence-unavailable', message: 'Your saved tables could not be read. Try again.' } }); }
  });
  // The Trainer says a Guest opened a table: the time is the server's, kept with their membership, and orders their saved lists (ADR-0037).
  app.post<{ Params: { id: string } }>('/api/table-sessions/:id/opened', async (request, reply) => {
    const userId = await authenticatedUser(request);
    if (!userId) return reply.code(401).send({ ok: false, rejection: { code: 'unauthenticated', message: 'Open the Trainer to establish your local identity.' } });
    try {
      if (!await recordOpened(db, userId, request.params.id, clock.now())) return reply.code(404).send(notFound());
      return { ok: true };
    } catch { return reply.code(503).send({ ok: false, rejection: { code: 'persistence-unavailable', message: 'The table could not be marked as opened. Try again.' } }); }
  });
  // The Join Link is the Online Table's own address (ADR-0033): its preview and joining live under the Table Session.
  // An ID that names no Online Table, malformed or a Practice Table's, gets the one answer a missing table gets.
  app.get<{ Params: { id: string } }>('/api/table-sessions/:id/join-preview', async (request, reply) => {
    const userId = await authenticatedUser(request);
    if (!userId) return reply.code(401).send({ ok: false, rejection: { code: 'unauthenticated', message: 'Open the Trainer to establish your local identity.' } });
    try {
      const preview = await mutations.previewJoin(userId, request.params.id);
      return preview.ok ? preview : reply.code(outcomeStatus(preview)).send(preview);
    } catch (error) {
      if (error instanceof TableSessionRestorationError) return reply.code(503).send({ ok: false, rejection: { code: 'record-restoration-failed', message: error.message } });
      return reply.code(503).send({ ok: false, rejection: { code: 'persistence-unavailable', message: 'The table could not be read. Try opening the link again.' } });
    }
  });
  app.post<{ Params: { id: string }; Body: JoinTableRequest }>('/api/table-sessions/:id/join-table', async (request, reply) => {
    const limited = refuseIfLimited('joining', request, reply); if (limited) return limited;
    const userId = await authenticatedUser(request);
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
    const userId = await authenticatedUser(request);
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
  /** Table History: the list of the table's completed Hands, for a Guest who may read them (ADR-0040). */
  app.get<{ Params: { id: string } }>('/api/table-sessions/:id/history', async (request, reply) => {
    const userId = await authenticatedUser(request);
    if (!userId) return reply.code(401).send({ ok: false, rejection: { code: 'unauthenticated', message: 'Open the Trainer to establish your local identity.' } });
    if (!/^[0-9a-f-]{36}$/.test(request.params.id)) return reply.code(404).send({ ok: false, rejection: { code: 'not-found', message: 'This Table Session is unavailable.' } });
    try {
      const history = await mutations.readHistory(request.params.id, userId);
      if (!history) return reply.code(404).send({ ok: false, rejection: { code: 'not-found', message: 'This Table Session is unavailable to this local identity.' } });
      return history;
    } catch (error) {
      if (error instanceof TableSessionRestorationError) return reply.code(503).send({ ok: false, rejection: { code: 'record-restoration-failed', message: error.message } });
      return reply.code(503).send({ ok: false, rejection: { code: 'persistence-unavailable', message: 'The Table History is unavailable. Refresh to try reading it again.' } });
    }
  });
  /**
   * Overall History: the Guest's own decisions across every table they may read, filtered by the declared non-score set
   * (`decodeHistoryFilter`: the same encoding as the browser's address) and paged by `limit` (1–200, default 50) and `offset`.
   */
  const count = (value: unknown, fallback: number, minimum: number, maximum: number) => { const number = typeof value === 'string' && /^[0-9]{1,9}$/.test(value) ? Number(value) : fallback; return Math.min(maximum, Math.max(minimum, number)); };
  const pageOf = (query: Record<string, unknown>) => ({ limit: count(query.limit, 50, 1, 200), offset: count(query.offset, 0, 0, Number.MAX_SAFE_INTEGER) });
  app.get<{ Querystring: Record<string, unknown> }>('/api/overall-history', async (request, reply) => {
    const userId = await authenticatedUser(request);
    if (!userId) return reply.code(401).send({ ok: false, rejection: { code: 'unauthenticated', message: 'Open the Trainer to establish your local identity.' } });
    const filter = decodeHistoryFilter(request.query);
    if (hasScoreFilter(filter)) return reply.code(400).send({ ok: false, rejection: { code: 'score-filter-needs-analysis', message: 'A score range is decided by analysis. Ask for it with POST /api/overall-history/scored.' } });
    const { limit, offset } = pageOf(request.query);
    try {
      const decisions = await mutations.readOverallHistory(userId, filter);
      const history: OverallHistory = { filter, total: decisions.length, offset, decisions: decisions.slice(offset, offset + limit) };
      return history;
    } catch (error) {
      if (error instanceof TableSessionRestorationError) return reply.code(503).send({ ok: false, rejection: { code: 'record-restoration-failed', message: error.message } });
      return reply.code(503).send({ ok: false, rejection: { code: 'persistence-unavailable', message: 'Overall History is unavailable. Refresh to try reading it again.' } });
    }
  });
  /**
   * A Score Summary over Overall History's filtered decisions (ADR-0041), optionally broken down by one dimension. The
   * body is `{ filter?, breakdown?, strategy? }`, `filter` in the list's flat encoding. Score ranges narrow it once every
   * analysis of the set the other filters admit has succeeded; until then it is Analyzing or Error, never a partial mean. Every analysis it needs runs as the Guest's
   * `history-analysis`; the answer comes at once and `GET` reports its progress. Transient, like every summary.
   */
  app.post<{ Body: OverallHistorySummaryRequest }>('/api/overall-history/summaries', async (request, reply) => {
    const userId = await authenticatedUser(request);
    if (!userId) return reply.code(401).send({ ok: false, rejection: { code: 'unauthenticated', message: 'Open the Trainer to establish your local identity.' } });
    const body: unknown = request.body ?? {};
    const plain = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
    if (!plain(body) || Object.keys(body).some(key => key !== 'filter' && key !== 'breakdown' && key !== 'strategy') || body.filter !== undefined && (!plain(body.filter) || Object.values(body.filter).some(value => typeof value !== 'string' && typeof value !== 'number' || String(value).length > 512)) || body.breakdown !== undefined && !isHistoryBreakdown(body.breakdown))
      return reply.code(400).send({ ok: false, rejection: { code: 'invalid-summary-request', message: 'Supply an optional filter, in the Overall History address encoding, an optional breakdown: street, position, action or mode, and an optional Strategy.' } });
    // A named Strategy summarizes the same set under it instead of the Guest's Reference Strategy, and never changes their Trainer Configuration.
    if ('strategy' in body && !(options.supportsStrategy ?? isSupportedStrategy)(body.strategy)) return reply.code(400).send({ ok: false, rejection: { code: 'unsupported-strategy', message: 'Choose a supported complete Strategy.' } });
    try {
      const input = await mutations.captureOverallHistorySummary(userId, decodeHistoryFilter(body.filter ?? {}), body.breakdown as HistoryBreakdown | undefined, body.strategy as StrategyDescriptor | undefined);
      return summaries.createHistory(input);
    } catch (error) {
      if (error instanceof TableSessionRestorationError) return reply.code(503).send({ ok: false, rejection: { code: 'record-restoration-failed', message: error.message } });
      return reply.code(503).send({ ok: false, rejection: { code: 'persistence-unavailable', message: 'The summary snapshot could not be captured.' } });
    }
  });
  /**
   * Overall History with score ranges (ADR-0041): the body is `{ filter }`, in the list's flat encoding, holding at least
   * one score range, and optionally `strategy`. A score range is decided by analysis under the Guest's Reference Strategy
   * (or the supported Strategy named, which never changes the Trainer Configuration), so the answer is Analyzing
   * (with progress) or Error until every analysis of the non-score set has succeeded, and only then the decisions the
   * ranges admit, paged by `limit` and `offset` on the `GET`. Transient, like a summary.
   */
  app.post<{ Body: { filter?: Record<string, unknown> }; Querystring: Record<string, unknown> }>('/api/overall-history/scored', async (request, reply) => {
    const userId = await authenticatedUser(request);
    if (!userId) return reply.code(401).send({ ok: false, rejection: { code: 'unauthenticated', message: 'Open the Trainer to establish your local identity.' } });
    const body: unknown = request.body ?? {};
    const plain = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
    const filter = plain(body) && plain(body.filter) && Object.values(body.filter).every(value => (typeof value === 'string' || typeof value === 'number') && String(value).length <= 512) ? decodeHistoryFilter(body.filter) : undefined;
    if (!plain(body) || Object.keys(body).some(key => key !== 'filter' && key !== 'strategy') || !filter || !hasScoreFilter(filter))
      return reply.code(400).send({ ok: false, rejection: { code: 'invalid-scored-request', message: 'Supply a filter, in the Overall History address encoding, with a Decision Score or Action Rank Score range, and an optional Strategy.' } });
    if ('strategy' in body && !(options.supportsStrategy ?? isSupportedStrategy)(body.strategy)) return reply.code(400).send({ ok: false, rejection: { code: 'unsupported-strategy', message: 'Choose a supported complete Strategy.' } });
    try {
      return summaries.createScored(await mutations.captureScoredHistory(userId, filter, body.strategy as StrategyDescriptor | undefined), pageOf(request.query));
    } catch (error) {
      if (error instanceof TableSessionRestorationError) return reply.code(503).send({ ok: false, rejection: { code: 'record-restoration-failed', message: error.message } });
      return reply.code(503).send({ ok: false, rejection: { code: 'persistence-unavailable', message: 'Overall History is unavailable. Refresh to try reading it again.' } });
    }
  });
  app.get<{ Params: { requestId: string }; Querystring: Record<string, unknown> }>('/api/overall-history/scored/:requestId', async (request, reply) => {
    const userId = await authenticatedUser(request);
    if (!userId) return reply.code(401).send({ ok: false, rejection: { code: 'unauthenticated', message: 'Open the Trainer to establish your local identity.' } });
    return summaries.readScored(request.params.requestId, userId, pageOf(request.query)) ?? reply.code(404).send({ ok: false, rejection: { code: 'not-found', message: 'This transient request is unavailable. Ask for the filtered list again.' } });
  });
  app.post<{ Params: { requestId: string }; Body: Record<string, never>; Querystring: Record<string, unknown> }>('/api/overall-history/scored/:requestId/retry', async (request, reply) => {
    const userId = await authenticatedUser(request);
    if (!userId) return reply.code(401).send({ ok: false, rejection: { code: 'unauthenticated', message: 'Open the Trainer to establish your local identity.' } });
    if (request.body !== undefined && (!request.body || Array.isArray(request.body) || typeof request.body !== 'object' || Object.keys(request.body).length)) return reply.code(400).send({ ok: false, rejection: { code: 'invalid-scored-request', message: 'Retry uses the captured request. Supply an empty request.' } });
    return summaries.retryScored(request.params.requestId, userId, pageOf(request.query)) ?? reply.code(404).send({ ok: false, rejection: { code: 'not-found', message: 'This transient request is unavailable. Ask for the filtered list again.' } });
  });
  app.get<{ Params: { requestId: string } }>('/api/overall-history/summaries/:requestId', async (request, reply) => {
    const userId = await authenticatedUser(request);
    if (!userId) return reply.code(401).send({ ok: false, rejection: { code: 'unauthenticated', message: 'Open the Trainer to establish your local identity.' } });
    return summaries.readHistory(request.params.requestId, userId) ?? reply.code(404).send({ ok: false, rejection: { code: 'not-found', message: 'This transient summary request is unavailable. Request a new summary explicitly.' } });
  });
  app.post<{ Params: { requestId: string }; Body: Record<string, never> }>('/api/overall-history/summaries/:requestId/retry', async (request, reply) => {
    const userId = await authenticatedUser(request);
    if (!userId) return reply.code(401).send({ ok: false, rejection: { code: 'unauthenticated', message: 'Open the Trainer to establish your local identity.' } });
    if (request.body !== undefined && (!request.body || Array.isArray(request.body) || typeof request.body !== 'object' || Object.keys(request.body).length)) return reply.code(400).send({ ok: false, rejection: { code: 'invalid-summary-request', message: 'Retry uses the captured summary. Supply an empty request.' } });
    return summaries.retryHistory(request.params.requestId, userId) ?? reply.code(404).send({ ok: false, rejection: { code: 'not-found', message: 'This transient summary request is unavailable. Request a new summary explicitly.' } });
  });
  /** One completed Hand of Table History, replayed: its Replay Steps as the reader may see them (ADR-0041). */
  app.get<{ Params: { id: string; handId: string } }>('/api/table-sessions/:id/history/:handId', async (request, reply) => {
    const userId = await authenticatedUser(request);
    if (!userId) return reply.code(401).send({ ok: false, rejection: { code: 'unauthenticated', message: 'Open the Trainer to establish your local identity.' } });
    if (!/^[0-9a-f-]{36}$/.test(request.params.id)) return reply.code(404).send({ ok: false, rejection: { code: 'not-found', message: 'This Table Session is unavailable.' } });
    try {
      const replay = await mutations.readReplay(request.params.id, userId, request.params.handId);
      if (!replay) return reply.code(404).send({ ok: false, rejection: { code: 'not-found', message: 'This Table Session is unavailable to this local identity.' } });
      if (replay === 'hand-not-found') return reply.code(404).send({ ok: false, rejection: { code: 'hand-not-found', message: 'This Hand is not a completed Hand of this table.' } });
      return replay;
    } catch (error) {
      if (error instanceof TableSessionRestorationError) return reply.code(503).send({ ok: false, rejection: { code: 'record-restoration-failed', message: error.message } });
      return reply.code(503).send({ ok: false, rejection: { code: 'persistence-unavailable', message: 'This Hand’s replay is unavailable. Refresh to try reading it again.' } });
    }
  });
  for (const kind of ['seat-participant', 'start-hand', 'act', 'stand-up-participant', 'move-participant', 'set-sitting-out', 'top-up-to', 'set-button', 'leave-table', 'remove-participant', 'add-bot', 'remove-bot'] as const) app.post<{ Params: { id: string }; Body: PokerMutationRequest }>('/api/table-sessions/:id/' + kind, async (request, reply) => {
    const userId = await authenticatedUser(request);
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
  for (const kind of ['set-playing-strategy', 'retry-bot', 'set-table-options'] as const) app.post<{ Params: { id: string }; Body: SetPlayingStrategyRequest | RetryBotRequest | SetTableOptionsRequest }>('/api/table-sessions/:id/' + kind, async (request, reply) => {
    const userId = await authenticatedUser(request);
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
    const userId = await authenticatedUser(request);
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
    const userId = await authenticatedUser(request);
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
    const userId = await authenticatedUser(request);
    if (!userId) return reply.code(401).send({ ok: false, rejection: { code: 'unauthenticated', message: 'Establish your local identity first.' } });
    try {
      const participantId = await participantAt(request.params.id, userId);
      const state = participantId && summaries.read(request.params.id, request.params.requestId, participantId);
      return state || reply.code(404).send({ ok: false, rejection: { code: 'not-found', message: 'This transient summary request is unavailable. Request a new snapshot explicitly.' } });
    } catch { return reply.code(503).send({ ok: false, rejection: { code: 'persistence-unavailable', message: 'The summary could not be read. Try reading it again.' } }); }
  });
  app.post<{ Params: { id: string }; Body: { strategy?: StrategyDescriptor } }>('/api/table-sessions/:id/session-summaries', async (request, reply) => {
    const userId = await authenticatedUser(request);
    if (!userId) return reply.code(401).send({ ok: false, rejection: { code: 'unauthenticated', message: 'Establish your local identity first.' } });
    if (!/^[0-9a-f-]{36}$/.test(request.params.id)) return reply.code(404).send({ ok: false, rejection: { code: 'not-found', message: 'This Table Session is unavailable.' } });
    if (request.body !== undefined && (!request.body || Array.isArray(request.body) || typeof request.body !== 'object' || Object.keys(request.body).some(key => key !== 'strategy'))) return reply.code(400).send({ ok: false, rejection: { code: 'invalid-summary-request', message: 'Session summaries capture the committed decisions. Supply an empty request, or only a Strategy to summarize them under.' } });
    if (request.body && 'strategy' in request.body && !(options.supportsStrategy ?? isSupportedStrategy)(request.body.strategy)) return reply.code(400).send({ ok: false, rejection: { code: 'unsupported-strategy', message: 'Choose a supported complete Strategy.' } });
    try {
      const input = await mutations.captureSessionSummary(request.params.id, userId, request.body?.strategy);
      if (!input) return reply.code(404).send({ ok: false, rejection: { code: 'not-found', message: 'This Table Session is unavailable.' } });
      const state = await summaries.create(input);
      return reply.code(state.status === 'error' && state.error.code === 'capacity' ? 503 : 200).send(state);
    } catch { return reply.code(503).send({ ok: false, rejection: { code: 'persistence-unavailable', message: 'The summary snapshot could not be captured.' } }); }
  });
  app.post<{ Params: { id: string }; Body: { handId: string; strategy?: StrategyDescriptor } }>('/api/table-sessions/:id/hand-summaries', async (request, reply) => {
    const userId = await authenticatedUser(request);
    if (!userId) return reply.code(401).send({ ok: false, rejection: { code: 'unauthenticated', message: 'Establish your local identity first.' } });
    if (!/^[0-9a-f-]{36}$/.test(request.params.id)) return reply.code(404).send({ ok: false, rejection: { code: 'not-found', message: 'This Table Session is unavailable.' } });
    if (!request.body || typeof request.body.handId !== 'string' || request.body.handId.length < 1 || request.body.handId.length > 128 || Object.keys(request.body).some(key => key !== 'handId' && key !== 'strategy')) return reply.code(400).send({ ok: false, rejection: { code: 'invalid-summary-request', message: 'Supply the Hand ID, and optionally a Strategy.' } });
    if ('strategy' in request.body && !(options.supportsStrategy ?? isSupportedStrategy)(request.body.strategy)) return reply.code(400).send({ ok: false, rejection: { code: 'unsupported-strategy', message: 'Choose a supported complete Strategy.' } });
    try {
      const input = await mutations.captureHandSummary(request.params.id, userId, request.body.handId, request.body.strategy);
      if (input === undefined) return reply.code(404).send({ ok: false, rejection: { code: 'not-found', message: 'This Table Session is unavailable.' } });
      if (input === null) return reply.code(400).send({ ok: false, rejection: { code: 'hand-unavailable', message: 'Choose an existing Hand.' } });
      const state = await summaries.create(input);
      return reply.code(state.status === 'error' && state.error.code === 'capacity' ? 503 : 200).send(state);
    } catch { return reply.code(503).send({ ok: false, rejection: { code: 'persistence-unavailable', message: 'The summary snapshot could not be captured.' } }); }
  });
  // `history: true` asks from Table History: the reader's own accepted decision, read like the history itself and
  // scheduled as `history-analysis`, behind all play and live study, under the reader's per-Guest bound.
  // `strategy` names a supported Strategy to analyze it under instead of the Guest's Reference Strategy (Counterfactual
  // Comparison): the same frozen inputs and seeds, its own result. It never changes the Guest's Trainer Configuration, and
  // it applies only to an accepted decision, so it cannot be combined with `live`.
  app.post<{ Params: { id: string }; Body: GetOrStartAnalysisRequest }>('/api/table-sessions/:id/analysis', async (request, reply) => {
    const userId = await authenticatedUser(request);
    if (!userId) return reply.code(401).send({ ok: false, rejection: { code: 'unauthenticated', message: 'Establish your local identity first.' } });
    if (!/^[0-9a-f-]{36}$/.test(request.params.id)) return reply.code(404).send({ ok: false, rejection: { code: 'not-found', message: 'This Table Session is unavailable.' } });
    if (!request.body || typeof request.body.decisionId !== 'string' || request.body.decisionId.length < 1 || request.body.decisionId.length > 128 || request.body.live !== undefined && request.body.live !== true || request.body.history !== undefined && request.body.history !== true || request.body.live && request.body.history || request.body.live && 'strategy' in request.body || Object.keys(request.body).some(key => !['decisionId', 'live', 'history', 'strategy'].includes(key))) return reply.code(400).send({ ok: false, rejection: { code: 'invalid-analysis-request', message: 'Supply a Decision ID and either an optional Live Analysis request or an optional history request, with an optional Strategy for an accepted decision.' } });
    if ('strategy' in request.body && !(options.supportsStrategy ?? isSupportedStrategy)(request.body.strategy)) return reply.code(400).send({ ok: false, rejection: { code: 'unsupported-strategy', message: 'Choose a supported complete Strategy.' } });
    try {
      if (request.body.history) {
        const input = await mutations.captureHistoryEvaluation(request.params.id, userId, request.body.decisionId, request.body.strategy);
        if (input === undefined) return reply.code(404).send({ ok: false, rejection: { code: 'not-found', message: 'This Table Session is unavailable.' } });
        if (input === null) return reply.code(400).send({ ok: false, rejection: { code: 'decision-unavailable', message: 'Choose one of your own accepted decisions.' } });
        const state = await analysis.getOrStart(input, { purpose: 'history-analysis', guestId: userId });
        return reply.code(state.status === 'error' && state.error.code === 'capacity' ? 503 : 200).send(state);
      }
      const input = await mutations.captureEvaluation(request.params.id, userId, request.body.decisionId, request.body.strategy);
      if (input === undefined) return reply.code(404).send({ ok: false, rejection: { code: 'not-found', message: 'This Table Session is unavailable.' } });
      if (input === null) return reply.code(400).send({ ok: false, rejection: { code: 'decision-unavailable', message: request.body.strategy ? 'Choose one of your own accepted decisions.' : 'Choose a current or accepted human decision.' } });
      if ('ok' in input) return reply.code(outcomeStatus(input)).send(input);
      const state = await analysis.getOrStart(input, request.body.live ? 'live-analysis' : 'interactive-analysis');
      return reply.code(state.status === 'error' && state.error.code === 'capacity' ? 503 : 200).send(state);
    } catch { return reply.code(503).send({ ok: false, rejection: { code: 'persistence-unavailable', message: 'Analysis could not be loaded. Try reading it again.' } }); }
  });
  app.post<{ Params: { id: string; requestId: string }; Body: Record<string, never> }>('/api/table-sessions/:id/analysis/:requestId/retry', async (request, reply) => {
    const userId = await authenticatedUser(request);
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
    const userId = await authenticatedUser(request);
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
    const userId = await authenticatedUser(request);
    if (!userId) return reply.code(401).send({ ok: false, rejection: { code: 'unauthenticated', message: 'Open the Trainer to establish your local identity.' } });
    if (!/^[0-9a-f-]{36}$/.test(request.params.id)) return reply.code(404).send({ ok: false, rejection: { code: 'not-found', message: 'This Table Session is unavailable.' } });
    if (options.adminMode !== true) return reply.code(403).send({ ok: false, rejection: { code: 'admin-mode-disabled', message: 'Completed-Hand inspection is disabled on this server.' } });
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
  let guestSweep: ReturnType<typeof startGuestSweep> | undefined;
  app.addHook('preClose', async () => { await guestSweep?.stop(); });
  try {
    // Hosted transports may bind with gated routes while waiting for authority.
    // No schema work, restoration, or Bot work is allowed before this gate.
    await options.beforeInitialize?.(app);
    await initializeDatabase(pool);
    await mutations.startRecovery();
    await mutations.loadScheduledTables();
    mutations.startClosingIdleTables();
    guestSweep = startGuestSweep(db, clock);
    return app;
  } catch (error) {
    await app.close().catch(() => {});
    throw error;
  }
}
