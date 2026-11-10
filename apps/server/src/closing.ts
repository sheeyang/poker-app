import { isHuman, type PersistedTableSession } from './aggregate.js';

/** How long an Online Table may go without a committed change before it closes (ADR-0035). Practice Tables never close. */
export const idleTableCloseMs = 24 * 60 * 60_000;
/** How often the server looks for Online Tables that have been idle that long. */
export const idleTableSweepMs = 10 * 60_000;

/**
 * The table as a Closed Table: every human membership ends, and its After-Hand Requests will never be applied. Its
 * record and completed Hands stay as they were. A Closed Table is never loaded again, so nothing it had scheduled runs.
 */
export function closedTableSession(aggregate: PersistedTableSession): PersistedTableSession {
  return { ...aggregate, closed: true, sessionRevision: aggregate.sessionRevision + 1, pendingChanges: [],
    bindings: aggregate.bindings.map(binding => isHuman(binding) && binding.membership === 'joined' ? { ...binding, membership: 'left' as const } : binding) };
}
