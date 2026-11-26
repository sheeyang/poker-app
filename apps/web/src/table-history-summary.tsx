import { api } from '@poker/client';
import { strategyToken, type ScoreSummary, type StrategyDescriptor } from '@poker/contracts';
import { HistorySummaryPanel, Means, MeansSkeleton, Progress, RequestAgainNotice, RetryNotice, SummaryColumnFrame } from './history-summary.js';
import { followedTableSummary } from './table-history.js';
import { useFollowedRequest } from './use-followed-request.js';

/**
 * A Score Summary of the viewer's own decisions across the table's completed Hands, under one Strategy (the User's
 * Reference Strategy when none is named). While it is Analyzing its count follows the User's `progress` messages, and its
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

/** One Strategy's column: its means, its own Analyzing, Error and Retry. Another Strategy failing never touches it. */
function SummaryColumn({ tableSessionId, completedHands, asked, strategy, reference, onRemove }: { tableSessionId: string; completedHands: number | undefined; asked: boolean; strategy: StrategyDescriptor | undefined; reference: boolean; onRemove: () => void }) {
  const summary = useTableSummary(tableSessionId, completedHands, asked, strategy);
  const data: ScoreSummary | undefined = summary.data;
  return <SummaryColumnFrame idPrefix="table-history-summary" strategy={strategy} named={data?.referenceStrategy ?? strategy} reference={reference} onRemove={onRemove} busy={summary.stale || summary.loading || data?.status === 'pending'}>
    {summary.error && !data && <RequestAgainNotice message={summary.error.message} onAgain={summary.again} />}
    {summary.loading && <MeansSkeleton />}
    {data && <>
      <Means summary={data} />
      <Progress summary={data} />
      {data.status === 'empty' && <p className="history-summary-note">You have no decisions at this table yet, so there is no score.</p>}
      {data.status === 'error' && <RetryNotice message={`${data.error.message || 'An analysis failed, so this summary has no score.'} Retry analyzes only the failed ones again.`} retrying={summary.retrying} onRetry={summary.retry} />}
      {data.status !== 'error' && summary.error && <RequestAgainNotice message={summary.error.message} onAgain={summary.again} />}
    </>}
  </SummaryColumnFrame>;
}

/**
 * The table's Score Summary in Table History (ADR-0041): your decisions across its completed Hands, asked for explicitly,
 * under your Reference Strategy and, side by side, up to 3 more the address names. The comparison is the address's
 * `compare`, the same one the replay compares at a decision, and never changes the Trainer Configuration.
 */
export function TableHistorySummaryPanel({ tableSessionId, completedHands, compared, onCompare, asked, onAsk }: { tableSessionId: string; completedHands: number | undefined; compared: readonly StrategyDescriptor[]; onCompare: (next: readonly StrategyDescriptor[]) => void; asked: boolean; onAsk: () => void }) {
  return <HistorySummaryPanel idPrefix="table-history-summary" compared={compared} onCompare={onCompare} asked={asked}
    description={reference => <>Mean scores of your decisions across this table’s completed Hands, against your Reference Strategy{reference}, or side by side with others.</>}
    ask={<>
      <p>Analyses run in the background. Ones already done are reused.</p>
      <button type="button" className="primary" onClick={onAsk}>Summarize my decisions</button>
    </>}
    column={(strategy, reference, onRemove) => <SummaryColumn key={strategy ? strategyToken(strategy) : 'reference'} tableSessionId={tableSessionId} completedHands={completedHands} asked strategy={strategy} reference={reference} onRemove={onRemove} />} />;
}
