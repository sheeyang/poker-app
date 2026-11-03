import { canDealNextHand, type ObservableTableSession } from '@poker/contracts';
import { nextHandCountdown } from './presentation.js';

/**
 * Public status at an Online Table, as everyone there sees it. Pure: it mirrors the server's rules for display
 * only; the server alone connects, sits out and deals.
 */

/** Whether a human is connected to the table now; `undefined` for a Bot, and at a Practice Table. */
export function connectionOf(table: ObservableTableSession, participantId: string): 'connected' | 'disconnected' | undefined {
  if (table.mode !== 'online' || table.bindings.find(binding => binding.participantId === participantId)?.controller.kind !== 'human') return undefined;
  return table.connectedParticipantIds?.includes(participantId) ? 'connected' : 'disconnected';
}

/** Whether the table can deal: the server's rule (`canDealNextHand` in contracts), on the view's public facts. */
function canDeal(table: ObservableTableSession): boolean {
  return canDealNextHand(table.view.state.participants.map(p => {
    const connection = connectionOf(table, p.participantId);
    return { seat: p.seat, stack: p.stack, sittingOut: p.sittingOut, human: connection !== undefined, connected: connection === 'connected' };
  }));
}

export type NextHandStatus = { readonly kind: 'countdown'; readonly seconds: number } | { readonly kind: 'soon' | 'waiting' } | undefined;

/**
 * What happens next between Hands at an Online Table at server time `serverNow`:
 * - `countdown`: the Next-Hand Countdown is running, with whole seconds left;
 * - `soon`: the table can deal, so the server announces a countdown once the last Hand's pause is over;
 * - `waiting`: it cannot, until two Eligible Participants, one of them a connected human, are ready.
 * `undefined` during a Hand and at Practice Tables, where the human deals.
 */
export function nextHandStatus(table: ObservableTableSession, serverNow: number): NextHandStatus {
  if (table.mode !== 'online' || table.view.state.status === 'active-hand') return undefined;
  const seconds = nextHandCountdown(table, serverNow);
  if (seconds !== undefined) return { kind: 'countdown', seconds };
  return { kind: canDeal(table) ? 'soon' : 'waiting' };
}

/** What everyone at the table is told about the next Hand; `first` before any Hand has been dealt. */
export function nextHandLabel(status: NextHandStatus, first = false): string | undefined {
  if (!status) return undefined;
  const hand = first ? 'First hand' : 'Next hand';
  if (status.kind === 'countdown') return status.seconds > 0 ? `${hand} in ${status.seconds}s` : 'Dealing…';
  return status.kind === 'soon' ? `${hand} coming up` : 'Waiting for two Participants ready to play, one of them a connected person';
}
