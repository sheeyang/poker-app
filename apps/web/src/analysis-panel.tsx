import { useRef, useState } from 'react';
import type { DecisionAnalysis, ObservableTableSession, ScoreSummary, StrategyDescriptor } from '@poker/contracts';
import { policyName, StrategySelect } from './strategy-select.js';
import { Icon } from './icons.js';
import { actionLabel } from './table-model.js';
import type { useDecisionAnalysis } from './analysis.js';
import type { useHandSummary, useTableSessionSummary } from './summaries.js';
import type { Command } from './session.js';
import { Dialog } from './dialog.js';
import { DecisionSituation, EarlierActions } from './decision-situation.js';

type Analysis = ReturnType<typeof useDecisionAnalysis>;
type HandSummary = ReturnType<typeof useHandSummary>;
type SessionSummary = ReturnType<typeof useTableSessionSummary>;

export function AnalysisPanel({ table, analysis, command, close }: { table: ObservableTableSession; analysis: Analysis; command: Command; close: () => void }) {
  const data = analysis.display?.data ?? analysis.rowAnalyses?.[analysis.selectedDecisionId];
  const configuration = table.trainerConfiguration;
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsButton = useRef<HTMLButtonElement>(null);
  function configure(referenceStrategy: StrategyDescriptor, liveAnalysis: boolean) {
    command.submit({ tableId: table.tableSessionId, kind: 'trainer', body: { requestId: crypto.randomUUID(), expectedSessionRevision: table.sessionRevision, trainerConfiguration: { referenceStrategy, liveAnalysis } } });
  }
  const accepted = analysis.acceptedDecisions;
  const selected = accepted.find(d => d.decisionId === analysis.selectedDecisionId);
  const handDecisions = accepted.filter(d => d.handId === (selected?.handId ?? table.view.state.handId));
  const context = selected?.state ?? table.view.state;
  const handActions = table.view.history.find(hand => hand.handId === context.handId)?.decisions ?? [];
  const selectedActionIndex = selected ? handActions.findIndex(action => action.decisionId === selected.decisionId) : -1;
  const earlierActions = selected ? selectedActionIndex < 0 ? [] : handActions.slice(0, selectedActionIndex) : handActions;
  const humanId = table.bindings.find(b => b.controller.kind === 'human')?.participantId;
  const expandedDecisionId = analysis.expandedDecisionId ?? analysis.selectedDecisionId;
  const liveDecision = configuration.liveAnalysis && !!table.view.state.decisionId && table.view.state.legalActions.length > 0;
  const showFollow = analysis.pinned && (selected?.decisionId !== accepted.at(-1)?.decisionId || liveDecision);
  const reference = data?.referenceStrategy ?? configuration.referenceStrategy;
  const street = context.street ?? 'decision';
  const content = <>
    {data?.status === 'complete' && data.scores && <div className="decision-scores"><div className="score-main"><span>Decision Score</span><strong>{(data.scores.decisionScore * 100).toFixed(1)}<small>/100</small></strong></div><div className="score-secondary"><span>Action Rank Score</span><strong>{(data.scores.actionRankScore * 100).toFixed(1)}<small>/100</small></strong></div></div>}
    <div className="decision-context"><span>{selected ? `${street[0]!.toUpperCase()}${street.slice(1)} · Before your action` : configuration.liveAnalysis ? 'Current table state' : 'Reference appears after you act'}</span>{humanId && (selected || configuration.liveAnalysis) && <DecisionSituation state={context} humanId={humanId} bindings={table.bindings} earlierActions={earlierActions} seatCount={table.view.configuration.seatCount} />}</div>
    {analysis.display?.error && <div className="notice-error" role="alert"><p>{analysis.display.error}</p><button onClick={analysis.evaluate}>Retry analysis</button></div>}
    {(analysis.display?.loading && !data || data?.status === 'pending') && <p className="review-analysis-status" role="status">Loading reference actions…</p>}
    {data?.status === 'error' && <div className="notice-error" role="alert"><strong>Analysis unavailable</strong><p>{data.error.message}</p><button disabled={analysis.display?.retrying} onClick={() => void analysis.retry()}>{analysis.display?.retrying ? 'Retrying…' : 'Retry analysis'}</button></div>}
    {data?.status === 'complete' && <DecisionResult data={data} />}
    {humanId && selected && <EarlierActions actions={earlierActions} humanId={humanId} bindings={table.bindings} />}
    {data?.status === 'complete' && <AnalysisDetails data={data} />}
    {!data && !analysis.display?.loading && !analysis.display?.error && <div className="analysis-empty"><Icon name="cards" size={30} /><strong>{configuration.liveAnalysis ? 'Waiting for your turn.' : 'Play first. Explore after.'}</strong><p>{configuration.liveAnalysis ? 'The current decision will be evaluated when it’s your turn.' : 'Your accepted decision and reference distribution will appear here after you act.'}</p></div>}
  </>;
  return <aside id="analysis-panel" tabIndex={-1} className="analysis-panel" aria-label="Strategy analysis">
    <div className="panel-heading"><div><Icon name="chart" /><h2>{selected ? `Hand ${selected.handNumber} review` : 'Live reference'}</h2></div><div className="panel-actions"><button ref={settingsButton} className="icon-button" aria-label="Analysis settings" title="Analysis settings" aria-expanded={settingsOpen} aria-controls="analysis-settings" onClick={() => setSettingsOpen(!settingsOpen)}><Icon name="settings" size={18} /></button><button className="icon-button" aria-label="Return to table" onClick={close}><Icon name="close" size={18} /></button></div></div>
    <div className="analysis-meta"><span>Reference: <strong>{policyName(reference)}</strong></span><span>Amounts in chips</span></div>
    {settingsOpen && <section id="analysis-settings" className="analysis-settings" aria-label="Analysis settings" onKeyDown={event => { if (event.key === 'Escape') { setSettingsOpen(false); settingsButton.current?.focus(); } }}><h3>Analysis settings</h3><label>Reference Strategy<StrategySelect value={configuration.referenceStrategy} disabled={command.busy} onChange={strategy => configure(strategy, configuration.liveAnalysis)} /></label><p className="muted">Changing the reference recalculates your scores. Bot strategies stay the same.</p><label className="live-toggle"><span><strong>Live Analysis</strong><small>Show the reference before you act</small></span><input type="checkbox" role="switch" disabled={command.busy} checked={configuration.liveAnalysis} onChange={e => configure(configuration.referenceStrategy, e.target.checked)} /></label></section>}
    {showFollow && <button className="text-button follow-play" onClick={() => analysis.selectDecision('')}>{liveDecision ? 'Live decision' : 'Latest decision'} <Icon name="arrow" size={15} /></button>}
    {!selected && <section className="decision-section"><div className="section-heading"><h3>{configuration.liveAnalysis ? 'Current decision' : 'Decision analysis'}</h3><span className="subtle-tag">{configuration.liveAnalysis ? 'Live' : 'Live off'}</span></div>{content}</section>}
    {handDecisions.length > 0 && <section className="decision-section decision-review"><div className="section-heading"><h3>Your decisions</h3><span className="muted">{handDecisions.length} to review</span></div>
      <ol aria-label="Your decisions in this hand" className="review-decision-list">{handDecisions.map(d => {
        const open = d.decisionId === expandedDecisionId;
        const rowData = analysis.rowAnalyses?.[d.decisionId] ?? (data?.decisionId === d.decisionId ? data : undefined);
        return <li key={d.decisionId}><details className="review-decision" open={open}>
          <summary onClick={event => { event.preventDefault(); if (open) analysis.collapseDecision(); else analysis.selectDecision(d.decisionId); }} aria-describedby={!open ? `decision-scores-${d.decisionId}` : undefined} aria-label={`Review your ${d.state.street} ${actionLabel(d.action)}`}><strong className="review-row-action">{actionLabel(d.action)}</strong>{!open && <span id={`decision-scores-${d.decisionId}`} className="review-row-scores">{rowData?.status === 'complete' && rowData.scores ? <><span>Decision Score<strong>{(rowData.scores.decisionScore * 100).toFixed(1)}<small>/100</small></strong></span><span>Action Rank Score<strong>{(rowData.scores.actionRankScore * 100).toFixed(1)}<small>/100</small></strong></span></> : <span className="review-row-status">{rowData?.status === 'error' || analysis.rowErrors?.[d.decisionId] ? 'Scores unavailable' : 'Scores pending'}</span>}</span>}<Icon name="chevron" size={17} /></summary>
          {open && <div className="review-decision-content">{content}</div>}
        </details></li>;
      })}</ol>
    </section>}
    <details className="analysis-explainer"><summary><Icon name="info" size={16} />About these scores</summary><div className="details-content"><p>Scores compare your play with the Reference Strategy. They do not measure poker skill, EV or profit.</p><p>Decision Score measures alignment with the reference Policy, including bet sizing. Action Rank Score measures the rank of your action type’s probability.</p><p>Probabilities run from 0.00 to 1.00. Bet and raise sizes show their original probabilities. Simple Heuristic uses basic rules; Uniform Choice is a testing baseline.</p></div></details>
  </aside>;
}

