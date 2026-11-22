import type { ChipAmount, ObservableHistoryEntry, Position, Street } from '@poker/contracts';
import { handPositions } from './position.js';

/** What the recorded facts of one decision say about its situation, before the decision (Overall History's filters). */
export interface DecisionSituation {
  readonly street: Street;
  readonly position: Position;
  /** Every chip committed to the Hand when the actor decided: antes, blinds and every wager so far, those of the current street included. */
  readonly pot: ChipAmount;
  readonly potBigBlinds: number;
}

/**
 * The situation of one decision of an Observable Session History entry, from its recorded state alone: the street it
 * was taken on, the actor's Position, and the pot as they faced it in chips and in big blinds. The pot counts
 * contributions rather than the state's pots, which leave out a wager no one has matched yet.
 */
export function decisionSituation(decision: ObservableHistoryEntry['decisions'][number], bigBlind: ChipAmount): DecisionSituation {
  const { state } = decision;
  const pot = state.participants.reduce((total, participant) => total + (participant.contribution ?? 0), 0);
  return { street: state.street!, position: handPositions(state).get(decision.action.participantId)!, pot, potBigBlinds: pot / bigBlind };
}
