import type { ObservablePresentationEvent, ParticipantId } from '@poker/contracts';

export type ManagementEvent = Extract<ObservablePresentationEvent, { readonly type: 'participant-joined' | 'participant-left' | 'participant-seated' | 'participant-stood-up' | 'participant-moved' | 'sitting-out-changed' | 'participant-topped-up' | 'button-set' | 'seat-changes-changed' }>;
export type DraftEvent = ObservablePresentationEvent | { readonly type: 'hole-cards-dealt'; readonly participantId: ParticipantId; readonly cardCount: number; readonly cards: readonly string[] };
