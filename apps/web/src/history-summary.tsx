import type { ReactNode } from 'react';
import type { HistoryScoreSummary, ScoreSummary, StrategyDescriptor } from '@poker/contracts';
import { strategyToken } from '@poker/contracts';
import { strategyName } from './strategy-select.js';
import { summaryFigures } from './summary-figures.js';
import { ColumnHead, CompareBar, useSummaryStrategies } from './summary-comparison.js';

/**
 * The Score Summary panel Table History and Overall History share (ADR-0041): its heading and description, the
 * "Compare with" bar, what asks for it, and one column per Strategy once asked. Each screen supplies what differs: the
 * description, a breakdown control, the ask, and the column.
 */
export function HistorySummaryPanel({ idPrefix, description, controls, compared, onCompare, asked, ask, column }: {
  idPrefix: string;
  /** The sentence under the heading, given the Reference Strategy's name (once it is read) to place in it. */
  description: (reference: ReactNode) => ReactNode;
  /** Beside the heading, such as Overall History's breakdown. */
  controls?: ReactNode;
  compared: readonly StrategyDescriptor[]; onCompare: (next: readonly StrategyDescriptor[]) => void;
  asked: boolean;
  /** The note and button that ask for the summary, shown until it is asked for. */
  ask: ReactNode;
  /** One Strategy's column; `strategy` is undefined for the Reference Strategy's. */
  column: (strategy: StrategyDescriptor | undefined, reference: boolean, onRemove: () => void) => ReactNode;
}) {
  const { reference, shown } = useSummaryStrategies(compared);
  const names = reference ? <> (<strong>{strategyName(reference)}</strong>)</> : null;
  return <section className="history-summary" aria-labelledby={`${idPrefix}-title`}>
    <div className="history-summary-head">
      <div className="history-summary-title">
        <h2 id={`${idPrefix}-title`}>Score Summary</h2>
        <p>{description(names)}</p>
      </div>
      {controls}
    </div>
    <CompareBar id={`${idPrefix}-compare`} reference={reference} shown={shown} onCompare={onCompare} />
    {!asked && <div className="history-summary-ask">{ask}</div>}
    {asked && <div className="history-summary-columns" data-count={shown.length + 1}>
      {column(undefined, true, () => {})}
      {shown.map(strategy => column(strategy, false, () => onCompare(shown.filter(other => strategyToken(other) !== strategyToken(strategy)))))}
    </div>}
  </section>;
}

/** One Strategy's column: its heading, with the Reference tag or Remove, then whatever it shows. */
export function SummaryColumnFrame({ idPrefix, strategy, named, reference, onRemove, busy, children }: { idPrefix: string; strategy: StrategyDescriptor | undefined; named: StrategyDescriptor | undefined; reference: boolean; onRemove: () => void; busy: boolean; children: ReactNode }) {
  const headingId = `${idPrefix}-column-${strategy ? strategyToken(strategy) : 'reference'}`;
  return <article className="history-summary-column" aria-labelledby={headingId} aria-busy={busy || undefined}>
    <ColumnHead headingId={headingId} name={named ? strategyName(named) : 'Reference Strategy'} reference={reference} onRemove={onRemove} />
    {children}
  </article>;
}

/** Both means, out of 100, beside how many decisions they cover. */
export function Means({ summary }: { summary: ScoreSummary | HistoryScoreSummary }) {
  const figures = summaryFigures(summary);
  return <div className="history-summary-means" aria-live="polite" aria-atomic="true">
    <div className="history-summary-mean"><span>Mean Decision Score</span><strong className="numeric">{figures.decisionScore}<small>/100</small></strong></div>
    <div className="history-summary-mean is-secondary"><span>Mean Action Rank Score</span><strong className="numeric">{figures.actionRankScore}<small>/100</small></strong></div>
    <div className="history-summary-mean is-count"><span>Decisions</span><strong className="numeric">{summary.decisionCount === undefined ? '—' : summary.decisionCount ? summary.decisionCount.toLocaleString('en') : 'No decisions'}</strong></div>
  </div>;
}

/** The means' placeholders while the summary is being requested. */
export function MeansSkeleton() {
  return <div className="history-summary-means" role="status" aria-label="Requesting the summary"><div className="history-summary-mean"><span>Mean Decision Score</span><strong className="numeric">—<small>/100</small></strong></div><div className="history-summary-mean is-secondary"><span>Mean Action Rank Score</span><strong className="numeric">—<small>/100</small></strong></div></div>;
}

/** Progress while Analyzing: the count of succeeded analyses out of the whole set, as a figure and a fine brass rule. */
export function Progress({ summary }: { summary: ScoreSummary | HistoryScoreSummary }) {
  if (summary.status !== 'pending') return null;
  return <div className="history-summary-progress">
    <span className="numeric" role="status">{summaryFigures(summary).state}</span>
    <progress max={summary.progress.total || 1} value={summary.progress.succeeded} aria-label="Analyses succeeded" />
  </div>;
}

/** The notice for a request that could not be made or read, with its way to ask again. */
export function RequestAgainNotice({ message, onAgain }: { message: string; onAgain: () => void }) {
  return <div className="notice-error" role="alert"><p>{message}</p><button type="button" onClick={onAgain}>Request summary again</button></div>;
}

/** The notice for failed analyses, with a Retry that analyzes only those again. */
export function RetryNotice({ message, retrying, onRetry }: { message: string; retrying: boolean; onRetry: () => void }) {
  return <div className="notice-error" role="alert">
    <p>{message}</p>
    <button type="button" disabled={retrying} onClick={onRetry}>{retrying ? 'Retrying…' : 'Retry'}</button>
  </div>;
}
