import { api } from '@poker/client';
import { strategyToken, type ScoreSummary, type StrategyDescriptor } from '@poker/contracts';
import { followedTableSummary, tableSummaryFigures } from './table-history.js';
import { strategyName } from './strategy-select.js';
import { ColumnHead, CompareBar, useSummaryStrategies } from './summary-comparison.js';
import { useFollowedRequest } from './use-followed-request.js';

/**
 * A Score Summary of the reader's own decisions across the table's completed Hands, under one Strategy (the Guest's
 * Reference Strategy when none is named). While it is Analyzing its count follows the Guest's `progress` messages, and its
 * completion or failure notice reads it again; nothing reads it on a timer. Retry runs only the failed analyses again. A
 * new completed Hand asks again, since the summary is frozen when it is asked for.
 */
function useTableSummary(tableSessionId: string, completedHands: number | undefined, asked: boolean, strategy: StrategyDescriptor | undefined) {
  const summary = useFollowedRequest({
    key: JSON.stringify(['table-summary', tableSessionId, completedHands ?? null, strategy ? strategyToken(strategy) : null]),
    enabled: asked, keepPrevious: true, model: followedTableSummary,
    create: () => api.requestTableHistorySummary(tableSessionId, strategy),
    read: requestId => api.readSummary(tableSessionId, requestId),
    retry: requestId => api.retrySummary(tableSessionId, requestId),
  });
  return { ...summary, loading: asked && !summary.data && summary.asking };
}

function Means({ summary }: { summary: ScoreSummary }) {
  const figures = tableSummaryFigures(summary);
  return <div className="ogs-means" aria-live="polite" aria-atomic="true">
    <div className="ogs-mean"><span>Mean Decision Score</span><strong className="numeric">{figures.decisionScore}<small>/100</small></strong></div>
    <div className="ogs-mean is-secondary"><span>Mean Action Rank Score</span><strong className="numeric">{figures.actionRankScore}<small>/100</small></strong></div>
    <div className="ogs-mean is-count"><span>Decisions</span><strong className="numeric">{summary.decisionCount ? summary.decisionCount.toLocaleString('en') : 'No decisions'}</strong></div>
  </div>;
}

/** One Strategy's column: its means, its own Analyzing, Error and Retry. Another Strategy failing never touches it. */
function SummaryColumn({ tableSessionId, completedHands, asked, strategy, reference, onRemove }: { tableSessionId: string; completedHands: number | undefined; asked: boolean; strategy: StrategyDescriptor | undefined; reference: boolean; onRemove: () => void }) {
  const summary = useTableSummary(tableSessionId, completedHands, asked, strategy);
  const data = summary.data;
  const named = data?.referenceStrategy ?? strategy;
  const headingId = `ths-column-${strategy ? strategyToken(strategy) : 'reference'}`;
  const figures = data && tableSummaryFigures(data);
  return <article className="ogs-column" aria-labelledby={headingId} aria-busy={(summary.stale || summary.loading || data?.status === 'pending') || undefined}>
    <ColumnHead headingId={headingId} name={named ? strategyName(named) : 'Reference Strategy'} reference={reference} onRemove={onRemove} />
    {summary.error && !data && <div className="notice-error" role="alert"><p>{summary.error.message}</p><button type="button" onClick={summary.again}>Request summary again</button></div>}
    {summary.loading && <div className="ogs-means" role="status" aria-label="Requesting the summary"><div className="ogs-mean"><span>Mean Decision Score</span><strong className="numeric">—<small>/100</small></strong></div><div className="ogs-mean is-secondary"><span>Mean Action Rank Score</span><strong className="numeric">—<small>/100</small></strong></div></div>}
    {data && <>
      <Means summary={data} />
      {data.status === 'pending' && <div className="ogs-progress"><span className="numeric" role="status">{figures?.state}</span><progress max={data.progress.total || 1} value={data.progress.succeeded} aria-label="Analyses succeeded" /></div>}
      {data.status === 'empty' && <p className="ogs-note">You have no decisions at this table yet, so there is no score.</p>}
      {data.status === 'error' && <div className="notice-error" role="alert"><p>{data.error.message || 'An analysis failed, so this summary has no score.'} Retry analyzes only the failed ones again.</p><button type="button" disabled={summary.retrying} onClick={summary.retry}>{summary.retrying ? 'Retrying…' : 'Retry'}</button></div>}
      {data.status !== 'error' && summary.error && <div className="notice-error" role="alert"><p>{summary.error.message}</p><button type="button" onClick={summary.again}>Request summary again</button></div>}
    </>}
  </article>;
}

/**
 * The table's Score Summary in Table History (ADR-0041): your decisions across its completed Hands, asked for explicitly,
 * under your Reference Strategy and, side by side, up to 3 more the address names. The comparison is the address's
 * `compare`, the same one the replay compares at a decision, and never changes the Trainer Configuration.
 */
export function TableHistorySummaryPanel({ tableSessionId, completedHands, compared, onCompare, asked, onAsk }: { tableSessionId: string; completedHands: number | undefined; compared: readonly StrategyDescriptor[]; onCompare: (next: readonly StrategyDescriptor[]) => void; asked: boolean; onAsk: () => void }) {
  const { reference, shown } = useSummaryStrategies(compared);
  return <section className="ogs ths" aria-labelledby="ths-title">
    <div className="ogs-head">
      <div className="ogs-title">
        <h2 id="ths-title">Score Summary</h2>
        <p>Mean scores of your decisions across this table’s completed Hands, against your Reference Strategy{reference ? <> (<strong>{strategyName(reference)}</strong>)</> : null}, or side by side with others.</p>
      </div>
    </div>
    <CompareBar id="ths-compare" reference={reference} shown={shown} onCompare={onCompare} />
    {!asked && <div className="ogs-ask">
      <p>Analyses run in the background. Ones already done are reused.</p>
      <button type="button" className="primary" onClick={onAsk}>Summarize my decisions</button>
    </div>}
    {asked && <div className="ogs-columns" data-count={shown.length + 1}>
      <SummaryColumn key="reference" tableSessionId={tableSessionId} completedHands={completedHands} asked strategy={undefined} reference onRemove={() => {}} />
      {shown.map(strategy => <SummaryColumn key={strategyToken(strategy)} tableSessionId={tableSessionId} completedHands={completedHands} asked strategy={strategy} reference={false} onRemove={() => onCompare(shown.filter(other => strategyToken(other) !== strategyToken(strategy)))} />)}
    </div>}
  </section>;
}
