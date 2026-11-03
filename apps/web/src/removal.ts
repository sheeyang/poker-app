import type { ObservableTableSession, ParticipantBinding } from '@poker/contracts';
import { afterHandRequestOf } from './self-service.js';
import { hasDeparted } from './owner-controls.js';

/**
 * Whether the viewer may ask to remove this Participant: only the Table Owner, only another human who is still
 * at the table, and not again once a Removal is pending. The server decides; the Trainer just does not offer
 * what it will refuse.
 */
export function canRemove(table: ObservableTableSession, binding: ParticipantBinding): boolean {
  return table.viewerParticipantId === table.ownerParticipantId && binding.controller.kind === 'human'
    && binding.participantId !== table.ownerParticipantId && !hasDeparted(table, binding.participantId) && afterHandRequestOf(table, binding.participantId) !== 'remove';
}

/** During a Hand, Removal waits for it to end (an After-Hand Request); between Hands it applies at once. */
export const removalTiming = (handOpen: boolean): 'now' | 'after-hand' => handOpen ? 'after-hand' : 'now';
