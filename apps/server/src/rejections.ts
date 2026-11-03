import { onlineTableCapacity, type ApplicationRejection } from '@poker/contracts';

/**
 * The application's own rejections, each a distinct, user-explicable code (engine codes pass straight through), and
 * what each one answers over HTTP.
 */
export const reject = (code: string, message: string): ApplicationRejection => ({ ok: false, rejection: { code, message } });
export const requestIdConflict = () => reject('request-id-conflict', 'This requestId was already used for different mutation contents.');
export const notFound = () => reject('not-found', 'This Table Session is unavailable to this local identity.');
export const ownerRequired = () => reject('table-owner-required', 'Only the Table Owner can deal, manage Bots, remove Guests, or change table options and the Join Link.');
export const unavailableOnline = (message: string) => reject('unavailable-at-online-tables', message);
export const removedGuest = () => reject('guest-removed', 'The Table Owner removed you from this table, so you cannot join it again.');
export const invalidJoinLink = () => reject('invalid-join-link', 'This Join Link does not work. Ask the Table Owner for a new one.');
export const tableFull = (advice: string) => reject('table-full', `This table already has ${onlineTableCapacity} Participants, Bots included. ${advice}`);
export const liveAnalysisDisallowed = () => reject('live-analysis-disallowed', 'This table did not allow Live Analysis when this decision began. Your decision is analyzed and scored after you act.');

/** Rejections that refuse who is asking: 403. */
const forbidden: ReadonlySet<string> = new Set(['actor-not-authorized', 'not-your-participant', 'table-owner-required', 'unavailable-at-online-tables', 'unavailable-at-practice-tables', 'guest-removed', 'live-analysis-disallowed']);
/** Rejections that a fresh view or a new request resolves, because the table or the request ID moved on: 409. */
const conflicts: ReadonlySet<string> = new Set(['request-id-conflict', 'stale-poker-revision', 'stale-session-revision', 'action-window-not-open', 'action-deadline-passed', 'payout-phase-not-ended', 'name-taken', 'table-full']);
/** Rejections that say the table is unavailable for now, not that the request is wrong: 503. */
const unavailable: ReadonlySet<string> = new Set(['session-recovering', 'commit-not-applied']);

/** The HTTP status of a table request's outcome: 200, or what its rejection means. Anything else wrong with the request is 400. */
export function outcomeStatus(outcome: { readonly ok: true } | ApplicationRejection): number {
  if (outcome.ok) return 200;
  const { code } = outcome.rejection;
  return code === 'not-found' || code === 'invalid-join-link' ? 404 : forbidden.has(code) ? 403 : unavailable.has(code) ? 503 : conflicts.has(code) ? 409 : 400;
}
