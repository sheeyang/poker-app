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
  retryAnalysis: (id: string, requestId: string) => request<import('@poker/contracts').DecisionAnalysis>('/table-sessions/' + encodeURIComponent(id) + '/analysis/' + encodeURIComponent(requestId) + '/retry', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }, true),
  getOrStartAnalysis: (id: string, decisionId: string) => request<import('@poker/contracts').DecisionAnalysis>('/table-sessions/' + encodeURIComponent(id) + '/analysis', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ decisionId }) }, true),
  readAnalysis: (id: string, requestId: string) => request<import('@poker/contracts').DecisionAnalysis>('/table-sessions/' + encodeURIComponent(id) + '/analysis/' + encodeURIComponent(requestId)),
  setTrainerConfiguration: (id: string, body: SetTrainerConfigurationRequest) => request<MutationAcknowledgement>('/table-sessions/' + encodeURIComponent(id) + '/set-trainer-configuration', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  inspectHand: (id: string, handId: string) => request<Extract<import('@poker/contracts').CompletedHandInspectionOutcome, { ok: true }>>('/table-sessions/' + encodeURIComponent(id) + '/inspect-hand', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handId }) }),
  setPlayingStrategy: (id: string, body: SetPlayingStrategyRequest) => request<MutationAcknowledgement>('/table-sessions/' + encodeURIComponent(id) + '/set-playing-strategy', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  retryBot: (id: string, body: RetryBotRequest) => request<MutationAcknowledgement>('/table-sessions/' + encodeURIComponent(id) + '/retry-bot', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  establishIdentity: () => request<{ ok: true }>('/identity'),
  listSessions: () => request<{ tableSessionIds: string[] }>('/table-sessions'),
  readSession: (id: string, signal?: AbortSignal) => request<ObservableTableSession>('/table-sessions/' + encodeURIComponent(id), { signal }),
  createSession: (body: CreateTableSessionRequest) => request<CreationAcknowledgement>('/table-sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  seatParticipant: (id: string, body: SeatParticipantRequest) => request<MutationAcknowledgement>('/table-sessions/' + encodeURIComponent(id) + '/seat-participant', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  startHand: (id: string, body: StartHandRequest) => request<MutationAcknowledgement>('/table-sessions/' + encodeURIComponent(id) + '/start-hand', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  act: (id: string, body: ActRequest) => request<MutationAcknowledgement>('/table-sessions/' + encodeURIComponent(id) + '/act', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  manageParticipant: (id: string, kind: ParticipantManagementKind, body: ParticipantManagementRequest) => request<MutationAcknowledgement>('/table-sessions/' + encodeURIComponent(id) + '/' + kind, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
};
