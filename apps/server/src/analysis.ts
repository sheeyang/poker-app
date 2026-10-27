import { createHash, randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { AnalysisUpdate, ConcreteAction, DecisionAnalysis, EvaluationIdentity, ReferenceStrategyEvaluation, StrategyDescriptor } from '@poker/contracts';
import { createStrategy, immutableData, type Strategy } from '@poker/strategies';
import { calculateActionProbabilities, calculateDecisionScores, scoringMethodVersion } from '@poker/research';
import type { ObservableGameView } from '@poker/contracts';
import { JobRunner, type JobHandle, type JobPurpose } from './job-runner.js';
import type { openDatabase } from './db/database.js';
import { analysisEvaluations, analysisScores } from './db/schema.js';
import { canonical } from './canonical.js';
import { executeStrategy } from './strategy-execution.js';
import type { AcceptTableJobResult } from './mutations.js';

export interface FrozenEvaluationInput { readonly ownerUserId: string; readonly identity: EvaluationIdentity; readonly view: ObservableGameView; readonly acceptedAction?: ConcreteAction }
export type AnalysisPurpose = Extract<JobPurpose, 'live-analysis' | 'interactive-analysis' | 'automatic-analysis' | 'summary-analysis'>;
function matchingKey(input: FrozenEvaluationInput): string {
  return createHash('sha256').update(canonical({ ...input.identity, ...(input.acceptedAction ? { scoredDecision: { acceptedAction: input.acceptedAction, scoringMethodVersion } } : {}) })).digest('hex');
}
type Database = ReturnType<typeof openDatabase>['db'];
interface Entry { readonly input: FrozenEvaluationInput; readonly purpose: AnalysisPurpose; state: DecisionAnalysis }
/** Owns matching, execution and successful retention, independently of connections and poker. */
export function createAnalysis(db: Database, runner: JobRunner, strategyFactory: (descriptor: StrategyDescriptor) => Strategy = createStrategy, publish: (ownerUserId: string, update: AnalysisUpdate) => void, acceptJobResult: AcceptTableJobResult) {
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
  function accept(entry: Entry, attemptId: string, operation: () => void = () => {}): Promise<boolean> {
    return acceptJobResult(entry.input.identity.tableSessionId, entry.input.ownerUserId, () => {
      if (stopped || entry.state.attemptId !== attemptId) return false;
      operation(); return true;
    });
  }
  async function initialize(input: FrozenEvaluationInput, fingerprint: string, purpose: AnalysisPurpose): Promise<Entry> {
    const stored = await db.select().from(analysisEvaluations).where(eq(analysisEvaluations.fingerprint, fingerprint));
    if (stopped) throw new Error('Analysis is closing.');
    const state: DecisionAnalysis = stored.at(0)?.result ?? { ok: true, ...input.identity, requestId: randomUUID(), attemptId: randomUUID(), status: 'pending' };
    const entry: Entry = { input: immutableData(input), purpose, state: immutableData(state) };
    entries.set(fingerprint, entry); byRequest.set(state.requestId, entry);
    if (state.status === 'complete') return entry;
    return start(entry, fingerprint);
  }
  async function start(entry: Entry, fingerprint: string): Promise<Entry> {
    const { input, state } = entry;
    const handle = runner.submit(entry.purpose, input, async (frozen, execution): Promise<ReferenceStrategyEvaluation> => {
      const { policyResult, selectedAction } = await executeStrategy(strategyFactory(frozen.identity.referenceStrategy), frozen.view, { evaluationSeed: frozen.identity.evaluationSeed, selectionSeed: frozen.identity.selectionSeed, signal: execution.signal });
      return { policyResult: { choices: policyResult.choices }, selectedAction, actionProbabilities: calculateActionProbabilities(frozen.view, policyResult.choices) };
    });
    settlements.set(state.attemptId, handle.settled);
    if (!handle.admitted) {
      const rejected = await handle.result;
      await accept(entry, state.attemptId, () => {
        if (!rejected.ok) entry.state = immutableData({ ...state, status: 'error', error: { code: rejected.code, message: 'The computation queue could not admit this evaluation.' } });
        notify(entry);
      });
      return entry;
    }
    const completion = handle.result.then(async result => {
      if (!await accept(entry, state.attemptId)) return;
      if (!result.ok) {
        await accept(entry, state.attemptId, () => {
          entry.state = immutableData({ ...state, status: 'error', error: { code: result.code, message: 'Reference Strategy evaluation could not complete.' } });
          notify(entry);
        });
        return;
      }
      const complete = immutableData({ ...state, status: 'complete' as const, evaluation: result.value });
      let terminal: DecisionAnalysis = complete;
      // Derived persistence is deliberately outside the Table Session queue.
      try {
        await db.insert(analysisEvaluations).values({ fingerprint, requestId: state.requestId, tableSessionId: input.identity.tableSessionId, ownerUserId: input.ownerUserId, result: complete });
      } catch {
        terminal = immutableData({ ...state, status: 'error', error: { code: 'persistence-unavailable', message: 'The evaluation result could not be saved.' } });
      }
      await accept(entry, state.attemptId, () => { entry.state = terminal; notify(entry); });
    });
    completions.add(completion); void completion.finally(() => completions.delete(completion));
    return entry;
  }
  async function initializeScore(input: FrozenEvaluationInput, fingerprint: string, purpose: AnalysisPurpose): Promise<Entry> {
    const stored = await db.select().from(analysisScores).where(eq(analysisScores.fingerprint, fingerprint));
    if (stopped) throw new Error('Analysis is closing.');
    const state: DecisionAnalysis = stored.at(0)?.result ?? { ok: true, ...input.identity, scoredDecision: { acceptedAction: input.acceptedAction!, scoringMethodVersion }, requestId: randomUUID(), attemptId: randomUUID(), status: 'pending' };
    const entry: Entry = { input: immutableData(input), purpose, state: immutableData(state) };
    scores.set(fingerprint, entry); byRequest.set(state.requestId, entry);
    if (state.status === 'complete') return entry;
    return startScore(entry, fingerprint);
  }
  async function startScore(entry: Entry, fingerprint: string, retryFailed = false): Promise<Entry> {
    const state = entry.state;
    const { acceptedAction: _action, ...evaluationInput } = entry.input;
    try {
      let dependency = await operations.getOrStart(evaluationInput, entry.purpose);
      if (retryFailed && dependency.status === 'error') dependency = (await operations.retry(state.tableSessionId, dependency.requestId, entry.input.ownerUserId))!;
      if (!await accept(entry, state.attemptId, () => { entry.state = immutableData({ ...state, evaluationRequestId: dependency.requestId }); })) return entry;
      let physical = Promise.resolve();
      const initialized = Promise.withResolvers<void>();
      const completion = completeScore(entry, fingerprint, dependency, handle => { physical = handle.settled; if (handle.admitted) initialized.resolve(); }).finally(initialized.resolve);
      settlements.set(state.attemptId, completion.then(async () => { await settlements.get(dependency.attemptId); await physical; }));
      completions.add(completion); void completion.finally(() => completions.delete(completion));
      // Await only known dependency failure or immediate score admission, never queued Strategy work.
      if (dependency.status !== 'pending') await initialized.promise;
    } catch {
      await accept(entry, state.attemptId, () => {
        entry.state = immutableData({ ...state, status: 'error', error: { code: 'persistence-unavailable', message: 'The evaluation dependency could not be loaded.' } });
        notify(entry);
      });
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
    const dependency = initial.status === 'pending' ? await waitForEvaluation(initial.requestId) : initial;
    if (!dependency || !await accept(entry, state.attemptId)) return;
    if (dependency.status === 'error') {
      await accept(entry, state.attemptId, () => { entry.state = immutableData({ ...state, status: 'error', error: dependency.error }); notify(entry); });
      return;
    }
    if (dependency.status !== 'complete') return;
    const input = entry.input;
    const handle = runner.submit(entry.purpose, { view: input.view, choices: dependency.evaluation.policyResult.choices, action: input.acceptedAction! }, frozen => calculateDecisionScores(frozen.view, frozen.choices, frozen.action));
    admitted(handle);
    const result = await handle.result;
    if (!await accept(entry, state.attemptId)) return;
    let terminal: DecisionAnalysis;
    if (!result.ok) terminal = immutableData({ ...state, status: 'error', error: { code: result.code, message: 'Decision scoring could not complete.' } });
    else {
      const complete = immutableData({ ...state, status: 'complete' as const, evaluation: dependency.evaluation, scores: result.value });
      terminal = complete;
      try {
        await db.insert(analysisScores).values({ fingerprint, requestId: state.requestId, tableSessionId: input.identity.tableSessionId, ownerUserId: input.ownerUserId, result: complete });
      } catch { terminal = immutableData({ ...state, status: 'error', error: { code: 'persistence-unavailable', message: 'The decision scores could not be saved.' } }); }
    }
    await accept(entry, state.attemptId, () => { entry.state = terminal; notify(entry); });
  }
  async function read(tableSessionId: string, requestId: string, ownerUserId: string): Promise<DecisionAnalysis | undefined> {
    const memory = byRequest.get(requestId);
    if (memory) return memory.input.ownerUserId === ownerUserId && memory.state.tableSessionId === tableSessionId ? memory.state : undefined;
    const rows = await db.select().from(analysisEvaluations).where(and(eq(analysisEvaluations.requestId, requestId), eq(analysisEvaluations.tableSessionId, tableSessionId), eq(analysisEvaluations.ownerUserId, ownerUserId)));
    if (rows[0]) return rows[0].result;
    const scored = await db.select().from(analysisScores).where(and(eq(analysisScores.requestId, requestId), eq(analysisScores.tableSessionId, tableSessionId), eq(analysisScores.ownerUserId, ownerUserId)));
    return scored[0]?.result;
  }
  async function lookup(input: FrozenEvaluationInput): Promise<DecisionAnalysis | undefined> {
    const fingerprint = matchingKey(input);
    const memory = (input.acceptedAction ? scores : entries).get(fingerprint);
    if (memory) return memory.state;
    const initializingEntry = (input.acceptedAction ? initializingScores : initializing).get(fingerprint);
    if (initializingEntry) return (await initializingEntry).state;
    const table = input.acceptedAction ? analysisScores : analysisEvaluations;
    const stored = await db.select().from(table).where(eq(table.fingerprint, fingerprint));
    if (stored[0]) return stored[0].result;
    if (input.acceptedAction) {
      const { acceptedAction: _action, ...evaluationInput } = input;
      const dependency = await lookup(evaluationInput);
      // A missing score still depends on this existing evaluation. Success needs bounded score admission.
      if (dependency && dependency.status !== 'complete') return dependency;
    }
    return undefined;
  }
  const operations = {
    lookup, matchingKey,
    async getOrStart(input: FrozenEvaluationInput, purpose: AnalysisPurpose = 'interactive-analysis'): Promise<DecisionAnalysis> {
      if (stopped) throw new Error('Analysis is closing.');
      if (input.acceptedAction) {
        const fingerprint = matchingKey(input);
        const pendingInitialization = initializingScores.get(fingerprint);
        if (pendingInitialization) return (await pendingInitialization).state;
        let entry = scores.get(fingerprint);
        if (!entry) {
          let operation = initializingScores.get(fingerprint);
          if (!operation) { operation = initializeScore(input, fingerprint, purpose); initializingScores.set(fingerprint, operation); }
          try { entry = await operation; } finally { if (initializingScores.get(fingerprint) === operation) initializingScores.delete(fingerprint); }
        }
        return entry.state;
      }
      const fingerprint = matchingKey(input);
      let entry = entries.get(fingerprint);
      if (!entry) {
        let operation = initializing.get(fingerprint);
        if (!operation) { operation = initialize(input, fingerprint, purpose); initializing.set(fingerprint, operation); }
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
        const fingerprint = matchingKey(entry.input);
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
