import type { StrategyDescriptor, TableMode, TableOptions, TrainerConfiguration } from '@poker/contracts';
import type { TableSessionRecord } from '@poker/engine';
/**
 * A human Participant's application membership. Only `joined` grants access to the table.
 * The membership index (`table_memberships`) mirrors it in the same transaction as each commit.
 */
export type MembershipStatus = 'joined' | 'left' | 'removed';
export interface PersistedHumanBinding {
  readonly participantId: string;
  readonly name: string;
  readonly controller: { readonly kind: 'human' };
  /** The Guest who is this Participant's Human Controller. It never changes. */
  readonly userId: string;
  readonly membership: MembershipStatus;
  readonly trainerConfiguration: TrainerConfiguration;
}
export interface PersistedBotBinding {
  readonly participantId: string;
  readonly name: string;
  readonly controller: { readonly kind: 'bot'; readonly playingStrategy: StrategyDescriptor };
  readonly assignmentId?: string;
}
export type PersistedBinding = PersistedHumanBinding | PersistedBotBinding;
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
  readonly schemaVersion: 2;
  readonly tableSessionId: string;
  /** Table Ownership: table options, Bots and inspection. Never control of another human. */
  readonly ownerUserId: string;
  readonly mode: TableMode;
  readonly options: TableOptions;
  /** The Online Table's current Join Link token. A unique index in schema.sql reads this exact key. */
  readonly joinToken?: string;
  readonly pokerRecord: TableSessionRecord;
  readonly bindings: readonly PersistedBinding[];
  readonly pokerRevision: number;
  readonly sessionRevision: number;
  readonly adminMode: boolean;
  readonly botProvenance?: readonly BotActionProvenance[];
}
/** Written before M4: one owner-human and a table-level Trainer configuration. Read-only. */
export interface PersistedTableSessionV1 {
  readonly schemaVersion: 1;
  readonly tableSessionId: string;
  readonly ownerUserId: string;
  readonly pokerRecord: TableSessionRecord;
  readonly bindings: readonly (Omit<PersistedHumanBinding, 'membership' | 'trainerConfiguration'> | PersistedBotBinding)[];
  readonly trainerConfiguration: TrainerConfiguration;
  readonly pokerRevision: number;
  readonly sessionRevision: number;
  readonly adminMode: boolean;
  readonly botProvenance?: readonly BotActionProvenance[];
}
/** Any version found in `table_sessions.aggregate`. Read it only through `upgradeTableSession`. */
export type StoredTableSession = PersistedTableSessionV1 | PersistedTableSession;
/** Version-1 tables are Practice Tables. The membership index backfill in schema.sql relies on this too. */
export const legacyTableMode: TableMode = 'practice';
/** Practice Tables have no Action Time Limit unless they ask for one. */
export const defaultPracticeOptions: TableOptions = { actionTimeLimitSeconds: null, allowLiveAnalysis: true };

/**
 * Upgrades every stored version in memory. The row is rewritten in the current version at its next commit.
 * Version 1 loads as a Practice Table whose joined human takes the table-level Trainer configuration.
 */
export function upgradeTableSession(stored: StoredTableSession): PersistedTableSession {
  if (stored.schemaVersion === 2) return stored.options ? stored : { ...stored, options: defaultPracticeOptions };
  const { trainerConfiguration, ...rest } = stored;
  return {
    ...rest, schemaVersion: 2, mode: legacyTableMode, options: defaultPracticeOptions,
    bindings: stored.bindings.map((binding): PersistedBinding => binding.controller.kind === 'human'
      ? { ...binding as Omit<PersistedHumanBinding, 'membership' | 'trainerConfiguration'>, membership: 'joined', trainerConfiguration }
      : binding as PersistedBotBinding),
  };
}
export const isHuman = (binding: PersistedBinding | undefined): binding is PersistedHumanBinding => binding?.controller.kind === 'human';
export const isBot = (binding: PersistedBinding | undefined): binding is PersistedBotBinding => binding?.controller.kind === 'bot';
export const humanBindings = (aggregate: PersistedTableSession) => aggregate.bindings.filter(isHuman);
/** The joined, unremoved human Participant whose Human Controller is this Guest. */
export const memberBinding = (aggregate: PersistedTableSession, userId: string) => humanBindings(aggregate).find(binding => binding.userId === userId && binding.membership === 'joined');
export const findBinding = (aggregate: PersistedTableSession, participantId: unknown) => aggregate.bindings.find(binding => binding.participantId === participantId);
