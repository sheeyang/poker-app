import { useMutation, useQueryClient } from '@tanstack/react-query';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { api, RequestFailure } from '@poker/client';
import type { ActRequest, AddBotRequest, SetTableOptionsRequest, CreateTableSessionRequest, CreationAcknowledgement, JoinTableRequest, MutationAcknowledgement, ParticipantManagementKind, ParticipantManagementRequest, ReplaceJoinLinkRequest, RetryBotRequest, SeatParticipantRequest, SetPlayingStrategyRequest, SetTrainerConfigurationRequest, StartHandRequest } from '@poker/contracts';

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
  /** The Table Owner replaces the Online Table's Join Link. */
  | { readonly kind: 'replace-link'; readonly body: ReplaceJoinLinkRequest }
  /** The Table Owner returns to a table they left, without the Join Link. */
  | { readonly kind: 'rejoin'; readonly body: JoinTableRequest }
);
export type Attempt = TableAttempt | { readonly kind: 'create'; readonly body: CreateTableSessionRequest };

interface SessionState {
  selectedId: string | null;
  pending: Attempt | null;
  analysisOpen: boolean;
  animations: boolean;
  setup: { requestId: string; tableId?: string; paused?: string; afterHandId?: string | null } | null;
  setSetup: (setup: SessionState['setup']) => void;
  select: (id: string | null) => void;
  setPending: (pending: Attempt | null) => void;
  toggleAnalysis: () => void;
  setAnimations: (enabled: boolean) => void;
}

export const useSession = create<SessionState>()(persist(set => ({
  selectedId: null, pending: null, analysisOpen: false, animations: true, setup: null,
  setSetup: setup => set({ setup }),
  select: selectedId => set({ selectedId }),
  setPending: pending => set({ pending }),
  toggleAnalysis: () => set(state => ({ analysisOpen: !state.analysisOpen })),
  setAnimations: animations => set({ animations }),
}), { name: 'poker-trainer-v1' }));

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
    case 'rejoin': return api.rejoinTable(tableId, attempt.body);
    case 'replace-link': return api.replaceJoinLink(tableId, attempt.body);
    case 'add-bot': return api.addBot(tableId, attempt.body);
    case 'options': return api.setTableOptions(tableId, attempt.body);
  }
}

/** Persist the exact attempt before transmission; an ambiguous response never creates a second action. */
export function useCommand() {
  const queryClient = useQueryClient();
  const pending = useSession(state => state.pending);
  const setPending = useSession(state => state.setPending);
  const select = useSession(state => state.select);
  const mutation = useMutation({
    mutationFn: execute,
    retry: false,
    onSuccess: async (result, attempt) => {
      setPending(null);
      if (attempt.kind === 'create') {
        const setup = useSession.getState().setup;
        if (setup?.requestId === attempt.body.requestId) useSession.getState().setSetup({ ...setup, tableId: result.tableSessionId });
        select(result.tableSessionId);
        await queryClient.invalidateQueries({ queryKey: ['table-sessions'] });
      }
      // Leaving at once ends this Guest's place at the table; leaving after the Hand is announced when it happens.
      if (attempt.kind === 'manage' && attempt.operation === 'leave-table' && !('afterHand' in result)) {
        select(null);
        queryClient.removeQueries({ queryKey: ['table-session', result.tableSessionId] });
        await queryClient.invalidateQueries({ queryKey: ['table-sessions'] });
        return;
      }
      if (attempt.kind === 'rejoin') { select(result.tableSessionId); await queryClient.invalidateQueries({ queryKey: ['table-sessions'] }); }
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
