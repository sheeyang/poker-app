import { tableSessionIdPattern } from './membership.js';

/** A request ID as the server issues it: a lowercase UUID, as a Table Session ID is. */
export const requestIdPattern = tableSessionIdPattern;
/** A request ID a client supplies in a body or live message: a string of 1 to 128 characters. */
export function isSuppliedRequestId(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= 128;
}
