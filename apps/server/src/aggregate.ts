import type { ParticipantBinding } from '@poker/contracts';
import type { TableSessionRecord } from '@poker/engine';
export type PersistedBinding = ParticipantBinding & { readonly userId?: string };
export interface PersistedTableSession {
  readonly schemaVersion: 1;
  readonly tableSessionId: string;
  readonly ownerUserId: string;
  readonly pokerRecord: TableSessionRecord;
  readonly bindings: readonly PersistedBinding[];
  readonly pokerRevision: number;
  readonly sessionRevision: number;
  readonly adminMode: boolean;
}
