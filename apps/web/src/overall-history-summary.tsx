import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@poker/client';
import { historyBreakdowns, historyFilterParams, type HistoryBreakdown, type HistoryFilter, type HistoryScoreSummary, type OverallHistorySummary } from '@poker/contracts';
import { bucketLabel, summaryFigures } from './overall-history.js';
import { strategyName } from './strategy-select.js';

const breakdownNames: Readonly<Record<HistoryBreakdown, string>> = { street: 'Street', position: 'Position', action: 'Action', mode: 'Table' };
const running = (summary: OverallHistorySummary | undefined) => !!summary && [summary.summary, ...summary.buckets?.map(bucket => bucket.summary) ?? []].some(each => each.status === 'pending');
const failed = (summary: OverallHistorySummary | undefined) => !!summary && [summary.summary, ...summary.buckets?.map(bucket => bucket.summary) ?? []].some(each => each.status === 'error');

/**
 * An Overall History Score Summary over `filter`, broken down by `breakdown`, once `asked`. A new filter or breakdown
 * asks again (matching analyses are reused). While any of its summaries is Analyzing it is read again each second, for
 * its progress; Retry asks again only for the failed analyses.
 */
function useOverallHistorySummary(filter: HistoryFilter, breakdown: HistoryBreakdown | undefined, asked: boolean) {
  const queryClient = useQueryClient();
  const key = JSON.stringify([historyFilterParams(filter), breakdown ?? null]);
  const created = useQuery({
    queryKey: ['overall-history-summary', key], enabled: asked, staleTime: Number.POSITIVE_INFINITY, gcTime: 0, retry: false, placeholderData: keepPreviousData,
    queryFn: () => api.requestOverallHistorySummary(filter, breakdown),
  });
  const requestId = created.data?.requestId;
  const current = useQuery({
    queryKey: ['overall-history-summary-state', requestId], enabled: !!requestId && !created.isPlaceholderData, initialData: created.data, retry: false,
    refetchInterval: query => running(query.state.data) && !query.state.error ? 1000 : false,
    queryFn: ({ signal }) => api.readOverallHistorySummary(requestId!, signal),
  });
  const retry = useMutation({
    mutationFn: (id: string) => api.retryOverallHistorySummary(id),
    onSuccess: summary => queryClient.setQueryData(['overall-history-summary-state', summary.requestId], summary),
  });
  const data = created.isPlaceholderData ? created.data : current.data ?? created.data;
  return {
    data, stale: created.isPlaceholderData,
    error: created.error ?? current.error ?? retry.error,
    loading: asked && !data && created.isFetching,
    retrying: retry.isPending,
    retry: () => { if (data) retry.mutate(data.requestId); },
    again: () => { retry.reset(); void created.refetch(); },
  };
}

/** Both means, out of 100, beside how many decisions they cover. */
function Means({ summary }: { summary: HistoryScoreSummary }) {
  const figures = summaryFigures(summary);
  return <div className="ogs-means" aria-live="polite" aria-atomic="true">
    <div className="ogs-mean"><span>Mean Decision Score</span><strong className="numeric">{figures.decisionScore}<small>/100</small></strong></div>
    <div className="ogs-mean is-secondary"><span>Mean Action Rank Score</span><strong className="numeric">{figures.actionRankScore}<small>/100</small></strong></div>
    <div className="ogs-mean is-count"><span>Decisions</span><strong className="numeric">{summary.decisionCount ? summary.decisionCount.toLocaleString('en') : 'No decisions'}</strong></div>
  </div>;
}

/** Progress while Analyzing: the count of succeeded analyses out of the whole set, as a figure and a fine brass rule. */
function Progress({ summary }: { summary: HistoryScoreSummary }) {
  const figures = summaryFigures(summary);
  if (summary.status !== 'pending') return null;
  return <div className="ogs-progress">
    <span className="numeric" role="status">{figures.state}</span>
    <progress max={summary.progress.total || 1} value={summary.progress.succeeded} aria-label="Analyses succeeded" />
  </div>;
}

/** One row of a breakdown: the bucket, its decisions, and its means, or what it is waiting on. */
function BucketRow({ breakdown, value, summary }: { breakdown: HistoryBreakdown; value: string; summary: HistoryScoreSummary }) {
  const figures = summaryFigures(summary);
  return <tr className={`ogs-bucket is-${summary.status}`}>
    <th scope="row">{bucketLabel(breakdown, value)}</th>
    <td className="numeric">{summary.decisionCount.toLocaleString('en')}</td>
    {summary.status === 'complete'
      ? <><td className="numeric ogs-score">{figures.decisionScore}</td><td className="numeric ogs-score is-secondary">{figures.actionRankScore}</td></>
      : <td colSpan={2} className="ogs-waiting numeric">{figures.state ?? '—'}</td>}
  </tr>;
}