function DecisionResult({ data }: { data: Extract<DecisionAnalysis, { status: 'complete' }> }) {
  const accepted = data.scoredDecision?.acceptedAction;
  return <>
    <div className="distribution-heading"><h3>Reference actions</h3><span>Probability</span></div>
    <ul className="probability-tree" aria-label="Reference Policy distribution">{data.evaluation.actionProbabilities.map(parent => <li key={parent.type} className={`probability-group probability-${parent.type}`}><div className="probability-row"><span>{parent.type[0]!.toUpperCase() + parent.type.slice(1)}{accepted?.type === parent.type && <span className="you-marker">You</span>}</span><strong>{parent.probability.toFixed(2)}</strong></div><meter min="0" max="1" value={parent.probability} aria-label={`${parent.type} probability`} />
      {(parent.type === 'raise' || parent.type === 'bet') && <ul>{data.evaluation.policyResult.choices.filter(c => c.action.type === parent.type).map(choice => <li key={actionLabel(choice.action)}><span>{actionLabel(choice.action)}{accepted && JSON.stringify(accepted) === JSON.stringify(choice.action) && <span className="you-marker">You</span>}</span><strong>{choice.probability.toFixed(2)}</strong></li>)}</ul>}
    </li>)}</ul>
    <div className="reference-selected"><span>{data.referenceStrategy.selector.id === 'seeded-sampling' ? 'Sampled action' : 'Selected action'}</span><strong>{actionLabel(data.evaluation.selectedAction)}</strong></div>
  </>;
}

