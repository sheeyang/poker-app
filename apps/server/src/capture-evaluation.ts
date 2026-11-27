import { createHash } from 'node:crypto';
import { deriveSeed, type CashGame } from '@poker/engine';
import type { ObservableGameView, StrategyDescriptor } from '@poker/contracts';
import { immutableData } from '@poker/strategies';
import { findBinding, isPlayer, type PersistedTableSession } from './aggregate.js';
import { canonical } from './canonical.js';
import type { FrozenEvaluationInput } from './analysis.js';

/** A table's committed record and game: all a decision's frozen inputs are captured from. */
export interface CapturableTable { readonly aggregate: PersistedTableSession; readonly game: CashGame }

/**
 * The frozen inputs of a player's decision, under the Reference Strategy its User has as it is asked.
 * `current` is the Participant's current view, when the caller already has it for many decisions.
 */
export function captureEvaluation(session: CapturableTable, participantId: string, decisionId: string, referenceStrategy: StrategyDescriptor, current = session.game.forParticipant(participantId).getView()): FrozenEvaluationInput | null {
  const binding = findBinding(session.aggregate, participantId);
  if (!isPlayer(binding)) return null;
  const participant = session.game.forParticipant(participantId);
  const accepted = current.history.flatMap(hand => hand.decisions).find(decision => decision.decisionId === decisionId && decision.action.participantId === participantId);
  let view: ObservableGameView;
  try { view = participant.getView({ at: { decisionId } }); } catch (error) { if (error instanceof RangeError) return null; throw error; }
  if (view.state.actorId !== participantId || !view.state.handId || !view.state.legalActions.length || !accepted && current.state.decisionId !== decisionId) return null;
  const masterSeed = session.aggregate.pokerRecord.configuration.seed;
  return immutableData({ view, ...(accepted ? { acceptedAction: accepted.action.action } : {}), identity: {
    tableSessionId: session.aggregate.tableSessionId, participantId, handId: view.state.handId, decisionId,
    referenceStrategy,
    inputFingerprint: createHash('sha256').update(canonical(view)).digest('hex'),
    evaluationSeed: deriveSeed(masterSeed, 'policy', participantId, decisionId),
    selectionSeed: deriveSeed(masterSeed, 'selector', participantId, decisionId),
    engineVersion: session.aggregate.pokerRecord.engineVersion, randomVersion: 'v1', evaluationVersion: 'v1',
  } });
}
