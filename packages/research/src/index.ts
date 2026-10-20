import { CashGame } from '@poker/engine';
import type { ActionProbability, CompletedHandInspectionOutcome, ConcreteAction, DecisionScores, ObservableGameView, ReferenceStrategyEvaluation } from '@poker/contracts';

/** v1 treats aggregate probabilities within 1e-12 of a rank representative as tied. */
export const scoringMethodVersion = 'v1' as const;
export function calculateActionProbabilities(view: ObservableGameView, choices: ReferenceStrategyEvaluation['policyResult']['choices']): readonly ActionProbability[] {
  return view.state.legalActions.map(legal => ({ type: legal.type, probability: choices.filter(choice => choice.action.type === legal.type).reduce((sum, choice) => sum + choice.probability, 0) }));
}

/** Numerical interpretation of a successful validated Policy, independent of execution and storage. */
export function calculateDecisionScores(view: ObservableGameView, choices: readonly { readonly action: ConcreteAction; readonly probability: number }[], action: ConcreteAction): DecisionScores {
  const actionProbabilities = calculateActionProbabilities(view, choices);
  const distinct: number[] = [];
  for (const probability of actionProbabilities.map(item => item.probability).sort((a, b) => b - a)) {
    if (!distinct.some(representative => Math.abs(representative - probability) <= 1e-12)) distinct.push(probability);
  }
  const probability = actionProbabilities.find(item => item.type === action.type)!.probability;
  const wager = view.state.participants.find(participant => participant.participantId === view.state.actorId)!.wager ?? 0;
  const added = (choice: ConcreteAction) => (choice.type === 'bet' ? choice.betTo : choice.type === 'raise' ? choice.raiseTo : 0) - wager;
  const decisionScore = action.type === 'bet' || action.type === 'raise'
    ? choices.filter(choice => choice.action.type === action.type).reduce((best, choice) => Math.max(best, choice.probability * Math.min(added(action), added(choice.action)) / Math.max(added(action), added(choice.action))), 0)
    : choices.find(choice => choice.action.type === action.type)?.probability ?? 0;
  return { decisionScore, actionRankScore: distinct.length === 1 ? 1 : 1 - distinct.findIndex(representative => Math.abs(representative - probability) <= 1e-12) / (distinct.length - 1), actionProbabilities };
}

/** These are the entire permitted durable inputs; never a live CashGame or aggregate. */
export interface CompletedHandInspectionInput {
  readonly tableSessionId: string;
  readonly handId: string;
  /** Unvalidated durable data; the admitted job validates the complete record. */
  readonly pokerRecord: unknown;
}
export async function loadCompletedHandInspection(tableSessionId: string, handId: string, readPermittedRecord: (id: string) => Promise<{ readonly pokerRecord: unknown } | undefined>): Promise<CompletedHandInspectionInput | undefined> {
  const permitted = await readPermittedRecord(tableSessionId);
  // A missing authorized row differs from an existing row with corrupt or missing poker data.
  return permitted && { tableSessionId, handId, pokerRecord: permitted.pokerRecord };
}
/** Bounded M1 reconstruction runs only within the authoritative deployment's JobRunner. */
export function inspectCompletedHand(input: CompletedHandInspectionInput): CompletedHandInspectionOutcome {
  const restored = CashGame.fromRecord(input.pokerRecord);
  if (!restored.ok) return { ok: false, rejection: { code: 'record-restoration-failed', message: 'The complete committed Table Session could not be restored.' } };
  const facts = restored.game.getHand(input.handId);
  if (!facts) return { ok: false, rejection: { code: 'hand-not-found', message: 'Choose a completed Hand from this Table Session.' } };
  if (!facts.completed) return { ok: false, rejection: { code: 'active-hand', message: 'Complete this Hand before revealing its hidden information.' } };
  // Deliberate field mapping confines disclosure to the requested completed Hand.
  return { ok: true, tableSessionId: input.tableSessionId, hand: {
    handId: facts.handId, sequence: facts.sequence, buttonSeat: facts.buttonSeat,
    smallBlindParticipantId: facts.smallBlindParticipantId, bigBlindParticipantId: facts.bigBlindParticipantId,
    participants: facts.participants.map(p => ({ participantId: p.participantId, seat: p.seat, holeCards: [...p.holeCards], contribution: p.contribution, anteContribution: p.anteContribution, folded: p.folded, allIn: p.allIn })),
    deck: [...facts.deck], drawnCardCount: facts.drawnCardCount, burns: [...facts.burns], board: [...facts.board],
    pots: facts.pots.map(p => ({ amount: p.amount, eligibleParticipantIds: [...p.eligibleParticipantIds] })),
    returns: facts.returns.map(p => ({ participantId: p.participantId, amount: p.amount })),
    payouts: facts.payouts.map(p => ({ participantId: p.participantId, amount: p.amount })),
  } };
}
