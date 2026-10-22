import { useCallback, useMemo, useState } from 'react';
import type { DecisionAnalysis, ObservableTableSession, ConcreteAction } from '@poker/contracts';
import { api, createAnalysisTarget, useAnalysisResource, type LiveConsumers } from '@poker/client';

function identity(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(identity).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + identity((value as Record<string, unknown>)[key])).join(',') + '}';
  return JSON.stringify(value);
}
export function useDecisionAnalysis(table: ObservableTableSession | undefined) {
  const [selection, setSelection] = useState<{ tableId: string; decisionId: string }>();
  const human = table?.bindings.find(binding => binding.controller.kind === 'human')?.participantId;
  const acceptedDecisions = table?.view.history.flatMap((hand, handIndex) => hand.decisions.filter(decision => decision.action.participantId === human).map(decision => ({ decisionId: decision.decisionId, action: decision.action.action, handId: hand.handId, handNumber: handIndex + 1, state: decision.state }))) ?? [];
  const newestAccepted = acceptedDecisions.at(-1)?.decisionId;
  const currentDecisionId = table?.view.state.legalActions.length ? table.view.state.decisionId : undefined;
  const liveEnabled = table?.trainerConfiguration.liveAnalysis ?? false;
  const pinned = selection?.tableId === table?.tableSessionId && acceptedDecisions.some(decision => decision.decisionId === selection?.decisionId);
  const selectedDecisionId = pinned ? selection!.decisionId : liveEnabled && currentDecisionId ? '' : newestAccepted ?? '';
  const accepted = acceptedDecisions.find(decision => decision.decisionId === selectedDecisionId);
  const decisionId = selectedDecisionId || currentDecisionId;
  const key = table && decisionId ? identity([table.tableSessionId, decisionId, table.trainerConfiguration.referenceStrategy, accepted?.action ?? null]) : '';
  const target = useMemo(() => key && table && decisionId ? createAnalysisTarget<DecisionAnalysis>({
    key, tableId: table.tableSessionId, resource: 'analysis', wanted: !!accepted || liveEnabled, recoverMissing: true,
    create: () => api.getOrStartAnalysis(table.tableSessionId, decisionId, !accepted && liveEnabled),
    read: requestId => api.readAnalysis(table.tableSessionId, requestId), retry: requestId => api.retryAnalysis(table.tableSessionId, requestId),
    accepts: data => identity([data.tableSessionId, data.decisionId, data.referenceStrategy, data.scoredDecision?.acceptedAction ?? null]) === key,
  }) : null, [key, liveEnabled]);
  const resource = useAnalysisResource(target);
  // A pinned review must not stop evaluation of decisions accepted during play.
  const newest = acceptedDecisions.at(-1);
  const backgroundKey = table && newest && selectedDecisionId !== newest.decisionId ? identity([table.tableSessionId, newest.decisionId, table.trainerConfiguration.referenceStrategy, newest.action]) : '';
  const backgroundTarget = useMemo(() => backgroundKey && table && newest ? createAnalysisTarget<DecisionAnalysis>({
    key: backgroundKey, tableId: table.tableSessionId, resource: 'analysis', wanted: true, recoverMissing: true,
    create: () => api.getOrStartAnalysis(table.tableSessionId, newest.decisionId),
    read: id => api.readAnalysis(table.tableSessionId, id), retry: id => api.retryAnalysis(table.tableSessionId, id),
    accepts: data => identity([data.tableSessionId, data.decisionId, data.referenceStrategy, data.scoredDecision?.acceptedAction ?? null]) === backgroundKey,
  }) : null, [backgroundKey]);
  const background = useAnalysisResource(backgroundTarget);
  const consumers: LiveConsumers = {
    onReady: lifecycle => { resource.consumers.onReady?.(lifecycle); background.consumers.onReady?.(lifecycle); },
    onAnalysisUpdate: (update, lifecycle) => { resource.consumers.onAnalysisUpdate?.(update, lifecycle); background.consumers.onAnalysisUpdate?.(update, lifecycle); },
  };
  const connectionChanged = useCallback((generation: number | null) => { resource.connectionChanged(generation); background.connectionChanged(generation); }, [resource.connectionChanged, background.connectionChanged]);
  return { ...resource, consumers, connectionChanged, acceptedDecisions, selectedDecisionId, pinned, selectDecision: (id: string) => { if (table) setSelection(id ? { tableId: table.tableSessionId, decisionId: id } : undefined); }, canEvaluate: !!target, evaluate: () => resource.request() };
}
