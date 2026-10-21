import { createHash, randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { AnalysisUpdate, ConcreteAction, DecisionAnalysis, EvaluationIdentity, ReferenceStrategyEvaluation, StrategyDescriptor } from '@poker/contracts';
import { baselineStrategy, immutableData, validatePolicyResult, PolicyValidationError, type Strategy } from '@poker/strategies';
import { calculateActionProbabilities, calculateDecisionScores, scoringMethodVersion } from '@poker/research';
import type { ObservableGameView } from '@poker/contracts';
import { JobRunner, JobFailure, type JobHandle } from './job-runner.js';
import type { openDatabase } from './db/database.js';
import { analysisEvaluations, analysisScores } from './db/schema.js';
import { canonical } from './canonical.js';

export interface FrozenEvaluationInput { readonly ownerUserId: string; readonly identity: EvaluationIdentity; readonly view: ObservableGameView; readonly acceptedAction?: ConcreteAction }
type Database = ReturnType<typeof openDatabase>['db'];
interface Entry { readonly input: FrozenEvaluationInput; state: DecisionAnalysis }
/** Owns matching, execution and successful retention, independently of connections and poker. */
export function createAnalysis(db: Database, runner: JobRunner, strategyFactory: (descriptor: StrategyDescriptor) => Strategy = baselineStrategy, publish: (ownerUserId: string, update: AnalysisUpdate) => void = () => {}) {
  const entries = new Map<string, Entry>();
  const byRequest = new Map<string, Entry>();
  const initializing = new Map<string, Promise<Entry>>();
  const retrying = new Map<string, Promise<Entry>>();
  const completions = new Set<Promise<void>>();
  const settlements = new Map<string, Promise<void>>();
  const scores = new Map<string, Entry>();
  const initializingScores = new Map<string, Promise<Entry>>();
  const terminalWaiters = new Map<string, Set<(state: DecisionAnalysis) => void>>();
  const closing = Promise.withResolvers<void>();
  let stopped = false;
  function notify(entry: Entry) {
    if (stopped || entry.state.status === 'pending') return;
    const state = entry.state;
    for (const resolve of terminalWaiters.get(state.requestId) ?? []) resolve(state);
    terminalWaiters.delete(state.requestId);
    try { publish(entry.input.ownerUserId, { type: 'analysis-update', resource: 'analysis', tableSessionId: state.tableSessionId, requestId: state.requestId, attemptId: state.attemptId, status: state.status }); } catch { /* Delivery cannot change a readable result. */ }
  }
  async function initialize(input: FrozenEvaluationInput, fingerprint: string): Promise<Entry> {
    const stored = await db.select().from(analysisEvaluations).where(eq(analysisEvaluations.fingerprint, fingerprint));
    if (stopped) throw new Error('Analysis is closing.');
    const state: DecisionAnalysis = stored.at(0)?.result ?? { ok: true, ...input.identity, requestId: randomUUID(), attemptId: randomUUID(), status: 'pending' };
    const entry: Entry = { input: immutableData(input), state: immutableData(state) };
    entries.set(fingerprint, entry); byRequest.set(state.requestId, entry);
    if (state.status === 'complete') return entry;
    return start(entry, fingerprint);
  }
  async function start(entry: Entry, fingerprint: string): Promise<Entry> {
    const { input, state } = entry;
    const current = () => !stopped && entry.state.attemptId === state.attemptId;
    const handle = runner.submit('interactive-analysis', input, async (frozen, execution): Promise<ReferenceStrategyEvaluation> => {
      const strategy = strategyFactory(frozen.identity.referenceStrategy);
      if (!(await strategy.policy.checkCompatibility(frozen.view)).compatible) throw new JobFailure('incompatible');
      const raw = await strategy.policy.evaluate(frozen.view, { evaluationSeed: frozen.identity.evaluationSeed, signal: execution.signal });
      let policyResult;
      try { policyResult = validatePolicyResult(raw, frozen.view); } catch (error) { if (error instanceof PolicyValidationError) throw new JobFailure('invalid-policy'); throw error; }
      let selectedAction: ConcreteAction;
      try {
        selectedAction = strategy.actionSelector.select(policyResult.choices, { selectionSeed: frozen.identity.selectionSeed });
        if (!policyResult.choices.some(choice => canonical(choice.action) === canonical(selectedAction))) throw new Error('Not a Choice.');
      } catch { throw new JobFailure('selection-failed'); }
      return { policyResult: { choices: policyResult.choices }, selectedAction, actionProbabilities: calculateActionProbabilities(frozen.view, policyResult.choices) };
    });
    settlements.set(state.attemptId, handle.settled);
    if (!handle.admitted) {
      const rejected = await handle.result;
      if (current() && !rejected.ok) entry.state = immutableData({ ...state, status: 'error', error: { code: rejected.code, message: 'The computation queue could not admit this evaluation.' } });
      if (current()) notify(entry);
      return entry;
    }
    const completion = handle.result.then(async result => {
      if (!current()) return;
      if (!result.ok) {
        entry.state = immutableData({ ...state, status: 'error', error: { code: result.code, message: 'Reference Strategy evaluation could not complete.' } });
        notify(entry);
        return;
      }
      const complete = immutableData({ ...state, status: 'complete' as const, evaluation: result.value });
      try {
        await db.insert(analysisEvaluations).values({ fingerprint, requestId: state.requestId, tableSessionId: input.identity.tableSessionId, ownerUserId: input.ownerUserId, result: complete });
        if (current()) entry.state = complete;
      } catch {
        if (current()) entry.state = immutableData({ ...state, status: 'error', error: { code: 'persistence-unavailable', message: 'The evaluation result could not be saved.' } });
      }
      if (current()) notify(entry);
    });
    completions.add(completion); void completion.finally(() => completions.delete(completion));
    return entry;
  }
  async function initializeScore(input: FrozenEvaluationInput, fingerprint: string): Promise<Entry> {
    const stored = await db.select().from(analysisScores).where(eq(analysisScores.fingerprint, fingerprint));
    if (stopped) throw new Error('Analysis is closing.');
    const state: DecisionAnalysis = stored.at(0)?.result ?? { ok: true, ...input.identity, scoredDecision: { acceptedAction: input.acceptedAction!, scoringMethodVersion }, requestId: randomUUID(), attemptId: randomUUID(), status: 'pending' };
    const entry: Entry = { input: immutableData(input), state: immutableData(state) };
    scores.set(fingerprint, entry); byRequest.set(state.requestId, entry);
    if (state.status === 'complete') return entry;
    return startScore(entry, fingerprint);
  }
  async function startScore(entry: Entry, fingerprint: string, retryFailed = false): Promise<Entry> {
    const state = entry.state;
    const current = () => !stopped && entry.state.attemptId === state.attemptId;
    const { acceptedAction: _action, ...evaluationInput } = entry.input;
    try {
      let dependency = await operations.getOrStart(evaluationInput);
      if (retryFailed && dependency.status === 'error') dependency = (await operations.retry(state.tableSessionId, dependency.requestId, entry.input.ownerUserId))!;
      if (!current()) return entry;
      entry.state = immutableData({ ...state, evaluationRequestId: dependency.requestId });
      let physical = Promise.resolve();
      const completion = completeScore(entry, fingerprint, dependency, handle => { physical = handle.settled; });
      settlements.set(state.attemptId, completion.then(async () => { await settlements.get(dependency.attemptId); await physical; }));
      completions.add(completion); void completion.finally(() => completions.delete(completion));
    } catch {
      if (current()) {
        entry.state = immutableData({ ...state, status: 'error', error: { code: 'persistence-unavailable', message: 'The evaluation dependency could not be loaded.' } });
        notify(entry);
      }
    }
    return entry;
  }
  async function waitForEvaluation(requestId: string): Promise<DecisionAnalysis | undefined> {
    const current = byRequest.get(requestId)!.state;
    if (current.status !== 'pending') return current;
    const terminal = Promise.withResolvers<DecisionAnalysis>();
    const waiters = terminalWaiters.get(requestId) ?? new Set();
    terminalWaiters.set(requestId, waiters); waiters.add(terminal.resolve);
    try { return await Promise.race([terminal.promise, closing.promise.then(() => undefined)]); }
    finally { waiters.delete(terminal.resolve); if (!waiters.size) terminalWaiters.delete(requestId); }
  }
  async function completeScore(entry: Entry, fingerprint: string, initial: DecisionAnalysis, admitted: (handle: JobHandle<unknown>) => void): Promise<void> {
    const state = entry.state;
    const current = () => !stopped && entry.state.attemptId === state.attemptId;
    const dependency = initial.status === 'pending' ? await waitForEvaluation(initial.requestId) : initial;
    if (!dependency || !current()) return;
    if (dependency.status === 'error') { entry.state = immutableData({ ...state, status: 'error', error: dependency.error }); notify(entry); return; }
    if (dependency.status !== 'complete') return;
    const input = entry.input;
    const handle = runner.submit('interactive-analysis', { view: input.view, choices: dependency.evaluation.policyResult.choices, action: input.acceptedAction! }, frozen => calculateDecisionScores(frozen.view, frozen.choices, frozen.action));
    admitted(handle);
    const result = await handle.result;
    if (!current()) return;
    if (!result.ok) entry.state = immutableData({ ...state, status: 'error', error: { code: result.code, message: 'Decision scoring could not complete.' } });
    else {
      const complete = immutableData({ ...state, status: 'complete' as const, evaluation: dependency.evaluation, scores: result.value });
      try {
        await db.insert(analysisScores).values({ fingerprint, requestId: state.requestId, tableSessionId: input.identity.tableSessionId, ownerUserId: input.ownerUserId, result: complete });
        if (current()) entry.state = complete;
      } catch { if (current()) entry.state = immutableData({ ...state, status: 'error', error: { code: 'persistence-unavailable', message: 'The decision scores could not be saved.' } }); }
    }
    if (current()) notify(entry);
  }
  async function read(tableSessionId: string, requestId: string, ownerUserId: string): Promise<DecisionAnalysis | undefined> {
    const memory = byRequest.get(requestId);
    if (memory) return memory.input.ownerUserId === ownerUserId && memory.state.tableSessionId === tableSessionId ? memory.state : undefined;
    const rows = await db.select().from(analysisEvaluations).where(and(eq(analysisEvaluations.requestId, requestId), eq(analysisEvaluations.tableSessionId, tableSessionId), eq(analysisEvaluations.ownerUserId, ownerUserId)));
    if (rows[0]) return rows[0].result;
    const scored = await db.select().from(analysisScores).where(and(eq(analysisScores.requestId, requestId), eq(analysisScores.tableSessionId, tableSessionId), eq(analysisScores.ownerUserId, ownerUserId)));
    return scored[0]?.result;
  }
  const operations = {
    async getOrStart(input: FrozenEvaluationInput): Promise<DecisionAnalysis> {
      if (stopped) throw new Error('Analysis is closing.');
      if (input.acceptedAction) {
        const fingerprint = createHash('sha256').update(canonical({ ...input.identity, scoredDecision: { acceptedAction: input.acceptedAction, scoringMethodVersion } })).digest('hex');
        let entry = scores.get(fingerprint);
        if (!entry) {
          let operation = initializingScores.get(fingerprint);
          if (!operation) { operation = initializeScore(input, fingerprint); initializingScores.set(fingerprint, operation); }
          try { entry = await operation; } finally { if (initializingScores.get(fingerprint) === operation) initializingScores.delete(fingerprint); }
        }
        return entry.state;
      }
      const fingerprint = createHash('sha256').update(canonical(input.identity)).digest('hex');
      let entry = entries.get(fingerprint);
      if (!entry) {
        let operation = initializing.get(fingerprint);
        if (!operation) { operation = initialize(input, fingerprint); initializing.set(fingerprint, operation); }
        try { entry = await operation; } finally { if (initializing.get(fingerprint) === operation) initializing.delete(fingerprint); }
      }
      return entry.state;
    },
    read,
    async waitForSettlement(tableSessionId: string, requestId: string, ownerUserId: string, attemptId: string): Promise<void> {
      const entry = byRequest.get(requestId);
      if (!entry || entry.input.ownerUserId !== ownerUserId || entry.state.tableSessionId !== tableSessionId) return;
      await settlements.get(attemptId);
    },
    async waitForResult(tableSessionId: string, requestId: string, ownerUserId: string): Promise<DecisionAnalysis | undefined> {
      const state = await read(tableSessionId, requestId, ownerUserId);
      if (!state || state.status !== 'pending') return state;
      return waitForEvaluation(requestId);
    },
    async retry(tableSessionId: string, requestId: string, ownerUserId: string): Promise<DecisionAnalysis | undefined> {
      if (stopped) throw new Error('Analysis is closing.');
      const entry = byRequest.get(requestId);
      if (!entry) return read(tableSessionId, requestId, ownerUserId);
      if (entry.input.ownerUserId !== ownerUserId || entry.state.tableSessionId !== tableSessionId) return undefined;
      let operation = retrying.get(requestId);
      if (!operation) {
        if (entry.state.status !== 'error') return entry.state;
        // Inputs and matching identity remain frozen; only execution gets a new identity.
        const scoredDecision = entry.input.acceptedAction ? { acceptedAction: entry.input.acceptedAction, scoringMethodVersion } : undefined;
        entry.state = immutableData({ ok: true, ...entry.input.identity, ...(scoredDecision ? { scoredDecision } : {}), requestId, attemptId: randomUUID(), status: 'pending' });
        const fingerprint = createHash('sha256').update(canonical({ ...entry.input.identity, ...(scoredDecision ? { scoredDecision } : {}) })).digest('hex');
        operation = scoredDecision ? startScore(entry, fingerprint, true) : start(entry, fingerprint); retrying.set(requestId, operation);
      }
      try { return (await operation).state; }
      finally { if (retrying.get(requestId) === operation) retrying.delete(requestId); }
    },
    stop() { stopped = true; closing.resolve(); },
    async close() { operations.stop(); await Promise.allSettled([...initializing.values(), ...initializingScores.values(), ...retrying.values()]); await Promise.allSettled([...completions]); },
  };
  return operations;
}
