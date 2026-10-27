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
import type { AnalysisUpdate, ServerLiveMessage, ClientLiveMessage, TableLiveMessage, CreateTableSessionRequest, PokerMutationRequest, StrategyDescriptor, SetPlayingStrategyRequest, SetTrainerConfigurationRequest, RetryBotRequest } from '@poker/contracts';
import { openDatabase, initializeDatabase } from './db/database.js';
import { localUsers, tableSessions } from './db/schema.js';
import { createTableSessionMutations, TableSessionRestorationError, type MutationTransactionFaults, type TableSessionControllerCommands } from './mutations.js';
import { createTableSessionCreator, CommitOutcomeUnknown, type CreationTransactionFaults } from './creation.js';
import { AcceptanceTransactions } from './db/acceptance.js';

export interface ServerOptions { readonly databaseUrl: string; readonly schema?: string; readonly logger?: boolean; readonly secureCookies?: boolean; readonly beforeInitialize?: (app: FastifyInstance) => Promise<void>; readonly transactionFaults?: CreationTransactionFaults; readonly mutationTransactionFaults?: MutationTransactionFaults; readonly adminMode?: boolean; readonly automaticBots?: boolean; readonly jobRunnerOptions?: JobRunnerOptions; readonly strategyFactory?: (descriptor: StrategyDescriptor) => Strategy; readonly supportsStrategy?: (descriptor: unknown) => boolean; readonly onControllerCommandsReady?: (commands: TableSessionControllerCommands) => void }
export async function createServer(options: ServerOptions) {
  const app = Fastify({ logger: options.logger ?? false });
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
  const acceptance = new AcceptanceTransactions(pool, options.databaseUrl, options.schema);
  const create = createTableSessionCreator(db, acceptance, options.transactionFaults, options.supportsStrategy ?? isSupportedStrategy);
  const jobRunner = new JobRunner(options.jobRunnerOptions);
  const mutations = createTableSessionMutations(db, acceptance, options.mutationTransactionFaults, { runner: jobRunner, automaticBots: options.automaticBots, adminMode: options.adminMode, strategyFactory: options.strategyFactory, supportsStrategy: options.supportsStrategy, onHumanActionAccepted: input => analysis.getOrStart(input, 'automatic-analysis') });
  options.onControllerCommandsReady?.({ submitAction: mutations.submitControllerAction, readPersistedSession: mutations.readPersistedSession });
  const analysis = createAnalysis(db, jobRunner, options.strategyFactory, publishUserUpdate, mutations.acceptJobResult);
  const summaries = createScoreSummaries(analysis, jobRunner, publishUserUpdate, mutations.acceptJobResult);
  app.addHook('preClose', async () => { closing = true; acceptance.stop(); mutations.stop(); summaries.stop(); analysis.stop(); });
  app.addHook('onClose', async () => { await mutations.close(); await analysis.close(); await pool.end(); await acceptance.close(); });
  const socketOwners = new WeakMap<FastifyRequest, string>();
  // The user channel is independent of open table subscriptions. Analysis publishes here
  // only after establishing the request owner's authorization and making HTTP state readable.
  const userChannels = new Map<string, Set<(message: ServerLiveMessage) => void>>();
  function publishUserUpdate(userId: string, message: AnalysisUpdate) {
    for (const deliver of userChannels.get(userId) ?? []) deliver(message);
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
  app.get('/api/identity', async (request, reply) => { await ensureIdentity(request, reply); return { ok: true }; });
  app.post<{ Body: CreateTableSessionRequest }>('/api/table-sessions', async (request, reply) => {
    const ownerUserId = await ensureIdentity(request, reply);
    if (typeof request.body?.requestId !== 'string' || request.body.requestId.length < 1 || request.body.requestId.length > 128)
      return reply.code(400).send({ ok: false, rejection: { code: 'invalid-request-id', message: 'Supply a requestId from 1 to 128 characters.' } });
    try {
      const result = await create(ownerUserId, request.body);
      return reply.code(result.ok ? 201 : result.rejection.code === 'request-id-conflict' ? 409 : result.rejection.code === 'commit-not-applied' ? 503 : 400).send(result);
    } catch (error) {
      if (error instanceof CommitOutcomeUnknown) return reply.code(503).send({ ok: false, rejection: { code: 'commit-outcome-unknown', message: 'The creation commit outcome is unknown. Check owned sessions or explicitly retry this requestId to resolve it.' } });
      return reply.code(503).send({ ok: false, rejection: { code: 'persistence-unavailable', message: 'Creation could not be confirmed. No definitive domain rejection has been stored.' } });
    }
  });
  app.get('/api/table-sessions', async (request, reply) => {
    const userId = await authenticatedUser(request.cookies.poker_local);
    if (!userId) return reply.code(401).send({ ok: false, rejection: { code: 'unauthenticated', message: 'Open the Trainer to establish your local identity.' } });
    const rows = await db.select({ id: tableSessions.id }).from(tableSessions).where(eq(tableSessions.ownerUserId, userId));
    return { tableSessionIds: rows.map(row => row.id) };
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
  for (const kind of ['seat-participant', 'start-hand', 'act', 'leave-participant', 'move-participant', 'set-sitting-out', 'top-up-to', 'set-button'] as const) app.post<{ Params: { id: string }; Body: PokerMutationRequest }>('/api/table-sessions/:id/' + kind, async (request, reply) => {
    const userId = await authenticatedUser(request.cookies.poker_local);
    if (!userId) return reply.code(401).send({ ok: false, rejection: { code: 'unauthenticated', message: 'Open the Trainer to establish your local identity.' } });
    if (!/^[0-9a-f-]{36}$/.test(request.params.id)) return reply.code(404).send({ ok: false, rejection: { code: 'not-found', message: 'This Table Session is unavailable.' } });
    if (typeof request.body?.requestId !== 'string' || request.body.requestId.length < 1 || request.body.requestId.length > 128)
      return reply.code(400).send({ ok: false, rejection: { code: 'invalid-request-id', message: 'Supply a requestId from 1 to 128 characters.' } });
    try {
      const outcome = await mutations.submit(request.params.id, userId, kind, request.body);
      return reply.code(outcome.ok ? 200 : outcome.rejection.code === 'not-found' ? 404 : outcome.rejection.code === 'actor-not-authorized' ? 403 : ['session-recovering', 'commit-not-applied'].includes(outcome.rejection.code) ? 503 : ['request-id-conflict', 'stale-poker-revision'].includes(outcome.rejection.code) ? 409 : 400).send(outcome);
    } catch (error) {
      if (error instanceof TableSessionRestorationError) return reply.code(503).send({ ok: false, rejection: { code: 'record-restoration-failed', message: error.message } });
      if (error instanceof CommitOutcomeUnknown) return reply.code(503).send({ ok: false, rejection: { code: 'commit-outcome-unknown', message: 'The commit outcome is unknown. This Table Session is paused pending durable recovery.' } });
      return reply.code(503).send({ ok: false, rejection: { code: 'persistence-unavailable', message: 'The mutation could not be confirmed. Refresh the committed view before submitting another attempt.' } });
    }
  });
  for (const kind of ['set-playing-strategy', 'retry-bot', 'set-trainer-configuration'] as const) app.post<{ Params: { id: string }; Body: SetPlayingStrategyRequest | RetryBotRequest | SetTrainerConfigurationRequest }>('/api/table-sessions/:id/' + kind, async (request, reply) => {
    const userId = await authenticatedUser(request.cookies.poker_local);
    if (!userId) return reply.code(401).send({ ok: false, rejection: { code: 'unauthenticated', message: 'Open the Trainer to establish your local identity.' } });
    if (!/^[0-9a-f-]{36}$/.test(request.params.id)) return reply.code(404).send({ ok: false, rejection: { code: 'not-found', message: 'This Table Session is unavailable.' } });
    if (typeof request.body?.requestId !== 'string' || request.body.requestId.length < 1 || request.body.requestId.length > 128) return reply.code(400).send({ ok: false, rejection: { code: 'invalid-request-id', message: 'Supply a requestId from 1 to 128 characters.' } });
    try {
      const outcome = await mutations.configure(request.params.id, userId, kind, request.body);
      return reply.code(outcome.ok ? 200 : outcome.rejection.code === 'not-found' ? 404 : ['session-recovering', 'commit-not-applied'].includes(outcome.rejection.code) ? 503 : ['request-id-conflict', 'stale-session-revision'].includes(outcome.rejection.code) ? 409 : 400).send(outcome);
    } catch (error) {
      if (error instanceof TableSessionRestorationError) return reply.code(503).send({ ok: false, rejection: { code: 'record-restoration-failed', message: error.message } });
      if (error instanceof CommitOutcomeUnknown) return reply.code(503).send({ ok: false, rejection: { code: 'commit-outcome-unknown', message: 'The configuration commit outcome is unknown. This Table Session is paused pending durable recovery.' } });
      return reply.code(503).send({ ok: false, rejection: { code: 'persistence-unavailable', message: 'The configuration change could not be confirmed. Refresh its committed view.' } });
    }
  });
  app.post<{ Params: { id: string; requestId: string }; Body: Record<string, never> }>('/api/table-sessions/:id/summaries/:requestId/retry', async (request, reply) => {
    const userId = await authenticatedUser(request.cookies.poker_local);
    if (!userId) return reply.code(401).send({ ok: false, rejection: { code: 'unauthenticated', message: 'Establish your local identity first.' } });
    if (request.body !== undefined && (!request.body || Array.isArray(request.body) || typeof request.body !== 'object' || Object.keys(request.body).length)) return reply.code(400).send({ ok: false, rejection: { code: 'invalid-summary-request', message: 'Retry uses the captured summary. Supply an empty request.' } });
    try {
      const state = await summaries.retry(request.params.id, request.params.requestId, userId);
      if (!state) return reply.code(404).send({ ok: false, rejection: { code: 'not-found', message: 'This transient summary request is unavailable. Request a new snapshot explicitly.' } });
      return reply.code(state.status === 'error' && state.error.code === 'capacity' ? 503 : 200).send(state);
    } catch { return reply.code(503).send({ ok: false, rejection: { code: 'persistence-unavailable', message: 'The summary could not be retried. Read its state before trying again.' } }); }
  });
  app.get<{ Params: { id: string; requestId: string } }>('/api/table-sessions/:id/summaries/:requestId', async (request, reply) => {
    const userId = await authenticatedUser(request.cookies.poker_local);
    if (!userId) return reply.code(401).send({ ok: false, rejection: { code: 'unauthenticated', message: 'Establish your local identity first.' } });
    const state = summaries.read(request.params.id, request.params.requestId, userId);
    return state ?? reply.code(404).send({ ok: false, rejection: { code: 'not-found', message: 'This transient summary request is unavailable. Request a new snapshot explicitly.' } });
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
      const state = await analysis.retry(request.params.id, request.params.requestId, userId);
      if (!state) return reply.code(404).send({ ok: false, rejection: { code: 'not-found', message: 'This analysis is unavailable.' } });
      return reply.code(state.status === 'error' && state.error.code === 'capacity' ? 503 : 200).send(state);
    } catch { return reply.code(503).send({ ok: false, rejection: { code: 'persistence-unavailable', message: 'Analysis could not be retried. Try reading it again.' } }); }
  });
  app.get<{ Params: { id: string; requestId: string } }>('/api/table-sessions/:id/analysis/:requestId', async (request, reply) => {
    const userId = await authenticatedUser(request.cookies.poker_local);
    if (!userId) return reply.code(401).send({ ok: false, rejection: { code: 'unauthenticated', message: 'Establish your local identity first.' } });
    if (!/^[0-9a-f-]{36}$/.test(request.params.id) || !/^[0-9a-f-]{36}$/.test(request.params.requestId)) return reply.code(404).send({ ok: false, rejection: { code: 'not-found', message: 'This analysis is unavailable.' } });
    try {
      const state = await analysis.read(request.params.id, request.params.requestId, userId);
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
      const input = await loadCompletedHandInspection(request.params.id, request.body.handId, async id => {
        // Load authorized durable inputs; reconstruction belongs to the admitted Research job.
        const owned = await db.select({ aggregate: tableSessions.aggregate }).from(tableSessions).where(and(eq(tableSessions.id, id), eq(tableSessions.ownerUserId, userId)));
        const aggregate = owned[0]?.aggregate;
        return aggregate?.ownerUserId === userId ? { pokerRecord: aggregate.pokerRecord } : undefined;
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
    await mutations.resumeBots();
    return app;
  } catch (error) {
    await app.close().catch(() => {});
    throw error;
  }
}
