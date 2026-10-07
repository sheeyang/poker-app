import type { ConcreteAction, HandId, ParticipantId } from '@poker/contracts';
import type { CashGameCommand } from '../index.js';

export interface ParticipantState { participantId: ParticipantId; seat: number | null; stack: number; sittingOut: boolean }
export interface HandParticipantState {
  participantId: ParticipantId;
  seat: number;
  holeCards: string[];
  contribution: number;
  wager: number;
  folded: boolean;
  allIn: boolean;
  revealed: boolean;
}
export interface PotState { amount: number; eligibleParticipantIds: ParticipantId[] }
export interface ChipTransfer { participantId: ParticipantId; amount: number }
export interface HandState {
  handId: HandId;
  sequence: number;
  completed: boolean;
  buttonSeat: number;
  smallBlindParticipantId: ParticipantId;
  bigBlindParticipantId: ParticipantId;
  /** Seated observers include sitting-out Participants; absent identities gain no history. */
  observerParticipantIds: ParticipantId[];
  participants: HandParticipantState[];
  deck: string[];
  drawnCardCount: number;
  burns: string[];
  board: string[];
  street: 'preflop' | 'flop' | 'turn' | 'river';
  actorId: ParticipantId | null;
  decisionSequence: number;
  decisionId: string | null;
  price: number;
  lastFullIncrement: number;
  pots: PotState[];
  returns: ChipTransfer[];
  payouts: ChipTransfer[];
  actions: { participantId: ParticipantId; action: ConcreteAction }[];
}
/** The one authoritative draft, including frozen Hand membership and persistent identities. */
export interface CashGameState {
  status: 'between-hands' | 'active-hand' | 'completed-hand';
  buttonSeat: number;
  nextButtonSeat: number | null;
  participants: ParticipantState[];
  hands: HandState[];
  commands: CashGameCommand[];
  bankroll: number;
}
