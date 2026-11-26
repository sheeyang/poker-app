import { useEffect, useMemo } from 'react';
import type { DecisionAnalysis, StrategyDescriptor, TableHandReplay } from '@poker/contracts';
import { api, createAnalysisTarget, useAnalysisResource, type LiveConsumers } from '@poker/client';
import { useShell } from './app-shell.js';
import { comparisonTargets, type ComparisonTarget } from './comparison.js';
import { useTrainerConfiguration } from './trainer-configuration.js';

/**
 * Fans the shell's one live connection out to every analysis on show. The shell has room for one consumer, and a
 * comparison reads up to four analyses at once; each resource ignores updates that are not its own.
 */
function createLiveHub() {
  const members = new Map<string, LiveConsumers>();
  const consumers: LiveConsumers = {
    onReady: lifecycle => { for (const member of members.values()) member.onReady?.(lifecycle); },
    onAnalysisUpdate: (update, lifecycle) => { for (const member of members.values()) member.onAnalysisUpdate?.(update, lifecycle); },
  };
  return { consumers, join: (key: string, member: LiveConsumers) => { members.set(key, member); }, leave: (key: string) => { members.delete(key); } };
}
type LiveHub = ReturnType<typeof createLiveHub>;

/**
 * The analyses of the reader's own decision at the Replay Step on show: under their User's current Reference Strategy,
 * and under each Strategy compared beside it (Counterfactual Comparison). The Reference Strategy always comes first. They are
 * asked for from Table History so the server schedules them as `history-analysis`. A matching cached result comes back
 * at once; otherwise it is read again when the User's live connection says it changed. The compared Strategies come
 * from the address and are never saved to the Trainer Configuration. Nothing is asked at anyone else's decision.
 */
export function useReplayComparison(replay: TableHandReplay | undefined, index: number, compared: readonly StrategyDescriptor[]) {
  const { identity, consumeLive } = useShell();
  const configuration = useTrainerConfiguration(identity.isSuccess);
  const reference = configuration.data?.trainerConfiguration.referenceStrategy;
  const hub = useMemo(createLiveHub, []);
  useEffect(() => { consumeLive(hub.consumers); return () => consumeLive(null); }, [consumeLive, hub]);
  // The replay and the configuration keep their identity between reads, so the targets change only with the step or the Strategies.
  const targets = useMemo(() => replay && reference ? comparisonTargets(replay, index, reference, compared) : [], [replay, index, reference, compared]);
  return {
    /** The decision on show is the reader's own: analysis belongs here. */
    offered: !!replay?.steps[index]?.viewerDecisionId,
    /** The User's current Reference Strategy, once read. */
    reference,
    /** One target per Strategy, the Reference Strategy first; none until the User's configuration is read. */
    targets,
    hub,
    /** The Trainer Configuration could not be read, so nothing could be asked. */
    configurationError: configuration.isError ? configuration.error : undefined,
    retryConfiguration: () => void configuration.refetch(),
  };
}

/**
 * One Strategy's analysis of the decision on show. Its own pending, failed and Retry states: another Strategy failing or
 * still running never touches it. The Reference Strategy's is asked for without a Strategy, so it is always the User's
 * current one; every other is asked for by name.
 */
export function useStrategyAnalysis(replay: TableHandReplay, target: ComparisonTarget, reference: boolean, hub: LiveHub) {
  const { live } = useShell();
  const analysisTarget = useMemo(() => createAnalysisTarget<DecisionAnalysis>({
    key: target.key, tableId: replay.tableSessionId, resource: 'analysis', wanted: true, recoverMissing: true,
    create: () => api.getOrStartHistoryAnalysis(replay.tableSessionId, target.decisionId, reference ? undefined : target.strategy),
    read: requestId => api.readAnalysis(replay.tableSessionId, requestId), retry: requestId => api.retryAnalysis(replay.tableSessionId, requestId),
    accepts: target.accepts,
  }), [target, replay, reference]);
  const resource = useAnalysisResource(analysisTarget);
  useEffect(() => { hub.join(target.key, resource.consumers); });
  useEffect(() => () => hub.leave(target.key), [hub, target.key]);
  const generation = live.userChannel?.generation ?? null;
  useEffect(() => { resource.connectionChanged(generation); }, [generation, resource.connectionChanged]);
  return {
    display: resource.display,
    /** Asks again after the request itself failed. */
    request: () => resource.request(),
    /** Retries a failed analysis with its original inputs, for this Strategy alone. */
    retry: () => void resource.retry(),
  };
}
