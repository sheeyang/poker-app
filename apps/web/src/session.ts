import { useMutation, useQueryClient } from '@tanstack/react-query';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { useRouter } from '@tanstack/react-router';
import { api, RequestFailure } from '@poker/client';
import type { ObservableTableSession, SavedTables, TableMode, ActRequest, AddBotRequest, SetTableOptionsRequest, SetTablePasswordRequest, CreateTableSessionRequest, CreationAcknowledgement, MutationAcknowledgement, ParticipantManagementKind, ParticipantManagementRequest, RetryBotRequest, SeatParticipantRequest, SetPlayingStrategyRequest, SetTrainerConfigurationRequest, StartHandRequest } from '@poker/contracts';
import { listPath, tablePath } from './table-address.js';
import { withMembershipEnded } from './current-table.js';

type TableAttempt = { readonly tableId: string } & (
  | { readonly kind: 'start'; readonly body: StartHandRequest }
  | { readonly kind: 'act'; readonly body: ActRequest }
  | { readonly kind: 'seat'; readonly body: SeatParticipantRequest }
  | { readonly kind: 'manage'; readonly operation: ParticipantManagementKind; readonly body: ParticipantManagementRequest }
  | { readonly kind: 'trainer'; readonly body: SetTrainerConfigurationRequest }
  | { readonly kind: 'strategy'; readonly body: SetPlayingStrategyRequest }
  | { readonly kind: 'retry-bot'; readonly body: RetryBotRequest }
  /** The Table Owner adds a Bot, at any time. */
  | { readonly kind: 'add-bot'; readonly body: AddBotRequest }
  /** The Table Owner changes an Online Table's options between Hands. */
  | { readonly kind: 'options'; readonly body: SetTableOptionsRequest }
  /** The Table Owner sets, changes or removes an Online Table's Table Password, at any time. Held in memory only. */
  | { readonly kind: 'password'; readonly body: SetTablePasswordRequest }
);
export type Attempt = TableAttempt | { readonly kind: 'create'; readonly body: CreateTableSessionRequest };

interface SessionState {
  pending: Attempt | null;
  analysisOpen: boolean;
  setup: { requestId: string; tableId?: string; paused?: string; afterHandId?: string | null } | null;
  setSetup: (setup: SessionState['setup']) => void;
  setPending: (pending: Attempt | null) => void;
  toggleAnalysis: () => void;
}

export const useSession = create<SessionState>()(persist(set => ({
  pending: null, analysisOpen: true, setup: null,
  setSetup: setup => set({ setup }),
  setPending: pending => set({ pending }),
  toggleAnalysis: () => set(state => ({ analysisOpen: !state.analysisOpen })),
}), {
  name: 'poker-trainer-v1',
  // Browser storage keeps only device preferences; what belongs to the Guest, such as when each table was last opened, is on the server (ADR-0037). A request, and anything a Guest typed into one, lives in memory for the life of the page.
  // Version 4 dropped the card-animation switch: table motion has no preference (ADR-0038).
  version: 4,
  partialize: ({ analysisOpen }) => ({ analysisOpen }),
  migrate: stored => {
    const { analysisOpen } = (stored ?? {}) as Partial<Pick<SessionState, 'analysisOpen'>>;
    return { analysisOpen: analysisOpen ?? true } as SessionState;
  },
}));

function execute(attempt: Attempt): Promise<CreationAcknowledgement | MutationAcknowledgement> {
  if (attempt.kind === 'create') return api.createSession(attempt.body);
  const { tableId } = attempt;
  switch (attempt.kind) {
    case 'start': return api.startHand(tableId, attempt.body);
    case 'act': return api.act(tableId, attempt.body);
    case 'seat': return api.seatParticipant(tableId, attempt.body);
    case 'manage': return api.manageParticipant(tableId, attempt.operation, attempt.body);
    case 'trainer': return api.setTrainerConfiguration(tableId, attempt.body);
    case 'strategy': return api.setPlayingStrategy(tableId, attempt.body);
    case 'retry-bot': return api.retryBot(tableId, attempt.body);
    case 'add-bot': return api.addBot(tableId, attempt.body);
    case 'options': return api.setTableOptions(tableId, attempt.body);
    case 'password': return api.setTablePassword(tableId, attempt.body);
  }
}

