import { randomUUID } from 'node:crypto';
import type { HistoryBreakdown, HistoryFilter, HistoryScoreSummary, OverallHistorySummary, StrategyDescriptor } from '@poker/contracts';
import { immutableData } from '@poker/strategies';
import { scoreAdmission } from '@poker/research';
import type { FrozenEvaluationInput } from './analysis.js';
import type { AcceptTableJobResult } from './mutations.js';
import type { Entry, Owner, SharedAnalysisCoordinator } from './shared-analyses.js';
/**
 * An Overall History summary request, frozen (ADR-0041): the Guest's own decisions across every table they may read, as
 * `filter` declared them under one Strategy, and, with a breakdown, the same decisions in one set per bucket. Only that
 * Guest reads or retries it. Its members may come from many tables: each carries its own table and Participant.
 */
export interface FrozenHistorySummary {
  readonly guestId: string;
  readonly filter: HistoryFilter;
  readonly breakdown?: HistoryBreakdown;
  readonly referenceStrategy: StrategyDescriptor;
  readonly members: readonly FrozenEvaluationInput[];
  readonly buckets?: readonly { readonly value: string; readonly members: readonly FrozenEvaluationInput[] }[];
}
/** A Participant at a table: whose results a history summary's decisions are accepted for. */
interface Membership { readonly tableSessionId: string; readonly participantId: string }
/** The distinct memberships the decisions of `members` come from, each once. */
function membershipsOf(members: readonly FrozenEvaluationInput[]): Membership[] {
  const byTable = new Map<string, Set<string>>();
  for (const { identity } of members) byTable.set(identity.tableSessionId, (byTable.get(identity.tableSessionId) ?? new Set()).add(identity.participantId));
  return [...byTable].flatMap(([tableSessionId, participants]) => [...participants].map(participantId => ({ tableSessionId, participantId })));
}
interface HistoryRequest { readonly input: FrozenHistorySummary; requestId: string; attemptId: string; readonly whole: Entry; readonly buckets: readonly { readonly value: string; readonly entry: Entry }[] }
/**
 * Overall History Score Summaries (ADR-0041): the Guest's own decisions across every table they may read. Every
 * analysis they need is asked for as the Guest's `history-analysis`; the shared analyses are reused.
 */
export function createOverallHistorySummaries(shared: SharedAnalysisCoordinator, acceptJobResult: AcceptTableJobResult) {
  const { ask, succeeded, reduce, dependenciesOf, entryOf, retryEntry } = shared;
  const historyRequests = new Map<string, HistoryRequest>();
  const historySummary = (entry: Entry): HistoryScoreSummary => {
    const total = entry.members.length;
    const decided = entry.outcome.status === 'complete' || entry.outcome.status === 'empty';
    const decisionCount = entry.admits ? entry.admitted : total;
    return immutableData({ ...(decisionCount === undefined ? {} : { decisionCount }), progress: { succeeded: decided ? total : entry.members.filter(succeeded).length, total }, ...entry.outcome } as HistoryScoreSummary);
  };
  const overallSummary = (request: HistoryRequest): OverallHistorySummary => immutableData({
    ok: true as const, requestId: request.requestId, attemptId: request.attemptId, filter: request.input.filter,
    ...(request.input.breakdown ? { breakdown: request.input.breakdown } : {}), referenceStrategy: request.input.referenceStrategy,
    summary: historySummary(request.whole),
    ...(request.input.breakdown ? { buckets: request.buckets.map(bucket => ({ value: bucket.value, summary: historySummary(bucket.entry) })) } : {}),
  });
  return {
    /**
     * Starts an Overall History summary request. Every analysis it needs is asked for as the Guest's `history-analysis`,
     * reusing any matching analysis or stored result; the per-Guest bound holds back the rest. It answers at once, and
     * `readHistory` reports its progress. Its results are accepted only while every table its decisions come from still
     * accepts its Participant's results, each checked as `acceptJobResult` checks one table's. With score ranges, every
     * summary of it waits for all of its set's analyses and then covers only the decisions the ranges admit.
     */
    createHistory(input: FrozenHistorySummary): OverallHistorySummary {
      const admits = scoreAdmission(input.filter);
      const memberships = membershipsOf(input.members);
      const owner: Owner = {
        guestId: input.guestId,
        async accept(change) {
          for (const { tableSessionId, participantId } of memberships) if (!await acceptJobResult(tableSessionId, participantId, () => true)) return false;
          return change();
        },
        notify: () => {},
      };
      const members = dependenciesOf(input.members, input.guestId);
      const request: HistoryRequest = {
        input, requestId: randomUUID(), attemptId: randomUUID(), whole: entryOf(owner, members, admits),
        buckets: (input.buckets ?? []).map(bucket => ({ value: bucket.value, entry: entryOf(owner, dependenciesOf(bucket.members, input.guestId), admits) })),
      };
      historyRequests.set(request.requestId, request);
      for (const member of members) if (!succeeded(member)) ask(member);
      // Members another summary already holds may have settled: those summaries can complete now.
      for (const entry of [request.whole, ...request.buckets.map(bucket => bucket.entry)]) void reduce(entry);
      return overallSummary(request);
    },
    readHistory(requestId: string, guestId: string): OverallHistorySummary | undefined {
      const request = historyRequests.get(requestId);
      return request?.input.guestId === guestId ? overallSummary(request) : undefined;
    },
    /** Retries every failed summary of the request, asking again for each failed analysis it needs. */
    retryHistory(requestId: string, guestId: string): OverallHistorySummary | undefined {
      const request = historyRequests.get(requestId);
      if (request?.input.guestId !== guestId) return undefined;
      const entries = [request.whole, ...request.buckets.map(bucket => bucket.entry)];
      if (entries.map(retryEntry).some(Boolean)) request.attemptId = randomUUID();
      for (const entry of entries) void reduce(entry);
      return overallSummary(request);
    },
  };
}
