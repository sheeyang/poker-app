import { useQuery } from '@tanstack/react-query';
import { api } from '@poker/client';

/** The query key of the Guest's own Trainer Configuration: invalidate it when the Guest changes their configuration. */
export const trainerConfigurationKey = ['trainer-configuration'] as const;

/**
 * The Guest's Trainer Configuration: one choice for every table, read outside any table so a former table works too.
 * `enabled` once the Guest's identity is established.
 */
export function useTrainerConfiguration(enabled: boolean) {
  return useQuery({ queryKey: trainerConfigurationKey, queryFn: ({ signal }) => api.readTrainerConfiguration(signal), enabled });
}
