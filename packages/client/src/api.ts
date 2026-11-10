import type { SetPlayingStrategyRequest, SetTrainerConfigurationRequest, RetryBotRequest, ActRequest, StartHandRequest, CreateTableSessionRequest, CreationAcknowledgement, ApplicationRejection, ObservableTableSession, SeatParticipantRequest, MutationAcknowledgement, ParticipantManagementKind, ParticipantManagementRequest } from '@poker/contracts';
export class RequestFailure extends Error {
  constructor(readonly code: string, message: string, readonly definitive: boolean) { super(message); }
}
async function request<T>(path: string, init?: RequestInit, acceptAnalysisError = false): Promise<T> {
  const response = await fetch('/api' + path, { ...init, credentials: 'same-origin' });
  const data = await response.json();
  if ((!response.ok && !(acceptAnalysisError && data.ok === true)) || data.ok === false) {
    const rejection = (data as ApplicationRejection).rejection;
    throw new RequestFailure(rejection?.code ?? 'request-failed', rejection?.message ?? 'The server could not complete this request.', response.status < 500);
  }
  return data as T;
}
export const api = {
  /** What an Online Table's Join Link, its own address, shows a Guest who is not at it. */
  previewJoin: (id: string, signal?: AbortSignal) => request<import('@poker/contracts').JoinLinkPreview>('/table-sessions/' + encodeURIComponent(id) + '/join-preview', { signal }),
  joinTable: (id: string, body: import('@poker/contracts').JoinTableRequest) => request<import('@poker/contracts').JoinAcknowledgement>('/table-sessions/' + encodeURIComponent(id) + '/join-table', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  createSessionSummary: (id: string) => request<import('@poker/contracts').ScoreSummary>('/table-sessions/' + encodeURIComponent(id) + '/session-summaries', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }, true),
  createHandSummary: (id: string, handId: string) => request<import('@poker/contracts').ScoreSummary>('/table-sessions/' + encodeURIComponent(id) + '/hand-summaries', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handId }) }, true),
  readSummary: (id: string, requestId: string) => request<import('@poker/contracts').ScoreSummary>('/table-sessions/' + encodeURIComponent(id) + '/summaries/' + encodeURIComponent(requestId)),
  retrySummary: (id: string, requestId: string) => request<import('@poker/contracts').ScoreSummary>('/table-sessions/' + encodeURIComponent(id) + '/summaries/' + encodeURIComponent(requestId) + '/retry', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }, true),
  retryAnalysis: (id: string, requestId: string) => request<import('@poker/contracts').DecisionAnalysis>('/table-sessions/' + encodeURIComponent(id) + '/analysis/' + encodeURIComponent(requestId) + '/retry', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }, true),
  getOrStartAnalysis: (id: string, decisionId: string, live = false) => request<import('@poker/contracts').DecisionAnalysis>('/table-sessions/' + encodeURIComponent(id) + '/analysis', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ decisionId, ...(live ? { live: true } : {}) }) }, true),
  readAnalysis: (id: string, requestId: string) => request<import('@poker/contracts').DecisionAnalysis>('/table-sessions/' + encodeURIComponent(id) + '/analysis/' + encodeURIComponent(requestId)),
  addBot: (id: string, body: import('@poker/contracts').AddBotRequest) => request<MutationAcknowledgement>('/table-sessions/' + encodeURIComponent(id) + '/add-bot', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  setTableOptions: (id: string, body: import('@poker/contracts').SetTableOptionsRequest) => request<MutationAcknowledgement>('/table-sessions/' + encodeURIComponent(id) + '/set-table-options', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  /** The Table Owner sets, changes or removes (`null`) an Online Table's Table Password. */
  setTablePassword: (id: string, body: import('@poker/contracts').SetTablePasswordRequest) => request<MutationAcknowledgement>('/table-sessions/' + encodeURIComponent(id) + '/set-table-password', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  setTrainerConfiguration: (id: string, body: SetTrainerConfigurationRequest) => request<MutationAcknowledgement>('/table-sessions/' + encodeURIComponent(id) + '/set-trainer-configuration', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  inspectHand: (id: string, handId: string) => request<Extract<import('@poker/contracts').CompletedHandInspectionOutcome, { ok: true }>>('/table-sessions/' + encodeURIComponent(id) + '/inspect-hand', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handId }) }),
  setPlayingStrategy: (id: string, body: SetPlayingStrategyRequest) => request<MutationAcknowledgement>('/table-sessions/' + encodeURIComponent(id) + '/set-playing-strategy', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  retryBot: (id: string, body: RetryBotRequest) => request<MutationAcknowledgement>('/table-sessions/' + encodeURIComponent(id) + '/retry-bot', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  establishIdentity: () => request<{ ok: true; displayName?: string }>('/identity'),
  setDisplayName: (displayName: string) => request<{ ok: true; displayName: string }>('/display-name', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ displayName }) }),
  listSessions: () => request<import('@poker/contracts').SavedTables>('/table-sessions'),
  readSession: (id: string, signal?: AbortSignal) => request<ObservableTableSession>('/table-sessions/' + encodeURIComponent(id), { signal }),
  createSession: (body: CreateTableSessionRequest) => request<CreationAcknowledgement>('/table-sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  seatParticipant: (id: string, body: SeatParticipantRequest) => request<MutationAcknowledgement>('/table-sessions/' + encodeURIComponent(id) + '/seat-participant', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  startHand: (id: string, body: StartHandRequest) => request<MutationAcknowledgement>('/table-sessions/' + encodeURIComponent(id) + '/start-hand', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  act: (id: string, body: ActRequest) => request<MutationAcknowledgement>('/table-sessions/' + encodeURIComponent(id) + '/act', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  manageParticipant: (id: string, kind: ParticipantManagementKind, body: ParticipantManagementRequest) => request<MutationAcknowledgement>('/table-sessions/' + encodeURIComponent(id) + '/' + kind, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
};
