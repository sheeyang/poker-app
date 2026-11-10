import type { ObservableTableSession } from '@poker/contracts';

/**
 * Table Ownership as the Trainer words it. When the owner of an Online Table leaves, ownership passes to the
 * earliest-joined human still at it, or the table closes (ADR-0034). The server works that out and puts it in the
 * owner's own view (`ownerSuccession`); these only say it.
 */

/** What the owner's Leave Table does to ownership, as their leave confirmation says it. */
export interface LeaveWarning {
  readonly kind: 'successor' | 'closes';
  readonly heading: string;
  readonly detail: string;
  /** The confirm button's label: leaving that closes the table says so. */
  readonly confirm: string;
}

const manages = 'the Bots, the table rules and the Table Password';

/**
 * The warning on the owner's Leave Table confirmation, at the table and on the banner's Leave game alike: who becomes
 * the Table Owner, or that the table will close. `timing` is when the leave takes effect; during a Hand, its end.
 * Undefined for anyone but the owner of an Online Table.
 */
export function leaveWarning(table: ObservableTableSession, timing: 'now' | 'after-hand'): LeaveWarning | undefined {
  const succession = table.mode === 'online' && table.viewerParticipantId === table.ownerParticipantId ? table.ownerSuccession : undefined;
  if (!succession) return undefined;
  const later = timing === 'after-hand';
  if ('closes' in succession) return {
    kind: 'closes', heading: later ? 'This table closes when this hand ends' : 'This table will close',
    detail: 'Nobody else is here to take it over. Once you leave, no one can join or play at it again. It stays in your Online tables.',
    confirm: 'Leave and close table',
  };
  const name = table.bindings.find(binding => binding.participantId === succession.successorParticipantId)?.name ?? 'The earliest-joined player';
  return {
    kind: 'successor', heading: `${name} becomes the Table Owner${later ? ' when this hand ends' : ''}`,
    detail: `${name} joined earliest of everyone still here, so they take over ${manages}.`,
    confirm: 'Leave table',
  };
}

/**
 * What the table says when ownership has passed since `previousOwnerId` was the owner: who owns it now, and to the
 * new owner, what they now manage. Undefined while it has not changed.
 */
export function ownershipChange(previousOwnerId: string | undefined, table: ObservableTableSession): string | undefined {
  if (previousOwnerId === undefined || previousOwnerId === table.ownerParticipantId) return undefined;
  if (table.ownerParticipantId === table.viewerParticipantId) return `You’re now the Table Owner. You manage ${manages}.`;
  const owner = table.bindings.find(binding => binding.participantId === table.ownerParticipantId);
  return `${owner?.name ?? 'Someone else'} is now the Table Owner.`;
}
