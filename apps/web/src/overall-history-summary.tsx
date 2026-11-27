import { api } from '@poker/client';
import { historyBreakdowns, historyFilterParams, strategyToken, type HistoryBreakdown, type HistoryFilter, type HistoryScoreSummary, type OverallHistorySummary, type StrategyDescriptor } from '@poker/contracts';
import { HistorySummaryPanel, Means, MeansSkeleton, Progress, RequestAgainNotice, RetryNotice, SummaryColumnFrame } from './history-summary.js';
import { bucketLabel, bucketWaiting, followedSummary } from './overall-history.js';
import { strategyName } from './strategy-select.js';
import { summaryFigures } from './summary-figures.js';
import { useFollowedRequest } from './use-followed-request.js';

const breakdownNames: Readonly<Record<HistoryBreakdown, string>> = { street: 'Street', position: 'Position', action: 'Action', mode: 'Table' };
const failed = (summary: OverallHistorySummary | undefined) => !!summary && [summary.summary, ...summary.buckets?.map(bucket => bucket.summary) ?? []].some(each => each.status === 'error');

/**
 * An Overall History Score Summary over `filter`, broken down by `breakdown`, once `asked`. A new filter or breakdown
 * asks again (matching analyses are reused). While it is Analyzing its count follows the User's `progress` messages,
 * and each completion or failure notice reads it again; Retry asks again only for the failed analyses. `strategy` names
 * the Strategy to summarize under; without one it is the User's current Reference Strategy. Each Strategy is its own
 * request, with its own progress and Error.
 */
function useOverallHistorySummary(filter: HistoryFilter, breakdown: HistoryBreakdown | undefined, asked: boolean, strategy: StrategyDescriptor | undefined) {
  const summary = useFollowedRequest({
    key: JSON.stringify([historyFilterParams(filter), breakdown ?? null, strategy ? strategyToken(strategy) : null]),
    enabled: asked, keepPrevious: true, model: followedSummary,
    create: () => api.requestOverallHistorySummary(filter, breakdown, strategy),
    read: requestId => api.readOverallHistorySummary(requestId),
    retry: requestId => api.retryOverallHistorySummary(requestId),
  });
  return { ...summary, loading: asked && !summary.data && summary.asking };
}

/** One row of a breakdown: the bucket, its decisions, and its means, or what it is waiting on. */
function BucketRow({ breakdown, value, summary }: { breakdown: HistoryBreakdown; value: string; summary: HistoryScoreSummary }) {
  const figures = summaryFigures(summary);
  return <tr className={`history-summary-bucket is-${summary.status}`}>
    <th scope="row">{bucketLabel(breakdown, value)}</th>
    <td className="numeric">{summary.decisionCount?.toLocaleString('en') ?? '—'}</td>
    {summary.status === 'complete'
      ? <><td className="numeric history-summary-score">{figures.decisionScore}</td><td className="numeric history-summary-score is-secondary">{figures.actionRankScore}</td></>
      : <td colSpan={2} className="history-summary-waiting">{bucketWaiting(summary)}</td>}
  </tr>;
}

/**
 * One Strategy's Score Summary of the set: its means, its progress while Analyzing, its own Error and Retry, and its
 * breakdown. Another Strategy failing or still running never touches it.
 */
