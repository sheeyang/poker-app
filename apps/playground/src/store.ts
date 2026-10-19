import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { SetPlayingStrategyRequest, SetTrainerConfigurationRequest, RetryBotRequest, ActRequest, StartHandRequest, CreateTableSessionRequest, SeatParticipantRequest, ParticipantManagementKind, ParticipantManagementRequest } from '@poker/contracts';
export interface PendingTrainerConfiguration { readonly tableSessionId: string; readonly request: SetTrainerConfigurationRequest }
export type PendingController = { readonly tableSessionId: string } & ({ readonly kind: 'set-playing-strategy'; readonly request: SetPlayingStrategyRequest } | { readonly kind: 'retry-bot'; readonly request: RetryBotRequest });
export interface PendingManagement { readonly tableSessionId: string; readonly kind: ParticipantManagementKind; readonly request: ParticipantManagementRequest; readonly feedback: string }
export interface PendingSeating { readonly tableSessionId: string; readonly request: SeatParticipantRequest }
export type PendingHand = { readonly tableSessionId: string } & ({ readonly kind: 'start-hand'; readonly request: StartHandRequest } | { readonly kind: 'act'; readonly request: ActRequest });
interface PlaygroundState {
  selectedTableSessionId: string | null;
  pendingCreation: CreateTableSessionRequest | null;
  pendingSeating: PendingSeating | null;
  pendingHand: PendingHand | null;
  pendingManagement: PendingManagement | null;
  pendingController: PendingController | null;
  pendingTrainerConfiguration: PendingTrainerConfiguration | null;
  select: (id: string) => void;
  setPendingCreation: (request: CreateTableSessionRequest | null) => void;
  setPendingSeating: (request: PendingSeating | null) => void;
  setPendingHand: (request: PendingHand | null) => void;
  setPendingManagement: (request: PendingManagement | null) => void;
  setPendingController: (request: PendingController | null) => void;
  setPendingTrainerConfiguration: (request: PendingTrainerConfiguration | null) => void;
}
export const usePlayground = create<PlaygroundState>()(persist(set => ({
  selectedTableSessionId: null, pendingCreation: null, pendingSeating: null, pendingHand: null, pendingManagement: null, pendingController: null, pendingTrainerConfiguration: null,
  select: id => set({ selectedTableSessionId: id }),
  setPendingCreation: request => set({ pendingCreation: request }),
  setPendingSeating: request => set({ pendingSeating: request }),
  setPendingHand: request => set({ pendingHand: request }),
  setPendingManagement: request => set({ pendingManagement: request }),
  setPendingController: request => set({ pendingController: request }),
  setPendingTrainerConfiguration: request => set({ pendingTrainerConfiguration: request }),
}), { name: 'poker-playground' }));