function AnalysisDetails({ data }: { data: Extract<DecisionAnalysis, { status: 'complete' }> }) {
  return <details className="analysis-provenance"><summary>Analysis details</summary><div className="details-content"><p>{data.referenceStrategy.selector.id === 'seeded-sampling' ? 'The sampled action is a reproducible draw from the full distribution. It may differ from the most likely action.' : 'The selected action is chosen by the configured Action Selector.'}</p><p>Policy: {data.referenceStrategy.policy.id} · {data.referenceStrategy.policy.version}<br />Selector: {data.referenceStrategy.selector.id} · {data.referenceStrategy.selector.version}</p></div></details>;
}

export function SummaryResult({ summary, compact = false }: { summary: HandSummary | SessionSummary; compact?: boolean }) {
  const display = summary.display, data: ScoreSummary | undefined = display?.data;
  return <>
    {(display?.loading || data?.status === 'pending') && <p className="muted" role="status">Preparing the complete summary…</p>}
    {display?.error && <div className="notice-error" role="alert"><p>{display.error}</p><button onClick={summary.request}>Request summary again</button></div>}
    {data?.status === 'error' && <div className="notice-error" role="alert"><p>{data.error.message}</p><button disabled={display?.retrying} onClick={() => void summary.retry()}>{display?.retrying ? 'Retrying…' : 'Retry summary'}</button></div>}
    {data?.status === 'empty' && <p className="muted">No accepted human decisions in this summary.</p>}
    {data?.status === 'complete' && <div className="summary-averages"><div><span>Mean Decision Score</span><strong>{(data.averages.decisionScore * 100).toFixed(1)}<small>/100</small></strong></div><div><span>Mean Action Rank Score</span><strong>{(data.averages.actionRankScore * 100).toFixed(1)}<small>/100</small></strong></div></div>}
    {data && <p className="analysis-provenance">{compact ? `Policy alignment · ${policyName(data.referenceStrategy)}` : <>{data.decisionCount} {data.decisionCount === 1 ? 'decision' : 'decisions'} · Fixed reference: {policyName(data.referenceStrategy)} + {data.referenceStrategy.selector.id}<br />This summary retains its original decision set and reference.</>}</p>}
  </>;
}

export function FinishSession({ summary, close, leave }: { summary: SessionSummary; close: () => void; leave: () => void }) {
  return <Dialog title="Your session, in numbers." close={close}><p className="summary-intro">A snapshot of your accepted decisions against one Reference Strategy.</p><SummaryResult summary={summary} /><div className="finish-actions"><button onClick={close}>Keep playing</button><button className="primary" onClick={leave}>Back to tables <Icon name="arrow" /></button></div><p className="muted">Your Table Session stays saved. You can return to its seats and stacks later.</p></Dialog>;
}
