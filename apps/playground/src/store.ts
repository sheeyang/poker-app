import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { ActRequest, StartHandRequest, CreateTableSessionRequest, SeatParticipantRequest } from '@poker/contracts';
export interface PendingSeating { readonly tableSessionId: string; readonly request: SeatParticipantRequest }
export type PendingHand = { readonly tableSessionId: string } & ({ readonly kind: 'start-hand'; readonly request: StartHandRequest } | { readonly kind: 'act'; readonly request: ActRequest });
interface PlaygroundState {
  selectedTableSessionId: string | null;
  pendingCreation: CreateTableSessionRequest | null;
  pendingSeating: PendingSeating | null;
  pendingHand: PendingHand | null;
  select: (id: string) => void;
  setPendingCreation: (request: CreateTableSessionRequest | null) => void;
  setPendingSeating: (request: PendingSeating | null) => void;
  setPendingHand: (request: PendingHand | null) => void;
}
export const usePlayground = create<PlaygroundState>()(persist(set => ({
  selectedTableSessionId: null, pendingCreation: null, pendingSeating: null, pendingHand: null,
  select: id => set({ selectedTableSessionId: id }),
  setPendingCreation: request => set({ pendingCreation: request }),
  setPendingSeating: request => set({ pendingSeating: request }),
  setPendingHand: request => set({ pendingHand: request }),
}), { name: 'poker-playground' }));
