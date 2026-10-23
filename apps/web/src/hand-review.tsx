import type { ObservableTableSession } from '@poker/contracts';
import { chips } from './table-model.js';
import { SummaryResult } from './analysis-panel.js';
import type { useHandSummary } from './summaries.js';

export function HandReview({ table, summary }: { table: ObservableTableSession; summary: ReturnType<typeof useHandSummary> }) {
  const state = table.view.state;
  const humanId = table.bindings.find(b => b.controller.kind === 'human')?.participantId;
  const hand = table.view.history.find(h => h.handId === state.handId);
  const decisions = hand?.decisions.filter(d => d.action.participantId === humanId) ?? [];
  const payout = state.payouts?.filter(p => p.participantId === humanId).reduce((n, p) => n + p.amount, 0) ?? 0;
  return <section className="hand-review" aria-labelledby="hand-review-title">
    <div className="hand-review-top"><h2 id="hand-review-title">{payout ? `You received ${chips(payout)} chips.` : 'Hand complete.'}</h2><p>{decisions.length} {decisions.length === 1 ? 'decision' : 'decisions'} to review</p></div>
    <div className="hand-review-body">{!decisions.length && <p className="muted">You had no decisions in this hand. There’s no score to review.</p>}<div className="hand-score"><SummaryResult summary={summary} compact /></div></div>
  </section>;
}
