import type { Card, ChipAmount, ConcreteAction, DecisionId, HandId, ObservableCashGameState, ObservableGameConfiguration, ParticipantId, TableMode, TableSessionId } from './index.js';
import type { DealInputs, PayoutInputs, ShowdownInputs, StreetInputs } from './presentation.js';

/** A table's blinds and ante, as recorded: the stakes its history and the saved-tables list show. */
export interface Stakes { readonly smallBlind: ChipAmount; readonly bigBlind: ChipAmount; readonly ante: ChipAmount }

/** One Participant dealt into a Hand, as the viewer may know them: hole cards only where they are the viewer's own or a showdown revealed them. */
export interface TableHistoryParticipant {
  readonly participantId: ParticipantId;
  readonly name: string;
  readonly holeCards?: readonly Card[];
}
/**
 * What a completed Hand's row says before its outcome: its table-wide number, when it completed and who was dealt in.
 * Nothing in it gives the Hand away, so a replay may carry it at every Replay Step.
 */
export interface TableHistoryHandHead {
  readonly handId: HandId;
  /** The table-wide Hand number: the same for every viewer, whenever they joined. */
  readonly handNumber: number;
  /** Server time the Hand completed; absent for a Hand completed before completion times were recorded. */
  readonly completedAt?: number;
  /** Everyone dealt into the Hand, in seat order. */
  readonly dealtIn: readonly Pick<TableHistoryParticipant, 'participantId' | 'name'>[];
  /** Whether the reading Participant was dealt in, and so made decisions in it. */
  readonly viewerDealtIn: boolean;
}
/** How a completed Hand ended: the part of its row that a replay holds back until its result step. */
export interface TableHistoryOutcome {
  readonly board: readonly Card[];
  /** Whether more than one Participant remained to see cards at the end, so that a showdown could reveal them. */
  readonly showdown: boolean;
  readonly payouts: readonly { readonly participantId: ParticipantId; readonly amount: ChipAmount }[];
}
/** One completed Hand of a Table Session, as the reading Participant may see it (ADR-0040). */
export interface TableHistoryHand extends TableHistoryHandHead, TableHistoryOutcome {
  /** Everyone dealt into the Hand, in seat order, with the hole cards the viewer may see. */
  readonly dealtIn: readonly TableHistoryParticipant[];
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
  readonly stakes: Stakes;
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
 * How a replayed Hand ended, carried by its result step alone: the final board, whether it reached a showdown, who won
 * what, and the hole cards the viewer may see by then.
 */
export interface TableHistoryResult extends TableHistoryOutcome {
  /** The hole cards the viewer may see at the result: their own, and those a showdown revealed. */
  readonly holeCards: readonly { readonly participantId: ParticipantId; readonly cards: readonly Card[] }[];
}
/** A Replay Step as Table History serves it: the result step also says how the Hand ended. */
export interface TableReplayStep extends ReplayStep {
  /** Present on the result step only. */
  readonly result?: TableHistoryResult;
}
/**
 * One completed Hand of Table History, replayed: its Replay Steps as the reading Participant may see them, with
 * everything the Trainer needs to draw them without the live table, which a viewer may no longer be at. Nothing outside
 * the result step gives away the board the Hand ended on or who won it (ADR-0041).
 */
export interface TableHandReplay extends Omit<ObservableHandReplay, 'steps'> {
  readonly steps: readonly TableReplayStep[];
  readonly tableSessionId: TableSessionId;
  readonly mode: TableMode;
  readonly viewerParticipantId: ParticipantId;
  /** The Hand as the Table History list shows it, before its outcome: its number, completion time and who was dealt in. */
  readonly hand: TableHistoryHandHead;
  /**
   * Everyone seated at any step, by name and whether they are a Bot, in seat order at their first step: departed Users
   * and removed Bots included. Every step's actor, and everyone whose decision a transition records, is one of them.
   */
  readonly participants: readonly ReplayParticipant[];
}
/** A Participant seated at some step of a replayed Hand: their name, and whether they are a Bot. */
export interface ReplayParticipant {
  readonly participantId: ParticipantId;
  readonly name: string;
  readonly bot: boolean;
}
