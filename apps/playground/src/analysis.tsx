import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DecisionAnalysis, ObservableTableSession, ConcreteAction } from '@poker/contracts';
import type { LiveConsumers } from './live.js';
import { api, RequestFailure } from './api.js';

function identity(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(identity).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + identity((value as Record<string, unknown>)[key])).join(',') + '}';
  return JSON.stringify(value);
}
interface Target {
  readonly key: string; readonly tableId: string; readonly decisionId: string;
  wanted: boolean; dirty: number; fetching: boolean; retired: boolean; data?: DecisionAnalysis;
}
/** Reconciliation remembers notifications received while an older HTTP response is in flight. */
export function useDecisionAnalysis(table: ObservableTableSession | undefined) {
  const decisionId = table?.view.state.legalActions.length ? table.view.state.decisionId : undefined;
  const key = table && decisionId ? identity([table.tableSessionId, decisionId, table.trainerConfiguration.referenceStrategy]) : '';
  const target = useMemo<Target | null>(() => key && table && decisionId ? { key, tableId: table.tableSessionId, decisionId, wanted: false, dirty: 0, fetching: false, retired: false } : null, [key]);
  const current = useRef(target); current.current = target;
  const connection = useRef<number | null>(null);
  const [display, setDisplay] = useState<{ key: string; loading: boolean; data?: DecisionAnalysis; error?: string }>();
  useEffect(() => { if (target) target.retired = false; return () => { if (target) target.retired = true; }; }, [target]);
  const reconcile = useCallback(async (active: Target) => {
    if (active.fetching || active.retired || current.current !== active || !active.wanted) return;
    active.fetching = true;
    const initialConnection = connection.current;
    try {
      do {
        active.dirty = 0;
        const generation = connection.current;
        setDisplay({ key: active.key, loading: true, data: active.data });
        try {
          const data = active.data ? await api.readAnalysis(active.tableId, active.data.requestId) : await api.getOrStartAnalysis(active.tableId, active.decisionId);
          if (active.retired || current.current !== active) return;
          if (connection.current !== generation) { active.dirty++; continue; }
          if (identity([data.tableSessionId, data.decisionId, data.referenceStrategy]) !== active.key) return;
          // An exact read cannot replace a request/attempt installed by a newer operation.
          if (active.data && (data.requestId !== active.data.requestId || data.attemptId !== active.data.attemptId)) continue;
          active.data = data;
          setDisplay({ key: active.key, loading: false, data });
        } catch (error) {
          if (active.retired || current.current !== active) return;
          if (connection.current !== generation) { active.dirty++; continue; }
          if (error instanceof RequestFailure && error.code === 'not-found' && active.data) { active.data = undefined; active.dirty++; continue; }
          setDisplay({ key: active.key, loading: false, data: active.data, error: error instanceof Error ? error.message : 'The evaluation could not be read.' });
        }
      } while (active.dirty > 0 && (connection.current !== null || initialConnection === null) && !active.retired && current.current === active);
    } finally { active.fetching = false; }
  }, []);
  const refresh = useCallback(() => {
    const active = current.current;
    if (!active || !active.wanted) return;
    active.dirty++;
    void reconcile(active);
  }, [reconcile]);
  const consumers: LiveConsumers = {
    onReady: lifecycle => { connection.current = lifecycle.generation; refresh(); },
    onAnalysisUpdate: (update, lifecycle) => {
      const active = current.current;
      if (!active?.wanted || update.resource !== 'analysis' || update.tableSessionId !== active.tableId || lifecycle.generation !== connection.current) return;
      // Before the first HTTP response, retain the need to reconcile this table's notification.
      if (active.data && (update.requestId !== active.data.requestId || update.attemptId !== active.data.attemptId)) return;
      refresh();
    },
  };
  const connectionChanged = useCallback((generation: number | null) => {
    if (connection.current === generation) return;
    connection.current = generation;
    if (generation !== null) refresh();
    else if (current.current?.wanted) current.current.dirty++;
  }, [refresh]);
  return {
    consumers, connectionChanged,
    canEvaluate: !!target,
    display: display?.key === key ? display : undefined,
    evaluate: () => { if (!target) return; target.wanted = true; target.dirty++; void reconcile(target); },
  };
}
const actionLabel = (action: ConcreteAction) => action.type === 'bet' ? 'Bet-to ' + action.betTo : action.type === 'raise' ? 'Raise-to ' + action.raiseTo : action.type[0]!.toUpperCase() + action.type.slice(1);
export function DecisionAnalysisControls({ analysis }: { analysis: ReturnType<typeof useDecisionAnalysis> }) {
  const { display } = analysis;
  const data = display?.data;
  return <section className="decision-analysis" aria-labelledby="decision-analysis-heading">
    <h3 id="decision-analysis-heading">Reference Strategy Evaluation</h3>
    <p className="help">Inspect the current human decision using the committed Reference Strategy. Play remains available while evaluation runs.</p>
    <button disabled={!analysis.canEvaluate || display?.loading} onClick={analysis.evaluate}>Evaluate current decision</button>
    {!analysis.canEvaluate && <p className="help">A current human decision is required.</p>}
    {(display?.loading || data?.status === 'pending') && <p role="status">Evaluating the Reference Strategy…</p>}
    {display?.error && <p role="alert" className="error">{display.error}</p>}
    {data?.status === 'error' && <p role="alert" className="error">Evaluation error: {data.error.code}. {data.error.message}</p>}
    {data?.status === 'complete' && <div className="evaluation-result">
      <p><strong>Selected concrete action:</strong> {actionLabel(data.evaluation.selectedAction)}</p>
      <table className="evaluation-choices"><caption>Policy distribution · {data.decisionId}</caption><thead><tr><th scope="col">Concrete choice</th><th scope="col">Probability</th></tr></thead><tbody>{data.evaluation.policyResult.choices.map(choice => <tr key={actionLabel(choice.action)}><td>{actionLabel(choice.action)}</td><td>{choice.probability.toFixed(6)}</td></tr>)}</tbody></table>
    </div>}
  </section>;
}
