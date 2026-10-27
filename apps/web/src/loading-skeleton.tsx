/** Static presentation placeholders: no fabricated scores, probabilities or cards. */
export function Skeleton({ className = '' }: { className?: string }) {
  return <span className={`ui-skeleton ${className}`} aria-hidden="true" />;
}

export function ScoreSkeleton() {
  return <span className="ui-skeleton skeleton-score" role="img" aria-label="Score pending" />;
}

export function AnalysisSkeleton({ actions, scores, sampled }: { actions: readonly { type: string }[]; scores: boolean; sampled: boolean }) {
  const types = [...new Set(actions.map(action => action.type))];
  return <div className="analysis-skeleton" role="status" aria-label="Loading reference analysis"><div aria-hidden="true">
    {scores && <div className="decision-scores"><div className="score-main"><span>Decision Score</span><strong><Skeleton className="skeleton-score" /><small>/100</small></strong></div><div className="score-secondary"><span>Action Rank Score</span><strong><Skeleton className="skeleton-score" /><small>/100</small></strong></div></div>}
    <div className="distribution-heading"><h3>Reference actions</h3><span>Probability</span></div>
    <ul className="probability-tree">{(types.length ? types : ['', '', '']).map((type, index) => <li className="probability-group" key={type || index}><div className="probability-row"><span>{type ? type[0]!.toUpperCase() + type.slice(1) : <Skeleton className="skeleton-action" />}</span><Skeleton className="skeleton-probability" /></div><Skeleton className="skeleton-meter" />{(type === 'bet' || type === 'raise') && <ul>{[0, 1].map(row => <li key={row}><Skeleton className="skeleton-sizing" /><Skeleton className="skeleton-probability" /></li>)}</ul>}</li>)}</ul>
    <div className="reference-selected"><span>{sampled ? 'Sampled action' : 'Selected action'}</span><Skeleton className="skeleton-action" /></div>
  </div></div>;
}

export function SavedTableSkeleton() {
  return <li className="saved-table saved-table-skeleton" role="status" aria-label="Loading saved table"><div aria-hidden="true"><span className="saved-table-copy"><Skeleton className="skeleton-table-title" /><Skeleton className="skeleton-table-detail" /><Skeleton className="skeleton-table-state" /></span><Skeleton className="skeleton-resume" /></div></li>;
}

export function SavedTablesSkeleton() {
  return <ul className="return-list" aria-label="Loading saved tables">{[0, 1, 2].map(row => <SavedTableSkeleton key={row} />)}</ul>;
}

export function TableSkeleton() {
  return <div className="table-loading table-skeleton" role="status" aria-label="Opening your table"><div className="table-skeleton-content" aria-hidden="true"><Skeleton className="skeleton-hand-status" /><div className="loading-oval"><div className="skeleton-board">{[0, 1, 2, 3, 4].map(card => <Skeleton className="skeleton-card" key={card} />)}</div>{[0, 1, 2, 3].map(seat => <Skeleton className={`skeleton-seat skeleton-seat-${seat}`} key={seat} />)}</div><div className="skeleton-controls">{[0, 1, 2].map(control => <Skeleton key={control} />)}</div></div></div>;
}
