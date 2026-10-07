import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { CreateTableSessionRequest } from '@poker/contracts';
interface PlaygroundState {
  selectedTableSessionId: string | null;
  pendingCreation: CreateTableSessionRequest | null;
  select: (id: string) => void;
  setPendingCreation: (request: CreateTableSessionRequest | null) => void;
}
export const usePlayground = create<PlaygroundState>()(persist(set => ({
  selectedTableSessionId: null, pendingCreation: null,
  select: id => set({ selectedTableSessionId: id }),
  setPendingCreation: request => set({ pendingCreation: request }),
}), { name: 'poker-playground' }));
