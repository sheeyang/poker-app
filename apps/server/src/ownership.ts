import type { OwnerSuccession } from '@poker/contracts';
import { humanBindings, type PersistedHumanBinding, type PersistedTableSession } from './aggregate.js';
import { closedTableSession } from './closing.js';

/**
 * Table Ownership of an Online Table passes when its owner leaves (ADR-0034): to the human Participant who joined
 * earliest among those still at the table, watchers included. A Bot never owns a table. With no other human there,
 * the table closes.
 *
 * Join order is the record's own: every join of an Online Table, the owner's at creation included, is a `join-table`
 * command in its poker record, and a Guest who left and returned joined again with a new one. So the order is that of
 * each Participant's latest `join-table` command, and nothing else needs storing.
 */
function joinOrder(aggregate: PersistedTableSession): ReadonlyMap<string, number> {
  const order = new Map<string, number>();
  aggregate.pokerRecord.commands.forEach((command, index) => { if (command.type === 'join-table') order.set(command.participantId, index); });
  return order;
}

/**
 * The joined humans other than the owner, earliest-joined first, leaving out `excluded`. A human with no join
 * command, which an Online Table never has, sorts last.
 */
function successors(aggregate: PersistedTableSession, excluded: ReadonlySet<string> = new Set()): PersistedHumanBinding[] {
  const order = joinOrder(aggregate);
  const at = (binding: PersistedHumanBinding) => order.get(binding.participantId) ?? Number.MAX_SAFE_INTEGER;
  return humanBindings(aggregate)
    .filter(binding => binding.membership === 'joined' && binding.userId !== aggregate.ownerUserId && !excluded.has(binding.participantId))
    .sort((a, b) => at(a) - at(b));
}

/**
 * The next aggregate of a transition, with ownership settled: if the owner's membership ended in it, ownership passes
 * to the earliest-joined human still at the table, or, with nobody to take it, the table closes in the same transition
 * (and the same session revision). Otherwise it is returned unchanged. Practice Tables are never left.
 */
export function withOwnershipSettled(next: PersistedTableSession): PersistedTableSession {
  if (next.mode !== 'online' || next.closed) return next;
  const owner = humanBindings(next).find(binding => binding.userId === next.ownerUserId);
  if (owner?.membership === 'joined') return next;
  const successor = successors(next)[0];
  return successor ? { ...next, ownerUserId: successor.userId } : { ...closedTableSession(next), sessionRevision: next.sessionRevision };
}

/**
 * What the owner's Leave Table would do to ownership if asked now, for the owner's own view. Their leave takes effect
 * at once, or after the Hand (`afterHand`), together with every other pending Leave Table and Removal: those Guests
 * are gone by then, so they are not counted.
 */
export function ownerSuccession(aggregate: PersistedTableSession, afterHand: boolean): OwnerSuccession {
  const departing = new Set(afterHand ? aggregate.pendingChanges.filter(entry => entry.change === 'leave-table' || entry.change === 'remove').map(entry => entry.participantId) : []);
  const successor = successors(aggregate, departing)[0];
  return successor ? { successorParticipantId: successor.participantId } : { closes: true };
}
