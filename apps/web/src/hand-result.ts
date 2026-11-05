import type { ObservableTableSession } from '@poker/contracts';
import { chips } from './table-model.js';

/**
 * How the viewer's last Hand ended, for the tray that follows it. It lives inside the tray rather than in a block of
 * its own so that finishing a Hand never changes how much room the table has.
 */
export function handResult(table: ObservableTableSession): { readonly headline: string; readonly detail: string } | undefined {
  const state = table.view.state;
  if (state.status !== 'completed-hand' || !state.handId) return undefined;
  const humanId = table.viewerParticipantId;
  const decisions = table.view.history.find(h => h.handId === state.handId)?.decisions.filter(d => d.action.participantId === humanId) ?? [];
  const payout = state.payouts?.filter(p => p.participantId === humanId).reduce((n, p) => n + p.amount, 0) ?? 0;
  return {
    headline: payout ? `You received ${chips(payout)} chips.` : 'Hand complete.',
    detail: decisions.length ? `${decisions.length} ${decisions.length === 1 ? 'decision' : 'decisions'} to review.` : 'You had no decisions in this hand, so there’s no score to review.',
  };
}
