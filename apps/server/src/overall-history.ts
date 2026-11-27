import { normalizeHistoryFilter, type HistoryBreakdown, type HistoryFilter, type OverallHistoryDecision, type StrategyDescriptor } from '@poker/contracts';
import { filteredDecisions, inListOrder, newestFirst, ownDecisions, summarySets } from '@poker/research';
import { immutableData } from '@poker/strategies';
import type { TrainerConfigurations } from './trainer-configuration.js';
import type { FrozenHistorySummary } from './overall-history-summaries.js';
import type { FrozenScoredHistory, StudiedDecision } from './score-filtered-history.js';
import { captureEvaluation } from './capture-evaluation.js';
import { completedHands, historyViewer, type ReadableTable } from './readable-table.js';

/** What Overall History capture reads: the User's tables, how a User may read one, and their Trainer Configuration. */
export interface OverallHistorySources {
  /** The tables the User has ever been a Participant at, in any status. */
  participations(userId: string): Promise<readonly { readonly tableSessionId: string }[]>;
  readableTable(id: string, userId: string): Promise<ReadableTable | undefined>;
  trainerConfigurations: Pick<TrainerConfigurations, 'studyStrategy'>;
}

/**
 * Overall History's capture (ADR-0041): the User's own decisions across every table they may read, listed, and frozen
 * for a summary request or a score-filtered list. Each table is read through `readableTable`, so nothing is loaded.
 */
export function createOverallHistory({ participations, readableTable, trainerConfigurations }: OverallHistorySources) {
  /**
   * Every table the User may read, with their own decisions there: the one walk behind the list and the summaries.
   * Each table is read through `readableTable`, the one rule for reading a table's history, so it loads nothing.
   */
  async function* ownDecisionsAtTables(userId: string): AsyncGenerator<{ readonly table: ReadableTable; readonly decisions: OverallHistoryDecision[] }> {
    for (const { tableSessionId } of await participations(userId)) {
      const table = await readableTable(tableSessionId, userId);
      if (table) yield { table, decisions: ownDecisions(completedHands(table), historyViewer(table)) };
    }
  }
  /**
   * The User-scoped Overall History (ADR-0041): every decision the User made, in a Hand they were dealt into, at any table
   * they may read, passing the non-score restrictions of `filter`, the newest Hand first. The tables are those of the
   * membership index in any status, and each is read through `readableTable`, the one rule for reading a table's history,
   * so it never loads a table and shows no decision of anyone else's.
   */
  async function readOverallHistory(userId: string, filter: HistoryFilter): Promise<OverallHistoryDecision[]> {
    const decisions: OverallHistoryDecision[] = [];
    for await (const own of ownDecisionsAtTables(userId)) decisions.push(...own.decisions);
    return newestFirst(filteredDecisions(decisions, filter));
  }
  /**
   * An Overall History Score Summary request, frozen (ADR-0041): the decisions `readOverallHistory` lists for `filter`,
   * each frozen for analysis under the User's Reference Strategy now, or under the supported `strategy` named instead,
   * and with `breakdown` the same decisions in one set per bucket. Each table is read as its history is, so it loads
   * nothing.
   */
  async function studiedDecisions(userId: string, filter: HistoryFilter, referenceStrategy: StrategyDescriptor): Promise<StudiedDecision[]> {
    const decisions: StudiedDecision[] = [];
    for await (const { table, decisions: own } of ownDecisionsAtTables(userId)) {
      const current = table.game.forParticipant(table.participantId).getView();
      for (const decision of filteredDecisions(own, filter)) {
        const input = captureEvaluation(table, table.participantId, decision.decisionId, referenceStrategy, current);
        if (input?.acceptedAction) decisions.push({ decision, input });
      }
    }
    return decisions;
  }
  async function captureOverallHistorySummary(userId: string, filter: HistoryFilter, breakdown?: HistoryBreakdown, strategy?: StrategyDescriptor): Promise<FrozenHistorySummary> {
    const referenceStrategy = await trainerConfigurations.studyStrategy(userId, strategy);
    const decisions = await studiedDecisions(userId, filter, referenceStrategy);
    return immutableData({ userId, filter: normalizeHistoryFilter(filter), ...(breakdown ? { breakdown } : {}), referenceStrategy, ...summarySets(decisions, breakdown) });
  }
  /**
   * A score-filtered Overall History request, frozen: every decision the non-score restrictions of `filter` admit, in the
   * list's order, each frozen for analysis under the User's Reference Strategy now (or the supported `strategy`). The
   * score ranges are applied afterwards, to the finished analyses, by the coordinator.
   */
  async function captureScoredHistory(userId: string, filter: HistoryFilter, strategy?: StrategyDescriptor): Promise<FrozenScoredHistory> {
    const referenceStrategy = await trainerConfigurations.studyStrategy(userId, strategy);
    const decisions = await studiedDecisions(userId, filter, referenceStrategy);
    return immutableData({ userId, filter: normalizeHistoryFilter(filter), referenceStrategy, decisions: inListOrder(decisions) });
  }
  return { readOverallHistory, captureOverallHistorySummary, captureScoredHistory };
}
