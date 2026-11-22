import { useEffect, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { DecisionAnalysis, TableHandReplay } from '@poker/contracts';
import { api, createAnalysisTarget, useAnalysisResource } from '@poker/client';
import { useShell } from './app-shell.js';
import { replayAnalysisTarget } from './replay.js';

/**
 * The analysis of the reader's own decision at the Replay Step on show, under their Guest's current Reference
 * Strategy, asked for from Table History so the server schedules it as `history-analysis`. A matching cached result
 * comes back at once; otherwise it is read again when the Guest's live connection says it changed. A new Reference
 * Strategy is a new target, so the decision is analyzed again under it. Nothing is asked at anyone else's decision.
 */
export function useReplayAnalysis(replay: TableHandReplay | undefined, index: number) {
  const { identity, live, consumeLive } = useShell();
  // The Guest's Trainer Configuration: one choice for every table, read outside any table so a former table works too.
  const configuration = useQuery({ queryKey: ['trainer-configuration'], queryFn: ({ signal }) => api.readTrainerConfiguration(signal), enabled: identity.isSuccess });
  const reference = configuration.data?.trainerConfiguration.referenceStrategy;
  // The replay and the configuration keep their identity between reads, so the target changes only with the step or the Strategy.
  const decision = useMemo(() => replay && reference ? replayAnalysisTarget(replay, index, reference) : undefined, [replay, index, reference]);
  const target = useMemo(() => decision && replay ? createAnalysisTarget<DecisionAnalysis>({
    key: decision.key, tableId: replay.tableSessionId, resource: 'analysis', wanted: true, recoverMissing: true,
    create: () => api.getOrStartHistoryAnalysis(replay.tableSessionId, decision.decisionId),
    read: requestId => api.readAnalysis(replay.tableSessionId, requestId), retry: requestId => api.retryAnalysis(replay.tableSessionId, requestId),
    accepts: decision.accepts,
  }) : null, [decision, replay]);
  const resource = useAnalysisResource(target);
  // The shell's one live connection tells this replay when an analysis of the Guest's changes.
  useEffect(() => consumeLive(resource.consumers));
  useEffect(() => () => consumeLive(null), [consumeLive]);
  const generation = live.userChannel?.generation ?? null;
  useEffect(() => { resource.connectionChanged(generation); }, [generation, resource.connectionChanged]);
  return {
    /** The decision on show is the reader's own: analysis belongs here. */
    offered: !!replay?.steps[index]?.viewerDecisionId,
    decision,
    /** The Guest's current Reference Strategy, once read. */
    reference,
    display: resource.display,
    /** The Trainer Configuration could not be read, so nothing could be asked. */
    configurationError: configuration.isError ? configuration.error : undefined,
    retryConfiguration: () => void configuration.refetch(),
    /** Asks again after the request itself failed. */
    request: () => resource.request(),
    /** Retries a failed analysis with its original inputs. */
    retry: () => void resource.retry(),
  };
}
