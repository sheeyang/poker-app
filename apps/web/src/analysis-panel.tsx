import type { DecisionAnalysis, ObservableTableSession, ScoreSummary } from '@poker/contracts';
import { baselinePlayingStrategy, highestProbabilityPlayingStrategy } from '@poker/contracts';
import { Icon } from './icons.js';
import { actionLabel } from './table-model.js';
import type { useDecisionAnalysis } from './analysis.js';
import type { useHandSummary, useTableSessionSummary } from './summaries.js';
import type { Command } from './session.js';
import { Dialog } from './dialog.js';
import { Card } from './cards.js';

type Analysis = ReturnType<typeof useDecisionAnalysis>;
type HandSummary = ReturnType<typeof useHandSummary>;
type SessionSummary = ReturnType<typeof useTableSessionSummary>;

export function AnalysisPanel({ table, analysis, command, close }: { table: ObservableTableSession; analysis: Analysis; command: Command; close: () => void }) {
  const data = analysis.display?.data;
  const configuration = table.trainerConfiguration;
  function configure(selector: string, liveAnalysis: boolean) {
    command.submit({ tableId: table.tableSessionId, kind: 'trainer', body: { requestId: crypto.randomUUID(), expectedSessionRevision: table.sessionRevision, trainerConfiguration: { referenceStrategy: selector === 'highest-probability' ? highestProbabilityPlayingStrategy : baselinePlayingStrategy, liveAnalysis } } });
  }
  const accepted = analysis.acceptedDecisions;
  const selected = accepted.find(d => d.decisionId === analysis.selectedDecisionId);
  const handDecisions = accepted.filter(d => d.handId === (selected?.handId ?? table.view.state.handId));
  const context = selected?.state ?? table.view.state;
  const human = context.participants.find(p => p.participantId === table.bindings.find(b => b.controller.kind === 'human')?.participantId);
  return <aside id="analysis-panel" tabIndex={-1} className="analysis-panel" aria-label="Strategy analysis">
    <div className="panel-heading"><div><Icon name="chart" /><h2>{selected ? `Hand ${selected.handNumber} review` : 'Live reference'}</h2></div><button className="icon-button" aria-label="Return to table" onClick={close}><Icon name="close" size={18} /></button></div>
    {analysis.pinned && <button className="text-button follow-play" onClick={() => analysis.selectDecision('')}>Return to latest decision <Icon name="arrow" size={15} /></button>}
    <section className="decision-section"><div className="section-heading"><h3>{analysis.selectedDecisionId ? 'Your decision' : configuration.liveAnalysis ? 'Current decision' : 'Decision analysis'}</h3><span className="subtle-tag">{analysis.selectedDecisionId ? 'Post-action' : configuration.liveAnalysis ? 'Live' : 'Live off'}</span></div>
      {handDecisions.length > 0 && <div className="review-decisions" aria-label="Your decisions in this hand">{handDecisions.map(d => <button key={d.decisionId} aria-pressed={d.decisionId === analysis.selectedDecisionId} onClick={() => analysis.selectDecision(d.decisionId)}><span>{d.state.street}</span><strong>{actionLabel(d.action)}</strong></button>)}</div>}
      <div className="decision-context"><span>{selected ? `At your ${context.street} decision` : configuration.liveAnalysis ? 'Current table state' : 'Reference appears after you act'}</span><div className="review-cards"><div aria-label="Your cards at the decision">{human?.holeCards?.map((card, i) => <Card key={i} card={card} small />)}</div><div aria-label="Board at the decision">{context.board.map((card, i) => <Card key={i} card={card} small />)}{!context.board.length && <small>Preflop · no community cards</small>}</div></div></div>
      {analysis.display?.error && <div className="notice-error" role="alert"><p>{analysis.display.error}</p><button onClick={analysis.evaluate}>Read analysis again</button></div>}
      {(analysis.display?.loading && !data || data?.status === 'pending') && <div className="analysis-pending" role="status"><div className="skeleton" /><div className="skeleton short" /><p>Evaluating the Reference Strategy…</p><small>You can keep playing.</small></div>}
      {data?.status === 'error' && <div className="notice-error" role="alert"><strong>Analysis unavailable</strong><p>{data.error.message}</p><button disabled={analysis.display?.retrying} onClick={() => void analysis.retry()}>{analysis.display?.retrying ? 'Retrying…' : 'Retry analysis'}</button></div>}
      {data?.status === 'complete' && <DecisionResult data={data} />}
      {!data && !analysis.display?.loading && !analysis.display?.error && <div className="analysis-empty"><Icon name="cards" size={30} /><strong>{configuration.liveAnalysis ? 'Waiting for your turn.' : 'Play first. Explore after.'}</strong><p>{configuration.liveAnalysis ? 'The current decision will be evaluated when it’s your turn.' : 'Your accepted decision and reference distribution will appear here after you act.'}</p></div>}
    </section>
    <details className="reference-settings"><summary>Reference & feedback settings</summary><div className="details-content"><label>Reference action selection<select value={configuration.referenceStrategy.selector.id} disabled={command.busy} onChange={e => configure(e.target.value, configuration.liveAnalysis)}><option value="seeded-sampling">Uniform Choice · Probability Selector</option><option value="highest-probability">Uniform Choice · Highest Probability</option></select></label><p className="muted">The reference compares your decisions. It does not change how the bots play.</p><label className="live-toggle"><span><strong>Live Analysis</strong><small>Show the reference before you act</small></span><input type="checkbox" role="switch" disabled={command.busy} checked={configuration.liveAnalysis} onChange={e => configure(configuration.referenceStrategy.selector.id, e.target.checked)} /></label></div></details>
    <details className="analysis-explainer"><summary><Icon name="info" size={16} />What do these numbers mean?</summary><div className="details-content"><p>Decision Score measures alignment with the reference Policy, including bet sizing. Action Rank Score measures the rank of the action type’s probability.</p><p>These scores are not EV, accuracy or a judgment of strategic quality. Uniform Choice is a testing baseline.</p><p>Probability is displayed from 0.00 to 1.00. Bet and raise children show their original, unconditional probabilities.</p></div></details>
  </aside>;
}

