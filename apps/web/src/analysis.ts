import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQueries } from '@tanstack/react-query';
import type { DecisionAnalysis, ObservableTableSession, ConcreteAction } from '@poker/contracts';
import { api, createAnalysisTarget, useAnalysisResource, type LiveConsumers } from '@poker/client';

function identity(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(identity).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + identity((value as Record<string, unknown>)[key])).join(',') + '}';
  return JSON.stringify(value);
}
export function useDecisionAnalysis(table: ObservableTableSession | undefined) {
  const [selection, setSelection] = useState<{ tableId: string; decisionId: string; handId?: string; newestAccepted?: string; collapsed?: boolean }>();
  const [viewSelection, setViewSelection] = useState<{ tableId: string; view: 'live' | 'hand' }>();
  const human = table?.bindings.find(binding => binding.controller.kind === 'human')?.participantId;
  const acceptedDecisions = table?.view.history.flatMap((hand, handIndex) => hand.handId !== table.view.state.handId ? [] : hand.decisions.filter(decision => decision.action.participantId === human).map(decision => ({ decisionId: decision.decisionId, action: decision.action.action, handId: hand.handId, handNumber: handIndex + 1, state: decision.state }))) ?? [];
  const newestAccepted = acceptedDecisions.at(-1)?.decisionId;
  const currentDecisionId = table?.view.state.legalActions.length ? table.view.state.decisionId : undefined;
  const liveEnabled = table?.trainerConfiguration.liveAnalysis ?? false;
  const view = table && viewSelection?.tableId === table.tableSessionId ? viewSelection!.view : liveEnabled ? 'live' : 'hand';
  useEffect(() => {
    if (table && viewSelection?.tableId !== table.tableSessionId) setViewSelection({ tableId: table.tableSessionId, view: liveEnabled ? 'live' : 'hand' });
  }, [table?.tableSessionId, viewSelection?.tableId, liveEnabled]);
  const pinned = selection?.tableId === table?.tableSessionId && selection?.handId === table?.view.state.handId && selection?.newestAccepted === newestAccepted && acceptedDecisions.some(decision => decision.decisionId === selection?.decisionId);
  const selectedDecisionId = pinned ? selection!.decisionId : newestAccepted ?? '';
  const expandedDecisionId = pinned && selection!.collapsed ? '' : selectedDecisionId;
  const accepted = view === 'hand' ? acceptedDecisions.find(decision => decision.decisionId === selectedDecisionId) : undefined;
  const [rowRevision, setRowRevision] = useState(0);
  const rowGeneration = useRef<number | null>(null);
  const confirmedRows = useRef(new Map<string, DecisionAnalysis>());
  const reviewDecisions = acceptedDecisions.filter(decision => decision.handId === (accepted?.handId ?? table?.view.state.handId));
  const rowKeys = reviewDecisions.map(decision => identity([table!.tableSessionId, decision.decisionId, table!.trainerConfiguration.referenceStrategy, decision.action]));
  // A fresh generation also covers completion notifications that race an initial HTTP read.
  // Keep confirmed values under their full identity while that read is refreshed.
  const rowQueries = useQueries({ queries: reviewDecisions.map((decision, index) => {
    const rowKey = rowKeys[index]!;
    return { queryKey: ['decision-row-analysis', rowKey, rowRevision], staleTime: Infinity, placeholderData: confirmedRows.current.get(rowKey), queryFn: async () => {
      const data = await api.getOrStartAnalysis(table!.tableSessionId, decision.decisionId);
      if (identity([data.tableSessionId, data.decisionId, data.referenceStrategy, data.scoredDecision?.acceptedAction ?? null]) !== rowKey) throw new Error('Analysis does not match this decision.');
      return data;
    } };
  }) });
  const rowAnalyses = Object.fromEntries(reviewDecisions.map((decision, index) => [decision.decisionId, rowQueries[index]!.data ?? confirmedRows.current.get(rowKeys[index]!)]));
  useEffect(() => {
    confirmedRows.current = new Map(rowKeys.flatMap((key, index) => {
      const data = rowQueries[index]!.data ?? confirmedRows.current.get(key);
      return data?.status === 'complete' ? [[key, data] as const] : [];
    }));
  });
  const rowErrors = Object.fromEntries(reviewDecisions.map((decision, index) => [decision.decisionId, rowQueries[index]!.isError]));
  const decisionId = view === 'live' ? liveEnabled ? currentDecisionId : undefined : selectedDecisionId;
  const key = table && decisionId ? identity([table.tableSessionId, decisionId, table.trainerConfiguration.referenceStrategy, accepted?.action ?? null]) : '';
  const target = useMemo(() => key && table && decisionId ? createAnalysisTarget<DecisionAnalysis>({
    key, tableId: table.tableSessionId, resource: 'analysis', wanted: !!accepted || liveEnabled, recoverMissing: true,
    create: () => api.getOrStartAnalysis(table.tableSessionId, decisionId, !accepted && liveEnabled),
    read: requestId => api.readAnalysis(table.tableSessionId, requestId), retry: requestId => api.retryAnalysis(table.tableSessionId, requestId),
    accepts: data => identity([data.tableSessionId, data.decisionId, data.referenceStrategy, data.scoredDecision?.acceptedAction ?? null]) === key,
  }) : null, [key, liveEnabled]);
  const resource = useAnalysisResource(target);
  // Reviewing an earlier decision must not stop evaluation of the latest action.
  const newest = acceptedDecisions.at(-1);
  const backgroundKey = table && newest && (view === 'live' || selectedDecisionId !== newest.decisionId) ? identity([table.tableSessionId, newest.decisionId, table.trainerConfiguration.referenceStrategy, newest.action]) : '';
  const backgroundTarget = useMemo(() => backgroundKey && table && newest ? createAnalysisTarget<DecisionAnalysis>({
    key: backgroundKey, tableId: table.tableSessionId, resource: 'analysis', wanted: true, recoverMissing: true,
    create: () => api.getOrStartAnalysis(table.tableSessionId, newest.decisionId),
    read: id => api.readAnalysis(table.tableSessionId, id), retry: id => api.retryAnalysis(table.tableSessionId, id),
    accepts: data => identity([data.tableSessionId, data.decisionId, data.referenceStrategy, data.scoredDecision?.acceptedAction ?? null]) === backgroundKey,
  }) : null, [backgroundKey]);
  const background = useAnalysisResource(backgroundTarget);
  const consumers: LiveConsumers = {
    onReady: lifecycle => { rowGeneration.current = lifecycle.generation; setRowRevision(value => value + 1); resource.consumers.onReady?.(lifecycle); background.consumers.onReady?.(lifecycle); },
    onAnalysisUpdate: (update, lifecycle) => { if (update.resource === 'analysis' && update.tableSessionId === table?.tableSessionId && lifecycle.generation === rowGeneration.current) setRowRevision(value => value + 1); resource.consumers.onAnalysisUpdate?.(update, lifecycle); background.consumers.onAnalysisUpdate?.(update, lifecycle); },
  };
  const connectionChanged = useCallback((generation: number | null) => { resource.connectionChanged(generation); background.connectionChanged(generation); }, [resource.connectionChanged, background.connectionChanged]);
  return { ...resource, consumers, connectionChanged, acceptedDecisions, rowAnalyses, rowErrors, selectedDecisionId, expandedDecisionId, pinned, view,
    selectView: (view: 'live' | 'hand') => { if (table) setViewSelection({ tableId: table.tableSessionId, view }); },
    selectDecision: (id: string) => { if (table) { setViewSelection({ tableId: table.tableSessionId, view: 'hand' }); setSelection(id ? { tableId: table.tableSessionId, handId: table.view.state.handId, newestAccepted, decisionId: id } : undefined); } },
    collapseDecision: () => { if (table && selectedDecisionId) setSelection({ tableId: table.tableSessionId, handId: table.view.state.handId, newestAccepted, decisionId: selectedDecisionId, collapsed: true }); },
    canEvaluate: !!target, evaluate: () => resource.request() };
}
