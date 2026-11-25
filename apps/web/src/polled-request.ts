import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

/** A transient request the server answers at once and finishes in the background, each response naming its request. */
export interface PolledRequestOptions<T extends { readonly requestId: string }> {
  /** The request's own key: a new key asks again. */
  readonly key: readonly unknown[];
  /** The key of one request's state, read again while it runs. */
  readonly stateKey: (requestId: string | undefined) => readonly unknown[];
  readonly enabled: boolean;
  readonly create: () => Promise<T>;
  readonly read: (requestId: string, signal: AbortSignal) => Promise<T>;
  readonly retry: (requestId: string) => Promise<T>;
  /** Whether a state is still running, so it is read again. */
  readonly running: (state: T) => boolean;
  /**
   * Which read keeps the previous data on show while the next one loads: the request's own (a new key shows the old
   * request's state until it is answered) or its state's (a new `stateKey` shows the old state).
   */
  readonly previous: 'request' | 'state';
  /** Whether the request's answer is also its state's first read. */
  readonly seed?: boolean;
}

/**
 * Asks for a transient request once `enabled`, then reads its state again each second while it runs; Retry asks the
 * server to retry it, and `again` asks for a new request. This is the one place the Trainer still waits on such requests
 * by reading them again: only Table History's Score Summary, until table summaries report progress on the user channel
 * as Overall History's requests do (`use-followed-request`).
 */
export function usePolledRequest<T extends { readonly requestId: string }>({ key, stateKey, enabled, create, read, retry, running, previous, seed = true }: PolledRequestOptions<T>) {
  const queryClient = useQueryClient();
  const created = useQuery({
    queryKey: key, enabled, staleTime: Number.POSITIVE_INFINITY, gcTime: 0, retry: false,
    ...(previous === 'request' ? { placeholderData: keepPreviousData } : {}),
    queryFn: create,
  });
  const requestId = created.data?.requestId;
  const current = useQuery({
    queryKey: stateKey(requestId), enabled: !!requestId && !created.isPlaceholderData, retry: false,
    ...(previous === 'state' ? { placeholderData: keepPreviousData } : {}),
    initialData: seed ? created.data : undefined,
    refetchInterval: query => query.state.data && running(query.state.data) && !query.state.error ? 1000 : false,
    queryFn: ({ signal }) => read(requestId!, signal),
  });
  const retried = useMutation({
    mutationFn: retry,
    onSuccess: state => queryClient.setQueryData(stateKey(state.requestId), state),
  });
  const data = created.isPlaceholderData ? created.data : current.data ?? created.data;
  return {
    data,
    /** The data on show is an earlier request's, while the new one is asked for. */
    stale: created.isPlaceholderData,
    /** The request itself is being asked for. */
    asking: created.isFetching,
    error: created.error ?? current.error ?? retried.error,
    retrying: retried.isPending,
    retry: () => { if (data) retried.mutate(data.requestId); },
    again: () => { retried.reset(); void created.refetch(); },
  };
}
