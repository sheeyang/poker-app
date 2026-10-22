import { useMemo, useState } from 'react';
import type { ScoreSummary, ObservableTableSession } from '@poker/contracts';
import { api, createAnalysisTarget, useAnalysisResource } from '@poker/client';

export function useHandSummary(table: ObservableTableSession | undefined) {
  const [selection, setSelection] = useState<{ tableId: string; handId: string }>();
  const hands = table?.view.history.map(hand => hand.handId) ?? [];
  if (table?.view.state.handId && !hands.includes(table.view.state.handId)) hands.push(table.view.state.handId);
  const handId = selection && selection.tableId === table?.tableSessionId && hands.includes(selection.handId) ? selection.handId : table?.view.state.handId ?? hands.at(-1);
  const key = table && handId ? JSON.stringify([table.tableSessionId, handId]) : '';
  const target = useMemo(() => table && handId ? createAnalysisTarget<ScoreSummary>({
    key, tableId: table.tableSessionId, resource: 'summary', wanted: false, recoverMissing: false,
    create: () => api.createHandSummary(table.tableSessionId, handId), read: requestId => api.readSummary(table.tableSessionId, requestId), retry: requestId => api.retrySummary(table.tableSessionId, requestId),
    accepts: data => data.tableSessionId === table.tableSessionId && data.scope === 'hand' && data.handId === handId,
  }) : null, [key]);
  const resource = useAnalysisResource(target);
  return { ...resource, hands, handId, canRequest: !!target, selectHand: (id: string) => { if (table) setSelection({ tableId: table.tableSessionId, handId: id }); }, request: () => resource.request(true) };
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
