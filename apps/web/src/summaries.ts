import { useEffect, useMemo, useState } from 'react';
import { hashKey } from '@tanstack/react-query';
import type { ScoreSummary, ObservableTableSession } from '@poker/contracts';
import { api, createAnalysisTarget, useAnalysisResource } from '@poker/client';

export function useHandSummary(table: ObservableTableSession | undefined) {
  const handId = table?.view.state.handId;
  const scope = hashKey([table?.tableSessionId, handId]);
  const human = table?.bindings.find(binding => binding.controller.kind === 'human')?.participantId;
  const decisionIds = table?.view.history.find(hand => hand.handId === handId)?.decisions.filter(decision => decision.action.participantId === human).map(decision => decision.decisionId) ?? [];
  // Settings alone retain the recorded snapshot. The next accepted action captures the then-current reference.
  const key = hashKey([scope, decisionIds]);
  const target = useMemo(() => table && handId && decisionIds.length ? createAnalysisTarget<ScoreSummary>({
    key, tableId: table.tableSessionId, resource: 'summary', wanted: true, recoverMissing: false,
    create: () => api.createHandSummary(table.tableSessionId, handId), read: requestId => api.readSummary(table.tableSessionId, requestId), retry: requestId => api.retrySummary(table.tableSessionId, requestId),
    accepts: data => data.tableSessionId === table.tableSessionId && data.scope === 'hand' && data.handId === handId && hashKey([data.decisionIds]) === hashKey([decisionIds]),
  }) : null, [key]);
  const resource = useAnalysisResource(target);
  const [settled, setSettled] = useState<{ scope: string; data: Extract<ScoreSummary, { status: 'complete' }> }>();
  const candidate = resource.display?.data;
  const complete = candidate?.status === 'complete' ? candidate : settled?.scope === scope ? settled.data : undefined;
  useEffect(() => { if (candidate?.status === 'complete') setSettled({ scope, data: candidate }); }, [candidate, scope]);
  // A read failure keeps its immutable request; only a missing/unknown identity needs a new snapshot.
  return { ...resource, handId, complete, canRequest: !!target, request: () => resource.request(!target?.data || resource.display?.errorCode === 'not-found') };
}
export function useTableSessionSummary(table: ObservableTableSession | undefined) {
  const key = table?.tableSessionId ?? '';
  const target = useMemo(() => table ? createAnalysisTarget<ScoreSummary>({
    key, tableId: table.tableSessionId, resource: 'summary', wanted: false, recoverMissing: false,
    create: () => api.createSessionSummary(table.tableSessionId), read: requestId => api.readSummary(table.tableSessionId, requestId), retry: requestId => api.retrySummary(table.tableSessionId, requestId),
    accepts: data => data.tableSessionId === table.tableSessionId && data.scope === 'table-session',
  }) : null, [key]);
  const resource = useAnalysisResource(target);
  return { ...resource, canRequest: !!target, request: () => resource.request(true) };
}
