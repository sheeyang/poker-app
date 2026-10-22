import { useEffect, useMemo, useState } from 'react';
import type { DecisionAnalysis, ObservableTableSession, ConcreteAction } from '@poker/contracts';
import { api, createAnalysisTarget, useAnalysisResource } from '@poker/client';

function identity(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(identity).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + identity((value as Record<string, unknown>)[key])).join(',') + '}';
  return JSON.stringify(value);
}
export function useDecisionAnalysis(table: ObservableTableSession | undefined) {
  const [selection, setSelection] = useState<{ tableId: string; decisionId: string }>();
  const human = table?.bindings.find(binding => binding.controller.kind === 'human')?.participantId;
  const acceptedDecisions = table?.view.history.flatMap(hand => hand.decisions.filter(decision => decision.action.participantId === human).map(decision => ({ decisionId: decision.decisionId, action: decision.action.action }))) ?? [];
  const newestAccepted = acceptedDecisions.at(-1)?.decisionId;
  const currentDecisionId = table?.view.state.legalActions.length ? table.view.state.decisionId : undefined;
  const liveEnabled = table?.trainerConfiguration.liveAnalysis ?? false;
  useEffect(() => { if (table && newestAccepted) setSelection({ tableId: table.tableSessionId, decisionId: newestAccepted }); }, [table?.tableSessionId, newestAccepted]);
  useEffect(() => { if (table && liveEnabled && currentDecisionId) setSelection({ tableId: table.tableSessionId, decisionId: '' }); }, [table?.tableSessionId, liveEnabled, currentDecisionId]);
  const selectedDecisionId = selection && selection.tableId === table?.tableSessionId && acceptedDecisions.some(decision => decision.decisionId === selection.decisionId) ? selection.decisionId : '';
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
  return { ...resource, acceptedDecisions, selectedDecisionId, selectDecision: (id: string) => { if (table) setSelection({ tableId: table.tableSessionId, decisionId: id }); }, canEvaluate: !!target, evaluate: () => resource.request() };
}
