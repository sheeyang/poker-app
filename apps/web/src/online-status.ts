import { canDealNextHand, isEligibleParticipant, type EligibilityFacts, type ObservableTableSession } from '@poker/contracts';
import { nextHandCountdown } from './presentation.js';
import { presentBindings } from './owner-controls.js';

/**
 * Public status at an Online Table, as everyone there sees it. Pure: it mirrors the server's rules for display
 * only; the server alone connects, sits out and deals.
 */

/** Whether a human is connected to the table now; `undefined` for a Bot, and at a Practice Table. */
export function connectionOf(table: ObservableTableSession, participantId: string): 'connected' | 'disconnected' | undefined {
  if (table.mode !== 'online' || table.bindings.find(binding => binding.participantId === participantId)?.controller.kind !== 'human') return undefined;
  return table.connectedParticipantIds?.includes(participantId) ? 'connected' : 'disconnected';
}

/** The view's public facts about each Participant, as the server's dealing rule reads them. */
function eligibilityFacts(table: ObservableTableSession): (EligibilityFacts & { readonly participantId: string })[] {
  return table.view.state.participants.map(p => {
    const connection = connectionOf(table, p.participantId);
    return { participantId: p.participantId, seat: p.seat, stack: p.stack, sittingOut: p.sittingOut, human: connection !== undefined, connected: connection === 'connected' };
  });
}

/** Whether the table can deal: the server's rule (`canDealNextHand` in contracts), on the view's public facts. */
function canDeal(table: ObservableTableSession): boolean {
  return canDealNextHand(eligibilityFacts(table));
}

/**
 * Why an Online Table that cannot deal is waiting, from the viewer's side, so the tray can name what would let it deal:
 * - `take-seat`: the viewer is watching; sitting down is their way in.
 * - `no-chips`: the viewer is seated without chips; a rebuy makes them eligible.
 * - `sitting-out`: the viewer is seated with chips but Sitting Out; returning makes them eligible.
 * - `players`: the viewer is ready, and the table needs `needed` more Eligible Participants. `reconnecting` names the
 *   seated humans who would count again once they reconnect, and `sittingOut` the seated Participants who would once
 *   they return to play.
 * `undefined` once the table can deal.
 */
export type WaitingReason =
  | { readonly kind: 'take-seat' | 'sitting-out' | 'no-chips' }
  | { readonly kind: 'players'; readonly needed: number; readonly reconnecting: readonly string[]; readonly sittingOut: readonly string[] };

export function waitingReason(table: ObservableTableSession): WaitingReason | undefined {
  if (table.mode !== 'online' || canDeal(table)) return undefined;
  const you = table.view.state.participants.find(p => p.participantId === table.viewerParticipantId);
  if (you?.seat == null) return { kind: 'take-seat' };
  // Without chips, returning from sitting out changes nothing: the rebuy comes first.
  if (you.stack === 0) return { kind: 'no-chips' };
  if (you.sittingOut) return { kind: 'sitting-out' };
  const facts = eligibilityFacts(table);
  const present = presentBindings(table);
  const named = (matches: (p: typeof facts[number]) => boolean) => facts.filter(p => p.seat !== null && p.stack > 0 && p.participantId !== you.participantId && matches(p))
    .flatMap(p => present.find(b => b.participantId === p.participantId)?.name ?? []);
  return {
    kind: 'players', needed: Math.max(1, 2 - facts.filter(isEligibleParticipant).length),
    reconnecting: named(p => p.human && !p.connected && !p.sittingOut),
    sittingOut: named(p => p.sittingOut),
  };
}

/** The other humans at an Online Table who are present but have no Seat, by name: who is watching. The tray tells the viewer about themselves. */
export function watchingNames(table: ObservableTableSession): string[] {
  if (table.mode !== 'online') return [];
  const seated = new Set(table.view.state.participants.filter(p => p.seat !== null).map(p => p.participantId));
  return presentBindings(table).filter(b => b.controller.kind === 'human' && b.participantId !== table.viewerParticipantId && !seated.has(b.participantId)).map(b => b.name);
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
  return status.kind === 'soon' ? `${hand} coming up` : 'Waiting for players';
}

/**
 * What the tray says about a waiting table, and what it offers: its explanation of `reason`. `owner`: the viewer is the
 * Table Owner, who can share the Join Link and add Bots.
 */
export function waitingDetail(reason: WaitingReason, owner: boolean): string {
  switch (reason.kind) {
    case 'take-seat': return 'You’re watching. Take an open seat to play; you’re dealt in from the next hand.';
    case 'sitting-out': return 'You’re sitting out, so you’re not dealt in. Return to play when you’re ready.';
    case 'no-chips': return 'You’re out of chips. Rebuy from Table options to be dealt in.';
    case 'players': {
      const one = reason.needed === 1, others = one ? 'one more player' : `${reason.needed} more players`;
      const state = (names: readonly string[], what: string) => names.length ? `${names.join(', ')} ${names.length === 1 ? 'is' : 'are'} ${what}. ` : '';
      const absent = state(reason.reconnecting, 'disconnected') + state(reason.sittingOut, 'sitting out');
      const invite = owner ? ' Share the join link, or add a Bot.' : '';
      // Someone seated could make up the numbers by coming back; otherwise a newcomer has to sit down.
      return absent ? `${absent}Hands start once ${others} ${one ? 'is' : 'are'} ready.${invite}` : owner ? `Hands start once ${others} ${one ? 'is' : 'are'} seated.${invite}` : `Hands start once ${others} ${one ? 'takes' : 'take'} a seat.`;
    }
  }
}
