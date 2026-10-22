import { useEffect, useMemo, useState } from 'react';
import type { DecisionAnalysis, ObservableTableSession, ConcreteAction } from '@poker/contracts';
import { api } from './api.js';
import { createAnalysisTarget, useAnalysisResource } from './analysis-resource.js';
function identity(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(identity).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + identity((value as Record<string, unknown>)[key])).join(',') + '}';
  return JSON.stringify(value);
}
export function useDecisionAnalysis(table: ObservableTableSession | undefined) {
  const [selection, setSelection] = useState<{ tableId: string; decisionId: string }>();
  const human = table?.bindings.find(binding => binding.controller.kind === 'human')?.participantId;
  const acceptedDecisions = table?.view.history.flatMap(hand => hand.decisions.filter(decision => decision.action.participantId === human).map(decision => ({ decisionId: decision.decisionId, action: decision.action.action }))) ?? [];
  const newestAccepted = acceptedDecisions.at(-1)?.decisionId;
  const currentDecisionId = table?.view.state.legalActions.length ? table.view.state.decisionId : undefined;
  const liveEnabled = table?.trainerConfiguration.liveAnalysis ?? false;
  useEffect(() => { if (table && newestAccepted) setSelection({ tableId: table.tableSessionId, decisionId: newestAccepted }); }, [table?.tableSessionId, newestAccepted]);
  useEffect(() => { if (table && liveEnabled && currentDecisionId) setSelection({ tableId: table.tableSessionId, decisionId: '' }); }, [table?.tableSessionId, liveEnabled, currentDecisionId]);
  const selectedDecisionId = selection && selection.tableId === table?.tableSessionId && acceptedDecisions.some(decision => decision.decisionId === selection.decisionId) ? selection.decisionId : '';
  const accepted = acceptedDecisions.find(decision => decision.decisionId === selectedDecisionId);
  const decisionId = selectedDecisionId || currentDecisionId;
  const key = table && decisionId ? identity([table.tableSessionId, decisionId, table.trainerConfiguration.referenceStrategy, accepted?.action ?? null]) : '';
  const target = useMemo(() => key && table && decisionId ? createAnalysisTarget<DecisionAnalysis>({
    key, tableId: table.tableSessionId, resource: 'analysis', wanted: !!accepted || liveEnabled, recoverMissing: true,
    create: () => api.getOrStartAnalysis(table.tableSessionId, decisionId, !accepted && liveEnabled),
    read: requestId => api.readAnalysis(table.tableSessionId, requestId), retry: requestId => api.retryAnalysis(table.tableSessionId, requestId),
    accepts: data => identity([data.tableSessionId, data.decisionId, data.referenceStrategy, data.scoredDecision?.acceptedAction ?? null]) === key,
  }) : null, [key, liveEnabled]);
  const resource = useAnalysisResource(target);
  return { ...resource, acceptedDecisions, selectedDecisionId, selectDecision: (id: string) => { if (table) setSelection({ tableId: table.tableSessionId, decisionId: id }); }, canEvaluate: !!target, evaluate: () => resource.request() };
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