/** Hold the exact attempt in memory before transmission; an ambiguous response never creates a second action within a page's life. */
export function useCommand() {
  const queryClient = useQueryClient();
  const pending = useSession(state => state.pending);
  const setPending = useSession(state => state.setPending);
  const router = useRouter();
  // The table's own mode, for its address; a table not in the cache is an Online one, the only kind a Guest can leave.
  const modeOf = (id: string): TableMode => queryClient.getQueryData<ObservableTableSession>(['table-session', id])?.mode ?? 'online';
  const showing = (id: string) => router.state.location.pathname === tablePath(modeOf(id), id);
  const mutation = useMutation({
    mutationFn: execute,
    retry: false,
    onSuccess: async (result, attempt) => {
      setPending(null);
      if (attempt.kind === 'create') {
        const setup = useSession.getState().setup;
        if (setup?.requestId === attempt.body.requestId) useSession.getState().setSetup({ ...setup, tableId: result.tableSessionId });
        // Creating a table opens it: one Back step returns to the list it was created from.
        void router.navigate({ to: tablePath(attempt.body.mode ?? 'practice', result.tableSessionId) });
        await queryClient.invalidateQueries({ queryKey: ['table-sessions'] });
      }
      // Leaving at once ends this Guest's place at the table; leaving after the Hand is announced when it happens.
      if (attempt.kind === 'manage' && attempt.operation === 'leave-table' && !('afterHand' in result)) {
        // Back never returns to a table this Guest is no longer at.
        if (showing(result.tableSessionId)) void router.navigate({ to: listPath(modeOf(result.tableSessionId)), replace: true });
        // No longer their Current Table: the banner goes at once.
        queryClient.setQueryData<SavedTables>(['table-sessions'], list => withMembershipEnded(list, result.tableSessionId));
        queryClient.removeQueries({ queryKey: ['table-session', result.tableSessionId] });
        await queryClient.invalidateQueries({ queryKey: ['table-sessions'] });
        return;
      }
      await queryClient.invalidateQueries({ queryKey: ['table-session', result.tableSessionId] });
    },
    onError: async (error, attempt) => {
      if (error instanceof RequestFailure && error.definitive) setPending(null);
      if (attempt.kind !== 'create') await queryClient.invalidateQueries({ queryKey: ['table-session', attempt.tableId] });
    },
  });
  return {
    pending, error: mutation.error, busy: mutation.isPending || !!pending, sending: mutation.isPending,
    confirmedRequestId: mutation.isSuccess ? mutation.variables?.body.requestId : undefined,
    submit: (attempt: Attempt) => {
      if (useSession.getState().pending || mutation.isPending) return;
      setPending(attempt); mutation.mutate(attempt);
    },
    launch: (body: CreateTableSessionRequest) => {
      if (useSession.getState().pending || mutation.isPending) return;
      if (body.mode !== 'online') useSession.getState().setSetup({ requestId: body.requestId });
      const attempt: Attempt = { kind: 'create', body };
      setPending(attempt); mutation.mutate(attempt);
    },
    run: async (attempt: Attempt) => {
      if (useSession.getState().pending || mutation.isPending) throw new Error('Resolve the pending request first.');
      setPending(attempt); return mutation.mutateAsync(attempt);
    },
    check: () => { if (pending && !mutation.isPending) mutation.mutate(pending); },
    dismiss: () => {
      if (!pending || mutation.error instanceof RequestFailure && mutation.error.code === 'commit-not-applied') {
        setPending(null); mutation.reset();
      }
    },
  };
}

export type Command = ReturnType<typeof useCommand>;
