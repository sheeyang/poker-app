import type { ParticipantBinding, StrategyDescriptor, TrainerConfiguration } from '@poker/contracts';
import type { TableSessionRecord } from '@poker/engine';
export type PersistedBinding = ParticipantBinding & { readonly userId?: string; readonly assignmentId?: string };
export interface BotActionProvenance {
  readonly commandIndex: number;
  readonly participantId: string;
  readonly handId: string;
  readonly decisionId: string;
  readonly playingStrategy: StrategyDescriptor;
  readonly assignmentId: string;
  readonly evaluationSeed: string;
  readonly selectionSeed: string;
  readonly inputFingerprint: string;
  readonly evaluationRequestId: string;
}
export interface PersistedTableSession {
  readonly schemaVersion: 1;
  readonly tableSessionId: string;
  readonly ownerUserId: string;
  readonly pokerRecord: TableSessionRecord;
  readonly bindings: readonly PersistedBinding[];
  readonly trainerConfiguration: TrainerConfiguration;
  readonly pokerRevision: number;
  readonly sessionRevision: number;
  readonly adminMode: boolean;
  readonly botProvenance?: readonly BotActionProvenance[];
}