function SummaryColumn({ filter, breakdown, asked, strategy, reference, onRemove }: { filter: HistoryFilter; breakdown: HistoryBreakdown | undefined; asked: boolean; strategy: StrategyDescriptor | undefined; reference: boolean; onRemove: () => void }) {
  const summary = useOverallHistorySummary(filter, breakdown, asked, strategy);
  const data = summary.data;
  return <SummaryColumnFrame idPrefix="history-summary" strategy={strategy} named={data?.referenceStrategy ?? strategy} reference={reference} onRemove={onRemove} busy={summary.stale || summary.loading}>
    {asked && summary.error && !data && <RequestAgainNotice message={summary.error.message} onAgain={summary.again} />}
    {asked && summary.loading && <MeansSkeleton />}
    {asked && data && <>
      <Means summary={data.summary} />
      <Progress summary={data.summary} />
      {data.summary.status === 'empty' && <p className="history-summary-note">{data.summary.progress.total ? 'No decisions fall in these score ranges, so there is no score.' : 'No decisions match these filters, so there is no score.'}</p>}
      {failed(data) && <RetryNotice message={summary.error ? summary.error.message : `Some analyses failed, so ${data.summary.status === 'error' ? 'this summary has' : 'some buckets have'} no score. ${data.summary.progress.succeeded.toLocaleString('en')} of ${data.summary.progress.total.toLocaleString('en')} succeeded; Retry analyzes only the failed ones again.`} retrying={summary.retrying} onRetry={summary.retry} />}
      {!failed(data) && summary.error && <RequestAgainNotice message={summary.error.message} onAgain={summary.again} />}
      {data.breakdown && data.buckets && data.buckets.length > 0 && <table className="history-summary-table">
        <caption className="visually-hidden">Score Summary by {breakdownNames[data.breakdown].toLowerCase()}, under {strategyName(data.referenceStrategy)}</caption>
        <thead><tr><th scope="col">{breakdownNames[data.breakdown]}</th><th scope="col">Decisions</th><th scope="col">Decision Score</th><th scope="col">Action Rank Score</th></tr></thead>
        <tbody>{data.buckets.map(bucket => <BucketRow key={bucket.value} breakdown={data.breakdown!} value={bucket.value} summary={bucket.summary} />)}</tbody>
      </table>}
    </>}
  </SummaryColumnFrame>;
}

/**
 * The Score Summary over the decisions the filters show (ADR-0041): explicitly asked for, under the User's Reference
 * Strategy and, side by side, up to 3 more the address names, each column with its progress, Error and Retry, and no score
 * for an empty set. A breakdown, one dimension at a time and held in the address, gives one ordinary summary per bucket.
 * Score ranges narrow every summary, each under its own column's Strategy, once all of the set's analyses have succeeded;
 * until then the count of decisions they cover is unknown, so `total` may be absent.
 */
export function OverallHistorySummaryPanel({ filter, breakdown, compared, total, asked, scoreRanges, onAsk, onBreakdown, onCompare }: { filter: HistoryFilter; scoreRanges?: boolean; breakdown: HistoryBreakdown | undefined; compared: readonly StrategyDescriptor[]; total: number | undefined; asked: boolean; onAsk: () => void; onBreakdown: (next: HistoryBreakdown | undefined) => void; onCompare: (next: readonly StrategyDescriptor[]) => void }) {
  return <HistorySummaryPanel idPrefix="history-summary" compared={compared} onCompare={onCompare} asked={asked}
    description={reference => <>Mean scores of the decisions shown here, against your Reference Strategy{reference}, or side by side with others.</>}
    controls={<fieldset className="history-summary-breakdown">
      <legend>Break down by</legend>
      <div className="overall-history-chips">
        <button type="button" className="overall-history-chip" aria-pressed={!breakdown} onClick={() => onBreakdown(undefined)}>None</button>
        {historyBreakdowns.map(each => <button key={each} type="button" className="overall-history-chip" aria-pressed={breakdown === each} onClick={() => onBreakdown(each)}>{breakdownNames[each]}</button>)}
      </div>
    </fieldset>}
    ask={<>
      <p>{scoreRanges ? 'Score ranges apply once every decision the other filters admit is analyzed, under each Strategy shown. ' : ''}Large sets are analyzed in the background, with a running count. Analyses already done are reused.</p>
      <button type="button" className="primary" disabled={total === undefined && !scoreRanges} onClick={onAsk}>{total === undefined ? 'Summarize' : total === 0 ? 'Summarize' : `Summarize ${total.toLocaleString('en')} ${total === 1 ? 'decision' : 'decisions'}`}</button>
    </>}
    column={(strategy, reference, onRemove) => <SummaryColumn key={strategy ? strategyToken(strategy) : 'reference'} filter={filter} breakdown={breakdown} asked={asked} strategy={strategy} reference={reference} onRemove={onRemove} />} />;
}
