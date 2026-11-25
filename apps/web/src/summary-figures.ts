import type { HistoryScoreSummary, ScoreSummary } from '@poker/contracts';

/** What a Score Summary shows, one Strategy's column of Table History and Overall History alike. */
export interface SummaryFigures { decisionScore: string; actionRankScore: string; count: string; state: string | undefined; fraction?: number }

/**
 * What a Score Summary shows: both means as scores out of 100 once it is complete and "—" otherwise (never a partial
 * mean), how many decisions it covers ("No decisions" for none, "—" while score ranges are still undecided), and its
 * state: "Analyzing 340 / 2,000" with the fraction done while running, "Error" once any analysis has failed. A table's
 * Score Summary and an Overall History one read the same.
 */
export function summaryFigures(summary: ScoreSummary | HistoryScoreSummary): SummaryFigures {
  const score = (value: number) => (value * 100).toFixed(1);
  const count = summary.decisionCount === undefined ? '—' : summary.decisionCount ? `${summary.decisionCount.toLocaleString('en')} ${summary.decisionCount === 1 ? 'decision' : 'decisions'}` : 'No decisions';
  if (summary.status === 'complete') return { decisionScore: score(summary.averages.decisionScore), actionRankScore: score(summary.averages.actionRankScore), count, state: undefined };
  const none = { decisionScore: '—', actionRankScore: '—', count };
  return { ...none, ...progressFigures(summary) };
}

/**
 * What a request that waits on analyses reports while it is not complete: "Analyzing 340 / 2,000" with the fraction done
 * while running, "Error" once any analysis has failed, and nothing otherwise. Score Summaries and the score-filtered
 * list read the same.
 */
export function progressFigures({ status, progress }: { status: string; progress: { succeeded: number; total: number } }): { state: string | undefined; fraction?: number } {
  if (status === 'pending') return { state: `Analyzing ${progress.succeeded.toLocaleString('en')} / ${progress.total.toLocaleString('en')}`, fraction: progress.total ? progress.succeeded / progress.total : 0 };
  return { state: status === 'error' ? 'Error' : undefined };
}