function DecisionResult({ data }: { data: Extract<DecisionAnalysis, { status: 'complete' }> }) {
  const accepted = data.scoredDecision?.acceptedAction;
  return <>
    {data.scores && <div className="decision-scores"><div className="score-main"><span>Decision Score</span><strong>{(data.scores.decisionScore * 100).toFixed(1)}<small>/100</small></strong></div><div className="score-secondary"><span>Action Rank Score</span><strong>{(data.scores.actionRankScore * 100).toFixed(1)}<small>/100</small></strong></div></div>}
    {data.scores && <p className="score-meaning">Alignment with Uniform Choice, a testing baseline. This isn’t a measure of poker skill or profit.</p>}
    {accepted && <div className="accepted-action"><span>Your accepted action</span><strong>{actionLabel(accepted)}</strong></div>}
    <div className="distribution-heading"><h3>Reference distribution</h3><span>Probability</span></div>
    <ul className="probability-tree" aria-label="Reference Policy distribution">{data.evaluation.actionProbabilities.map(parent => <li key={parent.type} className={`probability-group probability-${parent.type}`}><div className="probability-row"><span>{parent.type[0]!.toUpperCase() + parent.type.slice(1)}{accepted?.type === parent.type && <span className="you-marker">You</span>}</span><strong>{parent.probability.toFixed(2)}</strong></div><meter min="0" max="1" value={parent.probability} aria-label={`${parent.type} probability`} />
      {(parent.type === 'raise' || parent.type === 'bet') && <ul>{data.evaluation.policyResult.choices.filter(c => c.action.type === parent.type).map(choice => <li key={actionLabel(choice.action)}><span>{actionLabel(choice.action)}{accepted && JSON.stringify(accepted) === JSON.stringify(choice.action) && <span className="you-marker">You</span>}</span><strong>{choice.probability.toFixed(2)}</strong></li>)}</ul>}
    </li>)}</ul>
    <div className="reference-selected"><span>{data.referenceStrategy.selector.id === 'seeded-sampling' ? 'Sampled reference action' : 'Selected reference action'}</span><strong>{actionLabel(data.evaluation.selectedAction)}</strong><small>{data.referenceStrategy.selector.id === 'seeded-sampling' ? 'A reproducible sample from the full distribution.' : 'Selected by the configured Action Selector.'}</small></div>
    <details className="analysis-provenance"><summary>Reference details</summary><p>Policy: {data.referenceStrategy.policy.id} · {data.referenceStrategy.policy.version}<br />Selector: {data.referenceStrategy.selector.id} · {data.referenceStrategy.selector.version}</p></details>
  </>;
}

export function SummaryResult({ summary, compact = false }: { summary: HandSummary | SessionSummary; compact?: boolean }) {
  const display = summary.display, data: ScoreSummary | undefined = display?.data;
  return <>
    {(display?.loading || data?.status === 'pending') && <p className="muted" role="status">Preparing the complete summary…</p>}
    {display?.error && <div className="notice-error" role="alert"><p>{display.error}</p><button onClick={summary.request}>Request summary again</button></div>}
    {data?.status === 'error' && <div className="notice-error" role="alert"><p>{data.error.message}</p><button disabled={display?.retrying} onClick={() => void summary.retry()}>{display?.retrying ? 'Retrying…' : 'Retry summary'}</button></div>}
    {data?.status === 'empty' && <p className="muted">No accepted human decisions in this summary.</p>}
    {data?.status === 'complete' && <div className="summary-averages"><div><span>Mean Decision Score</span><strong>{(data.averages.decisionScore * 100).toFixed(1)}<small>/100</small></strong></div><div><span>Mean Action Rank Score</span><strong>{(data.averages.actionRankScore * 100).toFixed(1)}<small>/100</small></strong></div></div>}
    {data && <p className="analysis-provenance">{compact ? 'Policy alignment · Uniform Choice baseline' : <>{data.decisionCount} {data.decisionCount === 1 ? 'decision' : 'decisions'} · Fixed reference: {data.referenceStrategy.policy.id} + {data.referenceStrategy.selector.id}<br />This summary retains its original decision set and reference.</>}</p>}
  </>;
}

export function FinishSession({ summary, close, leave }: { summary: SessionSummary; close: () => void; leave: () => void }) {
  return <Dialog title="Your session, in numbers." close={close}><p className="summary-intro">A snapshot of your accepted decisions against one Reference Strategy.</p><SummaryResult summary={summary} /><div className="finish-actions"><button onClick={close}>Keep playing</button><button className="primary" onClick={leave}>Back to tables <Icon name="arrow" /></button></div><p className="muted">Your Table Session stays saved. You can return to its seats and stacks later.</p></Dialog>;
}
