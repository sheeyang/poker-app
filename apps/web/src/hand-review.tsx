import type { ObservableTableSession } from '@poker/contracts';
import { Icon } from './icons.js';
import { chips } from './table-model.js';
import { SummaryResult } from './analysis-panel.js';
import type { useHandSummary } from './summaries.js';

export function HandReview({ table, summary, review }: { table: ObservableTableSession; summary: ReturnType<typeof useHandSummary>; review: (decisionId?: string) => void }) {
  const state = table.view.state;
  const humanId = table.bindings.find(b => b.controller.kind === 'human')?.participantId;
  const hand = table.view.history.find(h => h.handId === state.handId);
  const decisions = hand?.decisions.filter(d => d.action.participantId === humanId) ?? [];
  const payout = state.payouts?.filter(p => p.participantId === humanId).reduce((n, p) => n + p.amount, 0) ?? 0;
  const stack = state.participants.find(p => p.participantId === humanId)?.stack ?? 0;
  return <section className="hand-review" aria-labelledby="hand-review-title">
    <div className="hand-review-top"><div><h2 id="hand-review-title">{payout ? `You received ${chips(payout)} chips.` : 'Hand complete.'}</h2><p>Your stack: {chips(stack)} chips · {decisions.length} {decisions.length === 1 ? 'decision' : 'decisions'} to review</p></div><button className="quiet-button" disabled={!decisions.length} onClick={() => review(decisions.at(-1)?.decisionId)}>Review hand <Icon name="chart" size={17} /></button></div>
    <div className="hand-review-body">{!decisions.length && <p className="muted">You had no decisions in this hand. There’s no score to review.</p>}<div className="hand-score"><SummaryResult summary={summary} compact /></div></div>
  </section>;
}
