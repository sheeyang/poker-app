import type { ScoreSummaryScope, StrategyDescriptor } from '@poker/contracts';
import { immutableData } from '@poker/strategies';
import { ownDecisionIds } from '@poker/research';
import type { FrozenEvaluationInput } from './analysis.js';
import { captureEvaluation, type CapturableTable } from './capture-evaluation.js';
import type { ReadableTable } from './readable-table.js';
import type { FrozenScoreSummary } from './table-summaries.js';
import type { TrainerConfigurations } from './trainer-configuration.js';

/** What the study reads of the table registry and the mutations: who may read a table, and how it is held. */
export interface StudySources {
  /** The Participant a user has at a table where they have ever been one, joined or not; loads nothing. */
  participant(id: string, userId: string): Promise<{ readonly participantId: string } | undefined>;
  /** The table's committed record: the loaded table's copy, otherwise its stored record restored read-only. */
  committed(id: string): Promise<CapturableTable | undefined>;
  /** Whether the user is joined at the table now. */
  access(id: string, userId: string): Promise<unknown>;
  /** Runs `operation` holding a handle on the table for a request from a user joined at it; `undefined` for anyone else. */
  asMember<T>(id: string, userId: string, operation: () => Promise<T>): Promise<T | undefined>;
  stopped(): boolean;
  trainerConfigurations: Pick<TrainerConfigurations, 'studyStrategy'>;
}

/** A summary of a Participant's own decisions in a scope, frozen from the committed table; null for a Hand it does not have. */
export function scoreSummaryOf(session: CapturableTable, participantId: string, scope: ScoreSummaryScope, referenceStrategy: StrategyDescriptor, historyUserId: string | undefined): FrozenScoreSummary | null {
  if (scope.scope === 'hand' && !session.game.getHand(scope.handId)) return null;
  const view = session.game.forParticipant(participantId).getView();
  const decisionIds = ownDecisionIds(view.history, participantId, scope);
  const members = decisionIds.map(decisionId => captureEvaluation(session, participantId, decisionId, referenceStrategy)!);
  return immutableData({ participantId, tableSessionId: session.aggregate.tableSessionId, ...scope, capturedPokerRevision: session.aggregate.pokerRevision, referenceStrategy, decisionIds, members, ...(historyUserId ? { historyUserId } : {}) });
}

/**
 * The reads study of a player's own decisions needs, joined or not (ADR-0041): how a user may read a table's history,
 * and how a decision of theirs is frozen from it. None of it loads a table.
 */
export function createStudy({ participant, committed, access, asMember, stopped, trainerConfigurations }: StudySources) {
  /**
   * A table a user may read the history of, with their Participant there: a loaded table's committed copy, otherwise
   * its stored record restored read-only. Anyone who has ever been a Participant there may read, after a Leave Table
   * or Removal and at a Closed Table (ADR-0041). A read never loads the table, so it holds no handle, schedules
   * nothing and subscribes to nothing.
   */
  async function readableTable(id: string, userId: string): Promise<ReadableTable | undefined> {
    const member = await participant(id, userId);
    if (!member) return undefined;
    const session = await committed(id);
    return session && { participantId: member.participantId, aggregate: session.aggregate, game: session.game };
  }
  /**
   * The frozen inputs of one of the viewer's own accepted decisions, for analysis asked for from history, under the
   * Reference Strategy their user has now, or under the supported `strategy` the request names (Counterfactual
   * Comparison: only the Strategy in the identity differs, so the frozen view and the seeds are the same). It follows
   * the same rule as reading the history, so it loads nothing. `undefined` for a user who may not read the table;
   * `null` for a decision that is not their own accepted one.
   */
  async function captureHistoryEvaluation(id: string, userId: string, decisionId: string, strategy?: StrategyDescriptor): Promise<FrozenEvaluationInput | null | undefined> {
    const referenceStrategy = await trainerConfigurations.studyStrategy(userId, strategy);
    const table = await readableTable(id, userId);
    if (!table) return undefined;
    const input = captureEvaluation(table, table.participantId, decisionId, referenceStrategy);
    return input?.acceptedAction ? input : null;
  }
  /**
   * Study of a player's own decisions at a table. A joined Participant's request holds the table and is captured in its
   * turn, as before. Anyone else who has been a Participant there, after leaving or at a Closed Table, is captured from
   * the committed record without loading the table (ADR-0041): study outlasts play, and never schedules it.
   * It studies under the user's Reference Strategy, or under `strategy` when one is named, without reading their
   * Trainer Configuration.
   */
  async function studying<T>(id: string, userId: string, strategy: StrategyDescriptor | undefined, joined: (referenceStrategy: StrategyDescriptor) => Promise<T | undefined>, former: (table: ReadableTable, referenceStrategy: StrategyDescriptor) => T): Promise<T | undefined> {
    const chosen = () => trainerConfigurations.studyStrategy(userId, strategy);
    if (await access(id, userId)) return asMember(id, userId, async () => joined(await chosen()));
    const table = await readableTable(id, userId);
    if (!table) return undefined;
    const referenceStrategy = await chosen();
    if (stopped()) throw new Error('Table Session is unavailable.');
    return former(table, referenceStrategy);
  }
  return { readableTable, captureHistoryEvaluation, studying };
}
