import type { JoinTableRequest } from '@poker/contracts';

/**
 * The join form's decisions, as pure functions. What a Guest types lives only in the form's memory for the life of
 * the page: nothing reaches browser storage.
 */

/** A join: the Table Password goes only to a table that asks for one, exactly as typed (it is case-sensitive). */
export function joinRequest(requestId: string, form: { passwordRequired: boolean; tablePassword: string }): JoinTableRequest {
  return form.passwordRequired ? { requestId, tablePassword: form.tablePassword } : { requestId };
}

/** Where a refused join is explained: under the field the Guest should fix, or for the whole form. */
export type JoinProblemField = 'tablePassword' | 'displayName' | 'form';

/**
 * What a refused join tells the Guest, and where. A missing or wrong Table Password names the Table Owner, who is
 * the one to ask; the server's own words cover everything else. `undefined`: the join failed without an answer.
 */
export function joinProblem(rejection: { code: string; message: string } | undefined, ownerName: string): { field: JoinProblemField; message: string } {
  if (!rejection) return { field: 'form', message: 'Couldn’t join this table. Check your connection and try again.' };
  switch (rejection.code) {
    case 'wrong-table-password': return { field: 'tablePassword', message: `That password isn’t right. Check it with ${ownerName} and try again.` };
    case 'table-password-required': return { field: 'tablePassword', message: `Enter the Table Password. ${ownerName} can tell you what it is.` };
    case 'name-taken': case 'invalid-display-name': case 'display-name-required': return { field: 'displayName', message: rejection.message };
    default: return { field: 'form', message: rejection.message };
  }
}
