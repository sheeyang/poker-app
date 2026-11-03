import { afterHandRequestStrength, type ObservableTableSession, type AfterHandRequestKind } from '@poker/contracts';

/**
 * What the viewer's own controls do right now. Pure: the Trainer shows what the server will do, and the
 * server alone decides. A change the table cannot make during a Hand is not blocked: it is asked for now and
 * applies after the Hand, which ends when its payout phase does (`handOpen`).
 *
 * - `now`: applies at once.
 * - `after-hand`: recorded as pending and applied when the Hand's payout phase ends.
 * - `unavailable`: nothing to ask for, or something stronger is already pending.
 */
export type Availability = 'now' | 'after-hand' | 'unavailable';

export interface SelfService {
  /** The viewer's pending change, shown to everyone at the table. */
  readonly pending: AfterHandRequestKind | undefined;
  readonly sitOut: Availability;
  readonly resume: Availability;
  readonly standUp: Availability;
  readonly leaveTable: Availability;
  /** Top-ups, rebuys and seat changes never wait: they are for between Hands only. */
  readonly topUp: Availability;
  readonly moveSeat: Availability;
}

export function afterHandRequestOf(table: ObservableTableSession, participantId: string): AfterHandRequestKind | undefined {
  return table.pendingChanges.find(entry => entry.participantId === participantId)?.change;
}

export function selfService(table: ObservableTableSession, handOpen: boolean): SelfService {
  const me = table.view.state.participants.find(participant => participant.participantId === table.viewerParticipantId);
  const seated = me?.seat != null;
  const pending = afterHandRequestOf(table, table.viewerParticipantId);
  const asks = (change: AfterHandRequestKind) => !pending || afterHandRequestStrength[pending] < afterHandRequestStrength[change];
  const waits = (available: boolean): Availability => !available ? 'unavailable' : handOpen ? 'after-hand' : 'now';
  const betweenHands = (available: boolean): Availability => available && !handOpen ? 'now' : 'unavailable';
  return {
    pending,
    sitOut: waits(seated && !me.sittingOut && asks('sit-out')),
    resume: betweenHands(seated && me.sittingOut),
    standUp: waits(seated && asks('stand-up')),
    // Someone without a Seat has nothing at stake, so they leave at once even mid-Hand.
    leaveTable: !asks('leave-table') ? 'unavailable' : seated && handOpen ? 'after-hand' : 'now',
    topUp: betweenHands(seated),
    moveSeat: betweenHands(seated && table.view.configuration.allowSeatChanges),
  };
}

const labels: Readonly<Record<AfterHandRequestKind, string>> = { 'sit-out': 'Sitting out after this hand', 'stand-up': 'Standing up after this hand', 'leave-table': 'Leaving after this hand', remove: 'Being removed after this hand' };
export const afterHandRequestLabel = (change: AfterHandRequestKind) => labels[change];
