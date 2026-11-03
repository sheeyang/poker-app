import { canDealNextHand, type EligibilityFacts, type ObservableCashGameState, type ParticipantId, type ServerTime, type TableSchedule } from '@poker/contracts';
import { presentationEndsAt } from './schedule.js';

/**
 * Automatic Dealing at Online Tables (ADR-0032). Pure: the caller supplies the committed table's public state,
 * who is human, who is connected (transient, never persisted) and the time from the injected clock.
 *
 * Between Hands the server announces a Next-Hand Countdown once the last Hand's presentation (its payout and the
 * pause between Hands) has ended, its after-Hand requests have been applied, and the table can deal. When the
 * countdown expires it rechecks: humans still disconnected are sat out first, then the Hand starts if the table
 * can still deal, and otherwise the countdown is cancelled. A cancelled countdown is replaced by a fresh one as
 * soon as a commit or a connection change lets the table deal again.
 */
export interface DealingParticipant extends EligibilityFacts {
  readonly participantId: ParticipantId;
}

/** The table deals only while at least two Eligible Participants remain, one of them human (contracts, which the Trainer shares). */
export const canDeal = (participants: readonly DealingParticipant[]): boolean => canDealNextHand(participants);

/** The humans an expired countdown sits out first: seated, not sitting out, and still disconnected. */
export function stillDisconnected(participants: readonly DealingParticipant[]): ParticipantId[] {
  return participants.filter(participant => participant.human && participant.seat !== null && !participant.sittingOut && !participant.connected).map(participant => participant.participantId);
}

/**
 * What Automatic Dealing has to do now, if anything:
 * - `expire`: the Next-Hand Countdown has expired, so eligibility is rechecked, and the table deals or cancels it;
 * - `announce`: no countdown is running, no Hand is in progress or still presented, no after-Hand request waits,
 *   and the table can deal.
 */
export function dealingStep(table: { readonly status: ObservableCashGameState['status']; readonly schedule: TableSchedule; readonly pendingChanges: number; readonly participants: readonly DealingParticipant[] }, now: ServerTime): 'expire' | 'announce' | undefined {
  if (table.status === 'active-hand') return undefined;
  const countdown = table.schedule.nextHandCountdown;
  if (countdown) return now >= countdown.endsAt ? 'expire' : undefined;
  const presented = presentationEndsAt(table.schedule);
  if (presented !== undefined && now < presented || table.pendingChanges > 0) return undefined;
  return canDeal(table.participants) ? 'announce' : undefined;
}
