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

/**
 * Whether asking for an After-Hand Request of `kind` for a Participant would change anything: nothing is pending for
 * them, or only a weaker request is. A weaker or equal request changes nothing, at the server too.
 */
export const outranksPending = (table: ObservableTableSession, participantId: string, kind: AfterHandRequestKind) => {
  const pending = afterHandRequestOf(table, participantId);
  return !pending || afterHandRequestStrength[pending] < afterHandRequestStrength[kind];
};

/** A change that never waits for a Hand: available now between Hands, and not at all while one is in progress. */
export const betweenHandsOnly = (available: boolean, handOpen: boolean): Availability => available && !handOpen ? 'now' : 'unavailable';

export function selfService(table: ObservableTableSession, handOpen: boolean): SelfService {
  const me = table.view.state.participants.find(participant => participant.participantId === table.viewerParticipantId);
  const seated = me?.seat != null;
  const pending = afterHandRequestOf(table, table.viewerParticipantId);
  const asks = (kind: AfterHandRequestKind) => outranksPending(table, table.viewerParticipantId, kind);
  const waits = (available: boolean): Availability => !available ? 'unavailable' : handOpen ? 'after-hand' : 'now';
  const betweenHands = (available: boolean) => betweenHandsOnly(available, handOpen);
  return {
    pending,
    sitOut: waits(seated && !me.sittingOut && asks('sit-out')),
    resume: betweenHands(seated && me.sittingOut),
    standUp: waits(seated && asks('stand-up')),
    // Someone without a Seat has nothing at stake, so they leave at once even mid-Hand.
    // A Practice Table is never left.
    leaveTable: table.mode === 'practice' || !asks('leave-table') ? 'unavailable' : seated && handOpen ? 'after-hand' : 'now',
    topUp: betweenHands(seated),
    moveSeat: betweenHands(seated && table.view.configuration.allowSeatChanges),
  };
}

const labels: Readonly<Record<AfterHandRequestKind, string>> = { 'sit-out': 'Sitting out after this hand', 'stand-up': 'Standing up after this hand', 'leave-table': 'Leaving after this hand', remove: 'Being removed after this hand' };
export const afterHandRequestLabel = (change: AfterHandRequestKind) => labels[change];
