import { historyFilterParams } from '@poker/contracts';
import type { SetPlayingStrategyRequest, SetTrainerConfigurationRequest, TrainerConfigurationAcknowledgement, RetryBotRequest, ActRequest, StartHandRequest, CreateTableSessionRequest, CreationAcknowledgement, ApplicationRejection, ObservableTableSession, SeatParticipantRequest, MutationAcknowledgement, ParticipantManagementKind, ParticipantManagementRequest, AddBotRequest, CompletedHandInspectionOutcome, DecisionAnalysis, HistoryBreakdown, HistoryFilter, JoinAcknowledgement, JoinLinkPreview, JoinTableRequest, OverallHistory, OverallHistorySummary, SavedTables, ScoreSummary, ScoredOverallHistory, SetTableOptionsRequest, SetTablePasswordRequest, StrategyDescriptor, TableHandReplay, TableHistory } from '@poker/contracts';
export class RequestFailure extends Error {
  /** With `current-table-elsewhere`: the User's Current Table, which they must leave first. */
  readonly currentTableId?: string;
  constructor(readonly code: string, message: string, readonly definitive: boolean, details: { readonly currentTableId?: string } = {}) {
    super(message);
    if (details.currentTableId !== undefined) this.currentTableId = details.currentTableId;
  }
}
async function request<T>(path: string, init?: RequestInit, acceptAnalysisError = false): Promise<T> {
  const response = await fetch('/api' + path, { ...init, credentials: 'same-origin' });
  const data = await response.json();
  if ((!response.ok && !(acceptAnalysisError && data.ok === true)) || data.ok === false) {
    const rejection = (data as ApplicationRejection).rejection;
    throw new RequestFailure(rejection?.code ?? 'request-failed', rejection?.message ?? 'The server could not complete this request.', response.status < 500, typeof rejection?.currentTableId === 'string' ? { currentTableId: rejection.currentTableId } : {});
  }
  return data as T;
}
export const api = {
  /** What an Online Table's Join Link, its own address, shows a User who is not at it. */
  previewJoin: (id: string, signal?: AbortSignal) => request<JoinLinkPreview>('/table-sessions/' + encodeURIComponent(id) + '/join-preview', { signal }),
  joinTable: (id: string, body: JoinTableRequest) => request<JoinAcknowledgement>('/table-sessions/' + encodeURIComponent(id) + '/join-table', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  createSessionSummary: (id: string) => request<ScoreSummary>('/table-sessions/' + encodeURIComponent(id) + '/session-summaries', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }, true),
  /** Table History's Score Summary of the viewer's own decisions at a table, under `strategy` or their Reference Strategy, run as their `history-analysis`. */
  requestTableHistorySummary: (id: string, strategy?: StrategyDescriptor) => request<ScoreSummary>('/table-sessions/' + encodeURIComponent(id) + '/session-summaries', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(strategy ? { history: true, strategy } : { history: true }) }, true),
  createHandSummary: (id: string, handId: string) => request<ScoreSummary>('/table-sessions/' + encodeURIComponent(id) + '/hand-summaries', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handId }) }, true),
  readSummary: (id: string, requestId: string) => request<ScoreSummary>('/table-sessions/' + encodeURIComponent(id) + '/summaries/' + encodeURIComponent(requestId)),
  retrySummary: (id: string, requestId: string) => request<ScoreSummary>('/table-sessions/' + encodeURIComponent(id) + '/summaries/' + encodeURIComponent(requestId) + '/retry', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }, true),
  retryAnalysis: (id: string, requestId: string) => request<DecisionAnalysis>('/table-sessions/' + encodeURIComponent(id) + '/analysis/' + encodeURIComponent(requestId) + '/retry', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }, true),
  getOrStartAnalysis: (id: string, decisionId: string, live = false) => request<DecisionAnalysis>('/table-sessions/' + encodeURIComponent(id) + '/analysis', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ decisionId, ...(live ? { live: true } : {}) }) }, true),
  /** Analysis of one of the viewer's own accepted decisions, asked for from Table History (`history-analysis`), under the User's Reference Strategy or the supported `strategy` named (Counterfactual Comparison). */
  getOrStartHistoryAnalysis: (id: string, decisionId: string, strategy?: StrategyDescriptor) => request<DecisionAnalysis>('/table-sessions/' + encodeURIComponent(id) + '/analysis', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ decisionId, history: true, ...(strategy ? { strategy } : {}) }) }, true),
  readAnalysis: (id: string, requestId: string) => request<DecisionAnalysis>('/table-sessions/' + encodeURIComponent(id) + '/analysis/' + encodeURIComponent(requestId)),
  addBot: (id: string, body: AddBotRequest) => request<MutationAcknowledgement>('/table-sessions/' + encodeURIComponent(id) + '/add-bot', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  setTableOptions: (id: string, body: SetTableOptionsRequest) => request<MutationAcknowledgement>('/table-sessions/' + encodeURIComponent(id) + '/set-table-options', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  /** The Table Owner sets, changes or removes (`null`) an Online Table's Table Password. */
  setTablePassword: (id: string, body: SetTablePasswordRequest) => request<MutationAcknowledgement>('/table-sessions/' + encodeURIComponent(id) + '/set-table-password', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  /** The User's Trainer Configuration, which applies at every table. */
  readTrainerConfiguration: (signal?: AbortSignal) => request<TrainerConfigurationAcknowledgement>('/trainer-configuration', { signal }),
  /** Changes the User's Trainer Configuration for every table; repeating the same request applies it once. */
  setTrainerConfiguration: (body: SetTrainerConfigurationRequest) => request<TrainerConfigurationAcknowledgement>('/trainer-configuration', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  inspectHand: (id: string, handId: string) => request<Extract<CompletedHandInspectionOutcome, { ok: true }>>('/table-sessions/' + encodeURIComponent(id) + '/inspect-hand', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handId }) }),
  setPlayingStrategy: (id: string, body: SetPlayingStrategyRequest) => request<MutationAcknowledgement>('/table-sessions/' + encodeURIComponent(id) + '/set-playing-strategy', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  retryBot: (id: string, body: RetryBotRequest) => request<MutationAcknowledgement>('/table-sessions/' + encodeURIComponent(id) + '/retry-bot', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  establishIdentity: () => request<{ ok: true; displayName?: string }>('/identity'),
  setDisplayName: (displayName: string) => request<{ ok: true; displayName: string }>('/display-name', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ displayName }) }),
  listSessions: () => request<SavedTables>('/table-sessions'),
  /** Says the User opened a table: the server times it, and it orders their saved lists. */
  markOpened: (id: string) => request<{ ok: true }>('/table-sessions/' + encodeURIComponent(id) + '/opened', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }),
  /** The table's completed Hands, as this Participant may see them. */
  /** Overall History: the User's own decisions across every table they can read, filtered by the declared non-score set and paged. */
  readOverallHistory: (filter: HistoryFilter, page: { readonly limit?: number; readonly offset?: number } = {}, signal?: AbortSignal) => request<OverallHistory>('/overall-history?' + new URLSearchParams({ ...historyFilterParams(filter), ...(page.limit !== undefined ? { limit: String(page.limit) } : {}), ...(page.offset !== undefined ? { offset: String(page.offset) } : {}) }), { signal }),
  /** A Score Summary over Overall History's filtered decisions, optionally broken down by one dimension; it answers at once and runs in the background. */
  requestOverallHistorySummary: (filter: HistoryFilter, breakdown?: HistoryBreakdown, strategy?: StrategyDescriptor) => request<OverallHistorySummary>('/overall-history/summaries', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ filter: historyFilterParams(filter), ...(breakdown ? { breakdown } : {}), ...(strategy ? { strategy } : {}) }) }),
  /** An Overall History summary request's current state, with its progress. */
  readOverallHistorySummary: (requestId: string, signal?: AbortSignal) => request<OverallHistorySummary>('/overall-history/summaries/' + encodeURIComponent(requestId), { signal }),
  /** Retries every failed analysis of an Overall History summary request. */
  retryOverallHistorySummary: (requestId: string) => request<OverallHistorySummary>('/overall-history/summaries/' + encodeURIComponent(requestId) + '/retry', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }),
  /** Overall History with score ranges: asks for the decisions they admit under the Reference Strategy; it answers at once (Analyzing, with progress) and the list follows once every analysis has succeeded. */
  askScoredOverallHistory: (filter: HistoryFilter, page: { readonly limit?: number } = {}) => request<ScoredOverallHistory>('/overall-history/scored' + (page.limit ? '?limit=' + page.limit : ''), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ filter: historyFilterParams(filter) }) }),
  /** A score-filtered request's current state: its progress, Error, or the first `limit` decisions. */
  readScoredOverallHistory: (requestId: string, page: { readonly limit?: number } = {}, signal?: AbortSignal) => request<ScoredOverallHistory>('/overall-history/scored/' + encodeURIComponent(requestId) + (page.limit ? '?limit=' + page.limit : ''), { signal }),
  /** Retries the failed analyses of a score-filtered request. */
  retryScoredOverallHistory: (requestId: string, page: { readonly limit?: number } = {}) => request<ScoredOverallHistory>('/overall-history/scored/' + encodeURIComponent(requestId) + '/retry' + (page.limit ? '?limit=' + page.limit : ''), { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }),
  readTableHistory: (id: string, signal?: AbortSignal) => request<TableHistory>('/table-sessions/' + encodeURIComponent(id) + '/history', { signal }),
  /** One completed Hand's Replay Steps, as this User may see them. */
  readHandReplay: (id: string, handId: string, signal?: AbortSignal) => request<TableHandReplay>('/table-sessions/' + encodeURIComponent(id) + '/history/' + encodeURIComponent(handId), { signal }),
  readSession: (id: string, signal?: AbortSignal) => request<ObservableTableSession>('/table-sessions/' + encodeURIComponent(id), { signal }),
  createSession: (body: CreateTableSessionRequest) => request<CreationAcknowledgement>('/table-sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  seatParticipant: (id: string, body: SeatParticipantRequest) => request<MutationAcknowledgement>('/table-sessions/' + encodeURIComponent(id) + '/seat-participant', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  startHand: (id: string, body: StartHandRequest) => request<MutationAcknowledgement>('/table-sessions/' + encodeURIComponent(id) + '/start-hand', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  act: (id: string, body: ActRequest) => request<MutationAcknowledgement>('/table-sessions/' + encodeURIComponent(id) + '/act', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  manageParticipant: (id: string, kind: ParticipantManagementKind, body: ParticipantManagementRequest) => request<MutationAcknowledgement>('/table-sessions/' + encodeURIComponent(id) + '/' + kind, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
};
