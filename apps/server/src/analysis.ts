import { createHash, randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { AnalysisUpdate, ConcreteAction, DecisionAnalysis, EvaluationIdentity, ReferenceStrategyEvaluation, StrategyDescriptor } from '@poker/contracts';
import { baselineStrategy, immutableData, validatePolicyResult, PolicyValidationError, type Strategy } from '@poker/strategies';
import type { ObservableGameView } from '@poker/contracts';
import { JobRunner, JobFailure } from './job-runner.js';
import type { openDatabase } from './db/database.js';
import { analysisEvaluations } from './db/schema.js';
import { canonical } from './canonical.js';

export interface FrozenEvaluationInput { readonly ownerUserId: string; readonly identity: EvaluationIdentity; readonly view: ObservableGameView }
type Database = ReturnType<typeof openDatabase>['db'];
interface Entry { readonly input: FrozenEvaluationInput; state: DecisionAnalysis }
/** Owns matching, execution and successful retention, independently of connections and poker. */
export function createAnalysis(db: Database, runner: JobRunner, strategyFactory: (descriptor: StrategyDescriptor) => Strategy = baselineStrategy, publish: (ownerUserId: string, update: AnalysisUpdate) => void = () => {}) {
  const entries = new Map<string, Entry>();
  const byRequest = new Map<string, Entry>();
  const initializing = new Map<string, Promise<Entry>>();
  const completions = new Set<Promise<void>>();
  let stopped = false;
  function notify(entry: Entry) {
    if (stopped || entry.state.status === 'pending') return;
    const state = entry.state;
    try { publish(entry.input.ownerUserId, { type: 'analysis-update', resource: 'analysis', tableSessionId: state.tableSessionId, requestId: state.requestId, attemptId: state.attemptId, status: state.status }); } catch { /* Delivery cannot change a readable result. */ }
  }
  async function initialize(input: FrozenEvaluationInput, fingerprint: string): Promise<Entry> {
    const stored = await db.select().from(analysisEvaluations).where(eq(analysisEvaluations.fingerprint, fingerprint));
    if (stopped) throw new Error('Analysis is closing.');
    const state: DecisionAnalysis = stored.at(0)?.result ?? { ok: true, ...input.identity, requestId: randomUUID(), attemptId: randomUUID(), status: 'pending' };
    const entry: Entry = { input: immutableData(input), state: immutableData(state) };
    entries.set(fingerprint, entry); byRequest.set(state.requestId, entry);
    if (state.status === 'complete') return entry;
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
      return { policyResult: { choices: policyResult.choices }, selectedAction };
    });
    if (!handle.admitted) {
      const rejected = await handle.result;
      if (!rejected.ok) entry.state = immutableData({ ...state, status: 'error', error: { code: rejected.code, message: 'The computation queue could not admit this evaluation.' } });
      notify(entry);
      return entry;
    }
    const completion = handle.result.then(async result => {
      if (stopped) return;
      if (!result.ok) {
        entry.state = immutableData({ ...state, status: 'error', error: { code: result.code, message: 'Reference Strategy evaluation could not complete.' } });
        notify(entry);
        return;
      }
      const complete = immutableData({ ...state, status: 'complete' as const, evaluation: result.value });
      try {
        await db.insert(analysisEvaluations).values({ fingerprint, requestId: state.requestId, tableSessionId: input.identity.tableSessionId, ownerUserId: input.ownerUserId, result: complete });
        if (!stopped) entry.state = complete;
      } catch {
        if (!stopped) entry.state = immutableData({ ...state, status: 'error', error: { code: 'persistence-unavailable', message: 'The evaluation result could not be saved.' } });
      }
      notify(entry);
    });
    completions.add(completion); void completion.finally(() => completions.delete(completion));
    return entry;
  }
  return {
    async getOrStart(input: FrozenEvaluationInput): Promise<DecisionAnalysis> {
      if (stopped) throw new Error('Analysis is closing.');
      const fingerprint = createHash('sha256').update(canonical(input.identity)).digest('hex');
      let entry = entries.get(fingerprint);
      if (!entry) {
        let operation = initializing.get(fingerprint);
        if (!operation) { operation = initialize(input, fingerprint); initializing.set(fingerprint, operation); }
        try { entry = await operation; } finally { if (initializing.get(fingerprint) === operation) initializing.delete(fingerprint); }
      }
      return entry.state;
    },
    async read(tableSessionId: string, requestId: string, ownerUserId: string): Promise<DecisionAnalysis | undefined> {
      const memory = byRequest.get(requestId);
      if (memory) return memory.input.ownerUserId === ownerUserId && memory.state.tableSessionId === tableSessionId ? memory.state : undefined;
      const rows = await db.select().from(analysisEvaluations).where(and(eq(analysisEvaluations.requestId, requestId), eq(analysisEvaluations.tableSessionId, tableSessionId), eq(analysisEvaluations.ownerUserId, ownerUserId)));
      return rows[0]?.result;
    },
    stop() { stopped = true; },
    async close() { stopped = true; await Promise.allSettled([...initializing.values()]); await Promise.allSettled([...completions]); },
  };
}
