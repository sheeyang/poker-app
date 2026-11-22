import type { Card, ChipAmount, ConcreteAction, DecisionId, HandId, ObservableCashGameState, ObservableGameConfiguration, ParticipantId, TableMode, TableSessionId } from './index.js';
import type { DealInputs, PayoutInputs, ShowdownInputs, StreetInputs } from './presentation.js';

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

/**
 * What a Replay Step's transition presents: how the table got from the step before to this one. Each part is the
 * participant-safe shape its Presentation Phase's inputs use (ADR-0039), so the Trainer plays the same motion as at the
 * live table, timed by the client. Only the parts the transition presents are present.
 */
export interface ReplayTransition {
  /** The decision taken at the step before, which opens this transition. Public once taken. */
  readonly acted?: { readonly participantId: ParticipantId; readonly action: ConcreteAction };
  /** The deal, on the Hand's first step. A refill that came with the deal is not replayed: it is always empty. */
  readonly deal?: DealInputs;
  /** The street reveal this step follows. */
  readonly street?: StreetInputs;
  /** The showdown, on the result step of a Hand that reached one: the only step where it reveals hands. */
  readonly showdown?: ShowdownInputs;
  /** The payout, on the result step. */
  readonly payout?: PayoutInputs;
}
/**
 * One Replay Step of a completed Hand: before a decision (any actor's), after a street reveal (every all-in runout
 * street included), or the Hand's result. Its state is the table as the viewer could see it at that point, never what a
 * later showdown revealed: only the viewer's own hole cards before the result, and others' legal actions empty.
 */
export interface ReplayStep {
  readonly kind: 'decision' | 'street' | 'result';
  /** The table at this step. Before a decision it is the table as that decision opened. */
  readonly state: ObservableCashGameState;
  readonly transition: ReplayTransition;
  /** Present when this step comes before one of the viewer's own decisions: its DecisionId. */
  readonly viewerDecisionId?: DecisionId;
}
/** One completed Hand's Replay Steps for one viewer, in order, and the Game Configuration as it stood during the Hand. */
export interface ObservableHandReplay {
  readonly handId: HandId;
  readonly configuration: ObservableGameConfiguration;
  readonly steps: readonly ReplayStep[];
}
/**
 * One completed Hand of Table History, replayed: its Replay Steps as the reading Participant may see them, with
 * everything the Trainer needs to draw them without the live table, which a reader may no longer be at.
 */
export interface TableHandReplay extends ObservableHandReplay {
  readonly tableSessionId: TableSessionId;
  readonly mode: TableMode;
  readonly viewerParticipantId: ParticipantId;
  /** The Hand as the Table History list shows it. */
  readonly hand: TableHistoryHand;
  /** Everyone seated at any step, by name, in seat order at their first step: departed Guests and removed Bots included. */
  readonly players: readonly { readonly participantId: ParticipantId; readonly name: string }[];
}