/**
 * The Score Summary over the decisions the filters show (ADR-0041): explicitly asked for, under the Guest's Reference
 * Strategy, with its progress while it runs, Error and Retry when an analysis fails, and no score for an empty set.
 * A breakdown, one dimension at a time and held in the address, gives one ordinary summary per bucket.
 */
export function OverallHistorySummaryPanel({ filter, breakdown, total, asked, scoreRanges, onAsk, onBreakdown }: { filter: HistoryFilter; scoreRanges?: boolean; breakdown: HistoryBreakdown | undefined; total: number | undefined; asked: boolean; onAsk: () => void; onBreakdown: (next: HistoryBreakdown | undefined) => void }) {
  const summary = useOverallHistorySummary(filter, breakdown, asked);
  const data = summary.data;
  return <section className="ogs" aria-labelledby="ogs-title" aria-busy={summary.stale || summary.loading || undefined}>
    <div className="ogs-head">
      <div className="ogs-title">
        <h2 id="ogs-title">Score Summary</h2>
        <p>{data ? <>Against <strong>{strategyName(data.referenceStrategy)}</strong>, your Reference Strategy when you asked.</> : 'Mean scores of the decisions shown here, against your Reference Strategy.'}</p>
      </div>
      <fieldset className="ogs-breakdown">
        <legend>Break down by</legend>
        <div className="og-chips">
          <button type="button" className="og-chip" aria-pressed={!breakdown} onClick={() => onBreakdown(undefined)}>None</button>
          {historyBreakdowns.map(each => <button key={each} type="button" className="og-chip" aria-pressed={breakdown === each} onClick={() => onBreakdown(each)}>{breakdownNames[each]}</button>)}
        </div>
      </fieldset>
    </div>
    {scoreRanges && <p className="ogs-note">Score ranges do not narrow this summary: it covers the decisions the other filters admit.</p>}
    {!asked && <div className="ogs-ask">
      <p>Large sets are analyzed in the background, with a running count. Analyses already done are reused.</p>
      <button type="button" className="primary" disabled={total === undefined} onClick={onAsk}>{total === undefined ? 'Summarize' : total === 0 ? 'Summarize' : `Summarize ${total.toLocaleString('en')} ${total === 1 ? 'decision' : 'decisions'}`}</button>
    </div>}
    {asked && summary.error && !data && <div className="notice-error" role="alert"><p>{summary.error.message}</p><button type="button" onClick={summary.again}>Request summary again</button></div>}
    {asked && summary.loading && <div className="ogs-means" role="status" aria-label="Requesting the summary"><div className="ogs-mean"><span>Mean Decision Score</span><strong className="numeric">—<small>/100</small></strong></div><div className="ogs-mean is-secondary"><span>Mean Action Rank Score</span><strong className="numeric">—<small>/100</small></strong></div></div>}
    {asked && data && <>
      <Means summary={data.summary} />
      <Progress summary={data.summary} />
      {data.summary.status === 'empty' && <p className="ogs-note">No decisions match these filters, so there is no score.</p>}
      {failed(data) && <div className="notice-error" role="alert">
        <p>{summary.error ? summary.error.message : `Some analyses failed, so ${data.summary.status === 'error' ? 'this summary has' : 'some buckets have'} no score. ${data.summary.progress.succeeded.toLocaleString('en')} of ${data.summary.progress.total.toLocaleString('en')} succeeded; Retry analyzes only the failed ones again.`}</p>
        <button type="button" disabled={summary.retrying} onClick={summary.retry}>{summary.retrying ? 'Retrying…' : 'Retry'}</button>
      </div>}
      {!failed(data) && summary.error && <div className="notice-error" role="alert"><p>{summary.error.message}</p><button type="button" onClick={summary.again}>Request summary again</button></div>}
      {data.breakdown && data.buckets && data.buckets.length > 0 && <table className="ogs-table">
        <caption className="visually-hidden">Score Summary by {breakdownNames[data.breakdown].toLowerCase()}</caption>
        <thead><tr><th scope="col">{breakdownNames[data.breakdown]}</th><th scope="col">Decisions</th><th scope="col">Decision Score</th><th scope="col">Action Rank Score</th></tr></thead>
        <tbody>{data.buckets.map(bucket => <BucketRow key={bucket.value} breakdown={data.breakdown!} value={bucket.value} summary={bucket.summary} />)}</tbody>
      </table>}
    </>}
  </section>;
}
