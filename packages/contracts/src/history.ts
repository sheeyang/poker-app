import type { Card, ChipAmount, HandId, ParticipantId, TableMode, TableSessionId } from './index.js';

/** One Participant dealt into a Hand, as the viewer may know them: hole cards only where they are the viewer's own or a showdown revealed them. */
export interface TableHistoryPlayer {
  readonly participantId: ParticipantId;
  readonly name: string;
  readonly holeCards?: readonly Card[];
}
/** One completed Hand of a Table Session, as the reading Participant may see it (ADR-0040). */
export interface TableHistoryHand {
  readonly handId: HandId;
  /** The table-wide Hand number: the same for every viewer, whenever they joined. */
  readonly handNumber: number;
  /** Server time the Hand completed; absent for a Hand completed before completion times were recorded. */
  readonly completedAt?: number;
  /** Everyone dealt into the Hand, in seat order. */
  readonly dealtIn: readonly TableHistoryPlayer[];
  /** Whether the reading Participant was dealt in, and so made decisions in it. */
  readonly viewerDealtIn: boolean;
  readonly board: readonly Card[];
  /** Whether more than one player remained to see cards at the end, so that a showdown could reveal them. */
  readonly showdown: boolean;
  readonly payouts: readonly { readonly participantId: ParticipantId; readonly amount: ChipAmount }[];
}
/**
 * The Table History list: every completed Hand of the Table Session, oldest first. Anyone who has ever been a
 * Participant at the table reads it (ADR-0041), so it names the table itself: a former Participant cannot read the
 * live table view.
 */
export interface TableHistory {
  readonly tableSessionId: TableSessionId;
  readonly viewerParticipantId: ParticipantId;
  readonly mode: TableMode;
  readonly seatCount: number;
  readonly stakes: { readonly smallBlind: ChipAmount; readonly bigBlind: ChipAmount; readonly ante: ChipAmount };
  /** The viewer is a former Participant: they left, were removed, or the table closed. They read; they cannot play. */
  readonly left?: true;
  /** A Closed Table: nobody can join or play there again. Its memberships have all ended, so it is `left` too. */
  readonly closed?: true;
  readonly hands: readonly TableHistoryHand[];
}
