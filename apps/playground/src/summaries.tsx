import { useMemo, useState } from 'react';
import type { ScoreSummary, ObservableTableSession } from '@poker/contracts';
import { api } from './api.js';
import { createAnalysisTarget, useAnalysisResource } from './analysis-resource.js';
export function useHandSummary(table: ObservableTableSession | undefined) {
  const [selection, setSelection] = useState<{ tableId: string; handId: string }>();
  const hands = table?.view.history.map(hand => hand.handId) ?? [];
  if (table?.view.state.handId && !hands.includes(table.view.state.handId)) hands.push(table.view.state.handId);
  const handId = selection && selection.tableId === table?.tableSessionId && hands.includes(selection.handId) ? selection.handId : table?.view.state.handId ?? hands.at(-1);
  const key = table && handId ? JSON.stringify([table.tableSessionId, handId]) : '';
  const target = useMemo(() => table && handId ? createAnalysisTarget<ScoreSummary>({
    key, tableId: table.tableSessionId, resource: 'summary', wanted: false, recoverMissing: false,
    create: () => api.createHandSummary(table.tableSessionId, handId), read: requestId => api.readSummary(table.tableSessionId, requestId), retry: requestId => api.retrySummary(table.tableSessionId, requestId),
    accepts: data => data.tableSessionId === table.tableSessionId && data.scope === 'hand' && data.handId === handId,
  }) : null, [key]);
  const resource = useAnalysisResource(target);
  return { ...resource, hands, handId, canRequest: !!target, selectHand: (id: string) => { if (table) setSelection({ tableId: table.tableSessionId, handId: id }); }, request: () => resource.request(true) };
}
export function useTableSessionSummary(table: ObservableTableSession | undefined) {
  const key = table?.tableSessionId ?? '';
  const target = useMemo(() => table ? createAnalysisTarget<ScoreSummary>({
    key, tableId: table.tableSessionId, resource: 'summary', wanted: false, recoverMissing: false,
    create: () => api.createSessionSummary(table.tableSessionId), read: requestId => api.readSummary(table.tableSessionId, requestId), retry: requestId => api.retrySummary(table.tableSessionId, requestId),
    accepts: data => data.tableSessionId === table.tableSessionId && data.scope === 'table-session',
  }) : null, [key]);
  const resource = useAnalysisResource(target);
  return { ...resource, canRequest: !!target, request: () => resource.request(true) };
}
function SummaryState({ summary, label }: { summary: ReturnType<typeof useTableSessionSummary>; label: string }) {
  const display = summary.display, data = display?.data;
  return <>
    {(display?.loading || display?.retrying || data?.status === 'pending') && <p role="status">Analyzing {label} summary...</p>}
    {display?.error && <p role="alert" className="error">{display.error}</p>}
    {data && <div className="summary-metadata"><p>Captured poker revision: {data.capturedPokerRevision} · Decisions: {data.decisionCount}</p><p>Reference: {data.referenceStrategy.policy.id} · {data.referenceStrategy.policy.version} + {data.referenceStrategy.selector.id} · {data.referenceStrategy.selector.version}</p></div>}
    {data?.status === 'empty' && <p>No accepted human decisions in this snapshot.</p>}
    {data?.status === 'error' && <div><p role="alert" className="error">Summary error: {data.error.code}. {data.error.message}</p><button disabled={display?.retrying} onClick={() => void summary.retry()}>Retry {label} summary</button></div>}
    {data?.status === 'complete' && <dl className="table-facts summary-scores"><div><dt>Decision Score mean</dt><dd>{data.averages.decisionScore.toFixed(6)}</dd></div><div><dt>Action Rank Score mean</dt><dd>{data.averages.actionRankScore.toFixed(6)}</dd></div></dl>}
  </>;
}
export function TableSessionSummaryControls({ summary }: { summary: ReturnType<typeof useTableSessionSummary> }) {
  const display = summary.display;
  return <section className="decision-analysis session-summary" aria-labelledby="session-summary-heading">
    <h3 id="session-summary-heading">Table Session Score Summary</h3>
    <p className="help">Request a snapshot of accepted human decisions across all Hands using one Reference Strategy. Later play and settings changes require a new request.</p>
    <button disabled={!summary.canRequest || display?.loading || display?.retrying} onClick={summary.request}>Request Table Session summary</button>
    <SummaryState summary={summary} label="Table Session" />
  </section>;
}
export function HandSummaryControls({ summary }: { summary: ReturnType<typeof useHandSummary> }) {
  const display = summary.display;
  return <section className="decision-analysis hand-summary" aria-labelledby="hand-summary-heading">
    <h3 id="hand-summary-heading">Hand Score Summary</h3>
    <p className="help">Request a snapshot of accepted human decisions using one Reference Strategy. Later play and settings changes require a new request.</p>
    <label>Hand to summarize<select name="summaryHand" value={summary.handId ?? ''} onChange={event => summary.selectHand(event.target.value)}>{summary.hands.map(id => <option key={id} value={id}>{id}</option>)}</select></label>
    <button disabled={!summary.canRequest || display?.loading || display?.retrying} onClick={summary.request}>Request Hand summary</button>
    {!summary.canRequest && <p className="help">Start a Hand before requesting a summary.</p>}
    <SummaryState summary={summary} label="Hand" />
  </section>;
}
