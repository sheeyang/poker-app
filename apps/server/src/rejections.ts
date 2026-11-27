import { onlineTableCapacity, type ApplicationRejection } from '@poker/contracts';

/**
 * The application's own rejections, each a distinct, user-explicable code (engine codes pass straight through), and
 * what each one answers over HTTP.
 */
export const reject = (code: string, message: string): ApplicationRejection => ({ ok: false, rejection: { code, message } });
export const requestIdConflict = () => reject('request-id-conflict', 'This requestId was already used for different mutation contents.');
export const notFound = () => reject('not-found', 'This Table Session is unavailable to this local identity.');
/** A request without an established local identity: the Trainer establishes one when it opens. */
export const unauthenticated = () => reject('unauthenticated', 'Open the Trainer to establish your local identity.');
/**
 * A transient request the server does not hold for this User, or an ID it never issued: 404, telling them how to ask
 * again. One per kind of request.
 */
export const scoredRequestNotFound = () => reject('not-found', 'This transient request is unavailable. Ask for the filtered list again.');
export const overallSummaryNotFound = () => reject('not-found', 'This transient summary request is unavailable. Request a new summary explicitly.');
export const tableSummaryNotFound = () => reject('not-found', 'This transient summary request is unavailable. Request a new snapshot explicitly.');
export const analysisNotFound = () => reject('not-found', 'This analysis is unavailable.');
export const ownerRequired =() => reject('table-owner-required', 'Only the Table Owner can deal, manage Bots, remove players, or change table options.');
export const unavailableOnline = (message: string) => reject('unavailable-at-online-tables', message);
/** A User is at one Online Table at a time: creating, joining or returning to another waits until they leave it. */
export const currentTableElsewhere = (currentTableId: string): ApplicationRejection => ({ ok: false, rejection: { code: 'current-table-elsewhere', currentTableId,
  message: 'You’re already at another Online Table, your Current Table. Leave it first, then try again.' } });
/** A Closed Table: told to anyone who asks to join it or opens its Join Link. */
export const tableClosed = () => reject('table-closed', 'This table has closed. Nobody can join or play at it any more.');
export const tablePasswordRequired = () => reject('table-password-required', 'This table has a Table Password. Ask the Table Owner for it, then join with it.');
export const wrongTablePassword = () => reject('wrong-table-password', 'That password isn’t right. Check it with the Table Owner and try again.');
export const tableFull = (advice: string) => reject('table-full', `This table already has ${onlineTableCapacity} Participants, Bots included. ${advice}`);
export const liveAnalysisDisallowed = () => reject('live-analysis-disallowed', 'This table did not allow Live Analysis when this decision began. Your decision is analyzed and scored after you act.');

/** Rejections that refuse who is asking: 403. */
const forbidden: ReadonlySet<string> = new Set(['actor-not-authorized', 'not-your-participant', 'table-owner-required', 'unavailable-at-online-tables', 'unavailable-at-practice-tables', 'live-analysis-disallowed', 'table-password-required', 'wrong-table-password']);
/** Rejections that a fresh view or a new request resolves, because the table or the request ID moved on: 409. */
const conflicts: ReadonlySet<string> = new Set(['request-id-conflict', 'stale-poker-revision', 'stale-session-revision', 'action-window-not-open', 'action-deadline-passed', 'hand-not-ended', 'name-taken', 'table-full', 'current-table-elsewhere']);
/** Rejections that say the table is gone for good: 410. */
const gone: ReadonlySet<string> = new Set(['table-closed']);
/** Rejections that say the table is unavailable for now, not that the request is wrong: 503. */
const unavailable: ReadonlySet<string> = new Set(['session-recovering', 'commit-not-applied']);

/** The HTTP status of a table request's outcome: 200, or what its rejection means. Anything else wrong with the request is 400. */
export function outcomeStatus(outcome: { readonly ok: true } | ApplicationRejection): number {
  if (outcome.ok) return 200;
  const { code } = outcome.rejection;
  return code === 'not-found' ? 404 : forbidden.has(code) ? 403 : unavailable.has(code) ? 503 : gone.has(code) ? 410 : conflicts.has(code) ? 409 : 400;
}
