import type { ObservableCashGameState, ParticipantId, ServerTime, TableSchedule } from '@poker/contracts';
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
export interface DealingParticipant {
  readonly participantId: ParticipantId;
  readonly seat: number | null;
  readonly stack: number;
  readonly sittingOut: boolean;
  readonly human: boolean;
  /** For a human: at least one live connection of their Guest is subscribed to the table. */
  readonly connected: boolean;
}

/** An Eligible Participant: seated with chips, not Sitting Out, and either a Bot or a connected human. */
export const eligible = (participant: DealingParticipant) => participant.seat !== null && participant.stack > 0 && !participant.sittingOut && (!participant.human || participant.connected);

/** The table deals only while at least two Eligible Participants remain, at least one of them human: Bots never play on alone. */
export function canDeal(participants: readonly DealingParticipant[]): boolean {
  const ready = participants.filter(eligible);
  return ready.length >= 2 && ready.some(participant => participant.human);
}

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
