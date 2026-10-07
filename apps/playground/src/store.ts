import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { CreateTableSessionRequest, SeatParticipantRequest } from '@poker/contracts';
export interface PendingSeating { readonly tableSessionId: string; readonly request: SeatParticipantRequest }
interface PlaygroundState {
  selectedTableSessionId: string | null;
  pendingCreation: CreateTableSessionRequest | null;
  pendingSeating: PendingSeating | null;
  select: (id: string) => void;
  setPendingCreation: (request: CreateTableSessionRequest | null) => void;
  setPendingSeating: (request: PendingSeating | null) => void;
}
export const usePlayground = create<PlaygroundState>()(persist(set => ({
  selectedTableSessionId: null, pendingCreation: null, pendingSeating: null,
  select: id => set({ selectedTableSessionId: id }),
  setPendingCreation: request => set({ pendingCreation: request }),
  setPendingSeating: request => set({ pendingSeating: request }),
}), { name: 'poker-playground' }));
