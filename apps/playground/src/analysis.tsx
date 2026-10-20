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
  wanted: boolean; dirty: number; signals: number; version: number; retrying: boolean; obsoleteAttempts: Set<string>; fetching: boolean; retired: boolean; data?: DecisionAnalysis;
}
/** Reconciliation remembers notifications received while an older HTTP response is in flight. */
export function useDecisionAnalysis(table: ObservableTableSession | undefined) {
  const [selection, setSelection] = useState<{ tableId: string; decisionId: string }>();
  const human = table?.bindings.find(binding => binding.controller.kind === 'human')?.participantId;
  const acceptedDecisions = table?.view.history.flatMap(hand => hand.decisions.filter(decision => decision.action.participantId === human).map(decision => ({ decisionId: decision.decisionId, action: decision.action.action }))) ?? [];
  const selectedDecisionId = selection && selection.tableId === table?.tableSessionId && acceptedDecisions.some(decision => decision.decisionId === selection.decisionId) ? selection.decisionId : '';
  const accepted = acceptedDecisions.find(decision => decision.decisionId === selectedDecisionId);
  const decisionId = selectedDecisionId || (table?.view.state.legalActions.length ? table.view.state.decisionId : undefined);
  const key = table && decisionId ? identity([table.tableSessionId, decisionId, table.trainerConfiguration.referenceStrategy, accepted?.action ?? null]) : '';
  const target = useMemo<Target | null>(() => key && table && decisionId ? { key, tableId: table.tableSessionId, decisionId, wanted: false, dirty: 0, signals: 0, version: 0, retrying: false, obsoleteAttempts: new Set(), fetching: false, retired: false } : null, [key]);
  const current = useRef(target); current.current = target;
  const connection = useRef<number | null>(null);
  const [display, setDisplay] = useState<{ key: string; loading: boolean; retrying?: boolean; data?: DecisionAnalysis; error?: string }>();
  useEffect(() => { if (target) target.retired = false; return () => { if (target) target.retired = true; }; }, [target]);
  const reconcile = useCallback(async (active: Target): Promise<void> => {
    if (active.fetching || active.retrying || active.retired || current.current !== active || !active.wanted) return;
    active.fetching = true;
    const initialConnection = connection.current;
    try {
      do {
        active.dirty = 0;
        const generation = connection.current;
        const version = active.version;
        const signals = active.signals;
        setDisplay({ key: active.key, loading: true, data: active.data });
        try {
          const data = active.data ? await api.readAnalysis(active.tableId, active.data.requestId) : await api.getOrStartAnalysis(active.tableId, active.decisionId);
          if (active.retired || current.current !== active) return;
          if (connection.current !== generation) { active.dirty++; continue; }
          if (identity([data.tableSessionId, data.decisionId, data.referenceStrategy, data.scoredDecision?.acceptedAction ?? null]) !== active.key) return;
          if (version !== active.version || signals !== active.signals) { active.dirty++; continue; }
          if (active.data && data.requestId !== active.data.requestId) continue;
          if (active.obsoleteAttempts.has(data.attemptId)) continue;
          // Exact-request reads are authoritative, including Retry started in another tab.
          if (active.data && data.attemptId !== active.data.attemptId) active.obsoleteAttempts.add(active.data.attemptId);
          active.data = data;
          setDisplay({ key: active.key, loading: false, data });
        } catch (error) {
          if (active.retired || current.current !== active) return;
          if (connection.current !== generation) { active.dirty++; continue; }
          if (version !== active.version || signals !== active.signals) { active.dirty++; continue; }
          if (error instanceof RequestFailure && error.code === 'not-found' && active.data) { active.data = undefined; active.dirty++; continue; }
          setDisplay({ key: active.key, loading: false, data: active.data, error: error instanceof Error ? error.message : 'The evaluation could not be read.' });
        }
      } while (active.dirty > 0 && (connection.current !== null || initialConnection === null) && !active.retrying && !active.retired && current.current === active);
    } finally {
      active.fetching = false;
      if (active.dirty > 0 && !active.retrying && !active.retired && current.current === active && (connection.current !== null || initialConnection === null)) void reconcile(active);
    }
  }, []);
  const refresh = useCallback(() => {
    const active = current.current;
    if (!active || !active.wanted) return;
    active.dirty++; active.signals++;
    void reconcile(active);
  }, [reconcile]);
  const consumers: LiveConsumers = {
    onReady: lifecycle => { connection.current = lifecycle.generation; refresh(); },
    onAnalysisUpdate: (update, lifecycle) => {
      const active = current.current;
      if (!active?.wanted || update.resource !== 'analysis' || update.tableSessionId !== active.tableId || lifecycle.generation !== connection.current) return;
      // Before the first HTTP response, retain the need to reconcile this table's notification.
      if (active.data && update.requestId !== active.data.requestId) return;
      if (active.obsoleteAttempts.has(update.attemptId)) return;
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
    acceptedDecisions, selectedDecisionId,
    selectDecision: (id: string) => { if (table) setSelection({ tableId: table.tableSessionId, decisionId: id }); },
    canEvaluate: !!target,
    display: display?.key === key ? display : undefined,
    retry: async () => {
      const active = current.current;
      if (!active?.data || active.data.status !== 'error' || active.retrying || active.retired) return;
      const requestId = active.data.requestId;
      const version = ++active.version;
      const signals = active.signals;
      const generation = connection.current;
      active.retrying = true;
      setDisplay({ key: active.key, loading: false, retrying: true, data: active.data });
      try {
        const data = await api.retryAnalysis(active.tableId, requestId);
        if (active.retired || current.current !== active || version !== active.version) return;
        if (connection.current !== generation || signals !== active.signals) { active.dirty++; return; }
        if (data.requestId !== requestId || active.obsoleteAttempts.has(data.attemptId)) return;
        if (active.data.attemptId !== data.attemptId) active.obsoleteAttempts.add(active.data.attemptId);
        active.data = data;
        setDisplay({ key: active.key, loading: false, data });
      } catch (error) {
        if (active.retired || current.current !== active || version !== active.version) return;
        if (connection.current !== generation || signals !== active.signals) { active.dirty++; return; }
        setDisplay({ key: active.key, loading: false, data: active.data, error: error instanceof Error ? error.message : 'The evaluation could not be retried.' });
      } finally {
        active.retrying = false;
        if (!active.retired && current.current === active) {
          setDisplay(previous => previous?.key === active.key ? { ...previous, retrying: false } : previous);
          if (active.dirty > 0) void reconcile(active);
        }
      }
    },
    evaluate: () => { if (!target) return; target.wanted = true; target.dirty++; void reconcile(target); },
  };
}
const actionLabel = (action: ConcreteAction) => action.type === 'bet' ? 'Bet-to ' + action.betTo : action.type === 'raise' ? 'Raise-to ' + action.raiseTo : action.type[0]!.toUpperCase() + action.type.slice(1);
export function DecisionAnalysisControls({ analysis }: { analysis: ReturnType<typeof useDecisionAnalysis> }) {
  const { display } = analysis;
  const data = display?.data;
  return <section className="decision-analysis" aria-labelledby="decision-analysis-heading">
    <h3 id="decision-analysis-heading">Decision analysis</h3>
    <p className="help">Inspect current or accepted human decisions using the committed Reference Strategy. Play remains available while analysis runs.</p>
    <label>Decision to analyze<select name="analysisDecision" value={analysis.selectedDecisionId} onChange={event => analysis.selectDecision(event.target.value)}>
      <option value="">Current human decision</option>
      {analysis.acceptedDecisions.map(decision => <option key={decision.decisionId} value={decision.decisionId}>{decision.decisionId} · {actionLabel(decision.action)}</option>)}
    </select></label>
    <button disabled={!analysis.canEvaluate || display?.loading} onClick={analysis.evaluate}>{analysis.selectedDecisionId ? 'Analyze accepted decision' : 'Evaluate current decision'}</button>
    {!analysis.canEvaluate && <p className="help">Choose a current or accepted human decision.</p>}
    {(display?.loading || display?.retrying || data?.status === 'pending') && <p role="status">Evaluating the Reference Strategy…</p>}
    {display?.error && <p role="alert" className="error">{display.error}</p>}
    {data?.status === 'error' && <div><p role="alert" className="error">{data.scoredDecision ? 'Analysis error' : 'Evaluation error'}: {data.error.code}. {data.error.message}</p><button disabled={display?.retrying} onClick={() => void analysis.retry()}>{data.scoredDecision ? 'Retry decision analysis' : 'Retry evaluation'}</button></div>}
    {data?.status === 'complete' && <div className="evaluation-result">
      <p>Reference: {data.referenceStrategy.policy.id} · {data.referenceStrategy.policy.version} + {data.referenceStrategy.selector.id} · {data.referenceStrategy.selector.version}</p>
      {data.scoredDecision && <p><strong>Accepted human action:</strong> {actionLabel(data.scoredDecision.acceptedAction)}</p>}
      {data.scores && <dl className="table-facts analysis-scores">
        <div><dt>Decision Score</dt><dd>{data.scores.decisionScore.toFixed(6)}</dd></div>
        <div><dt>Action Rank Score</dt><dd>{data.scores.actionRankScore.toFixed(6)}</dd></div>
      </dl>}
      <p><strong>Selected concrete action:</strong> {actionLabel(data.evaluation.selectedAction)}</p>
      <table className="evaluation-choices"><caption>Policy distribution · {data.decisionId}</caption><thead><tr><th scope="col">Concrete choice</th><th scope="col">Probability</th></tr></thead><tbody>{data.evaluation.policyResult.choices.map(choice => <tr key={actionLabel(choice.action)}><td>{actionLabel(choice.action)}</td><td>{choice.probability.toFixed(6)}</td></tr>)}</tbody></table>
      <table className="evaluation-choices"><caption>Action Probabilities</caption><thead><tr><th scope="col">Legal action type</th><th scope="col">Probability</th></tr></thead><tbody>{data.evaluation.actionProbabilities.map(item => <tr key={item.type}><td>{item.type}</td><td>{item.probability.toFixed(6)}</td></tr>)}</tbody></table>
    </div>}
  </section>;
}
