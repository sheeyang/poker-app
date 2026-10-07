import type { CreateTableSessionRequest, CreationAcknowledgement, ApplicationRejection, ObservableTableSession, SeatParticipantRequest, MutationAcknowledgement } from '@poker/contracts';
export class RequestFailure extends Error {
  constructor(readonly code: string, message: string, readonly definitive: boolean) { super(message); }
}
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch('/api' + path, { ...init, credentials: 'same-origin' });
  const data = await response.json();
  if (!response.ok || data.ok === false) {
    const rejection = (data as ApplicationRejection).rejection;
    throw new RequestFailure(rejection?.code ?? 'request-failed', rejection?.message ?? 'The server could not complete this request.', response.status < 500);
  }
  return data as T;
}
export const api = {
  establishIdentity: () => request<{ ok: true }>('/identity'),
  listSessions: () => request<{ tableSessionIds: string[] }>('/table-sessions'),
  readSession: (id: string) => request<ObservableTableSession>('/table-sessions/' + encodeURIComponent(id)),
  createSession: (body: CreateTableSessionRequest) => request<CreationAcknowledgement>('/table-sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  seatParticipant: (id: string, body: SeatParticipantRequest) => request<MutationAcknowledgement>('/table-sessions/' + encodeURIComponent(id) + '/seat-participant', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
};
