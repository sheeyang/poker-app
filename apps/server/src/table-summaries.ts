import { randomUUID } from 'node:crypto';
import type { AnalysisUpdate, ScoreSummary, ScoreSummaryScope, StrategyDescriptor } from '@poker/contracts';
import { immutableData } from '@poker/strategies';
import type { createAnalysis, FrozenEvaluationInput } from './analysis.js';
import type { AcceptTableJobResult } from './mutations.js';
import type { ProgressChannel } from './progress.js';
import { pendingRequest } from './pending-request.js';
import { progressOf, type Entry, type SharedAnalysisCoordinator } from './shared-analyses.js';
/** `participantId` keys the summary: only that Participant's Human Controller reads or retries it. */
interface FrozenSummaryMetadata {
  readonly participantId: string; readonly tableSessionId: string;
  readonly capturedPokerRevision: number; readonly referenceStrategy: StrategyDescriptor; readonly decisionIds: readonly string[];
  readonly members: readonly FrozenEvaluationInput[];
  /**
   * The Guest whose `history-analysis` runs it, when it is study from history (Table History, a compared Strategy, a
   * former Participant): then its analyses and mean run under that Guest's bound, never as `summary-analysis`.
   */
  readonly historyGuestId?: string;
}
export type FrozenScoreSummary = FrozenSummaryMetadata & ScoreSummaryScope;
interface TableRequest { readonly input: FrozenScoreSummary; identity: Omit<ScoreSummary, 'status' | 'progress'>; readonly entry: Entry; readonly guestId: string; readonly follow: () => void }
/**
 * A table's Score Summaries: a Hand's or the Table Session's, read and retried by the Participant they are for. Its
 * results are accepted while that Participant may still be told of them; its analyses are the shared ones. Each is the
 * requesting Guest's own: while it is pending its count travels on that Guest's progress channel (resource `summary`),
 * its completion or failure is a notice to that Guest's connections, and nobody else hears of either (ADR-0026).
 */
export function createTableSummaries(analysis: ReturnType<typeof createAnalysis>, shared: SharedAnalysisCoordinator, publish: (participantId: string, update: AnalysisUpdate, guestId: string) => void, acceptJobResult: AcceptTableJobResult, progress: ProgressChannel) {
  const { ask, watch, reduce, pump, dependenciesOf, entryOf, retryEntry } = shared;
  const requests = new Map<string, TableRequest>();
  const tableSummary = (request: TableRequest): ScoreSummary => immutableData({ ...request.identity, attemptId: request.entry.attempt, progress: progressOf(request.entry), ...request.entry.outcome } as ScoreSummary);
  return {
    /** Starts the summary `input` froze, for the Guest `guestId` that asked for it: they alone are told of it. */
    async create(input: FrozenScoreSummary, guestId: string): Promise<ScoreSummary> {
      const { participantId: _participant, members: _members, historyGuestId, ...metadata } = input;
      const requestId = randomUUID();
      const { owner, follow } = pendingRequest({
        guestId, requestId, resource: 'summary', progress, runAs: historyGuestId,
        accept: change => acceptJobResult(input.tableSessionId, input.participantId, change),
        publish: entry => publish(input.participantId, { type: 'analysis-update', resource: 'summary', tableSessionId: input.tableSessionId, requestId, attemptId: entry.attempt, status: entry.outcome.status as 'complete' | 'error' }, guestId),
      });
      const members = dependenciesOf(input.members, historyGuestId);
      const entry = entryOf(owner, members);
      const request: TableRequest = { input, guestId, follow: () => follow(entry), identity: immutableData({ ok: true as const, ...metadata, requestId, attemptId: entry.attempt, decisionCount: input.decisionIds.length }), entry };
      // Inspect every existing match without submitting missing work or changing its purpose.
      // Passive observations also expose failures beyond the globally bounded admission batch.
      for (const member of members) {
        try {
          const current = await analysis.lookup(member.input);
          member.failure = undefined;
          if (current) {
            if (!member.state || current.attemptId !== member.state.attemptId || current.status !== member.state.status) watch(member, current);
          } else if (!member.running && !member.queued) { member.state = undefined; ask(member); }
        } catch { member.failure = { code: 'persistence-unavailable', message: 'A required analysis could not be loaded.' }; }
      }
      requests.set(requestId, request);
      if (members.length) { await reduce(entry); await pump(); await reduce(entry); }
      request.follow();
      return tableSummary(request);
    },
    async retry(tableSessionId: string, requestId: string, participantId: string): Promise<ScoreSummary | undefined> {
      const request = requests.get(requestId);
      if (!request || request.input.participantId !== participantId || request.input.tableSessionId !== tableSessionId) return undefined;
      if (!retryEntry(request.entry)) return tableSummary(request);
      await reduce(request.entry); await pump(); await reduce(request.entry);
      request.follow();
      return tableSummary(request);
    },
    read(tableSessionId: string, requestId: string, participantId: string) {
      const request = requests.get(requestId);
      return request?.input.participantId === participantId && request.input.tableSessionId === tableSessionId ? tableSummary(request) : undefined;
    },
  };
}
