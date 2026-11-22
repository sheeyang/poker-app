import type { AfterHandRequest, StrategyDescriptor, TableMode, TableOptions, TableSchedule, TrainerConfiguration } from '@poker/contracts';
import type { TableSessionRecord } from '@poker/engine';
import { emptySchedule } from './schedule.js';
/**
 * A human Participant's application membership. Only `joined` grants access to the table.
 * The membership index (`table_memberships`) mirrors it in the same transaction as each commit.
 */
export type MembershipStatus = 'joined' | 'left';
export interface PersistedHumanBinding {
  readonly participantId: string;
  readonly name: string;
  readonly controller: { readonly kind: 'human' };
  /** The Guest who is this Participant's Human Controller. It never changes. */
  readonly userId: string;
  readonly membership: MembershipStatus;
}
export interface PersistedBotBinding {
  readonly participantId: string;
  readonly name: string;
  readonly controller: { readonly kind: 'bot'; readonly playingStrategy: StrategyDescriptor };
  readonly assignmentId?: string;
  /**
   * The owner removed this Bot: it has stood up and left the table. The binding stays so its name stays taken and
   * the Hands it played keep their names; it is never seated, managed or asked for a decision again.
   */
  readonly removed?: true;
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
  readonly schemaVersion: 3;
  readonly tableSessionId: string;
  /** Table Ownership: table options, Bots and inspection. Never control of another human. */
  readonly ownerUserId: string;
  readonly mode: TableMode;
  readonly options: TableOptions;
  readonly pokerRecord: TableSessionRecord;
  readonly bindings: readonly PersistedBinding[];
  readonly pokerRevision: number;
  readonly sessionRevision: number;
  readonly adminMode: boolean;
  readonly botProvenance?: readonly BotActionProvenance[];
  /**
   * Server-owned play timing, written in the same transaction as the commit that produced it
   * (`schedule.ts`). Never part of `pokerRecord`.
   */
  readonly schedule: TableSchedule;
  /**
   * After-Hand requests: changes to a human Participant asked for during a Hand (`after-hand.ts`). At most one
   * per Participant, in the order first asked. The server applies them all in one committed transition when
   * the Hand ends (the Settle after its payout), and clears them in the same transaction.
   */
  readonly pendingChanges: readonly AfterHandRequest[];
  /**
   * The Action Window most recently closed by its Timeout Action, with the poker revision at which it was open.
   * A late act aimed at that decision (same Participant and expected revision) is then told its deadline passed,
   * rather than that the table changed. Server-only: never projected.
   */
  readonly timedOutWindow?: { readonly participantId: string; readonly decisionId: string; readonly deadlineAt: number; readonly pokerRevision: number };
  /**
   * An Online Table's Table Password, as a salted, slow hash (`table-password.ts`), never the password. Server-only:
   * Participants are told only that it is set (`hasTablePassword` in the projected options).
   */
  readonly tablePasswordHash?: string;
  /**
   * A Closed Table (`closing.ts`): an Online Table idle for 24 hours, whose memberships have all ended. Nobody can open,
   * join or act at it, and it is never loaded again. The `closed` column mirrors it.
   */
  readonly closed?: true;
}
/**
 * Written before M6: each human Participant kept its own Trainer configuration, which is discarded on reading. The
 * Trainer Configuration belongs to the Guest now (ADR-0041). Read-only.
 */
export interface PersistedTableSessionV2 extends Omit<PersistedTableSession, 'schemaVersion' | 'bindings'> {
  readonly schemaVersion: 2;
  readonly bindings: readonly ((PersistedHumanBinding & { readonly trainerConfiguration?: TrainerConfiguration }) | PersistedBotBinding)[];
}
/** Written before M4: one owner-human and a table-level Trainer configuration. Read-only. */
export interface PersistedTableSessionV1 {
  readonly schemaVersion: 1;
  readonly tableSessionId: string;
  readonly ownerUserId: string;
  readonly pokerRecord: TableSessionRecord;
  readonly bindings: readonly (Omit<PersistedHumanBinding, 'membership'> | PersistedBotBinding)[];
  readonly trainerConfiguration: TrainerConfiguration;
  readonly pokerRevision: number;
  readonly sessionRevision: number;
  readonly adminMode: boolean;
  readonly botProvenance?: readonly BotActionProvenance[];
}
/** Any version found in `table_sessions.aggregate`. Read it only through `upgradeTableSession`. */
export type StoredTableSession = PersistedTableSessionV1 | PersistedTableSessionV2 | PersistedTableSession;
/** Version-1 tables are Practice Tables. The membership index backfill in schema.sql relies on this too. */
export const legacyTableMode: TableMode = 'practice';
/** Practice Tables have no Action Time Limit unless they ask for one. */
export const defaultPracticeOptions: TableOptions = { actionTimeLimitSeconds: null, allowLiveAnalysis: true };

/**
 * Upgrades every stored version in memory, or `undefined` for a row that is not one of them. The row is rewritten in
 * the current version at its next commit. Each version names exactly one format (ADR-0032 on ADR-0014): a row lacking
 * a part of its version's format is not guessed at.
 *
 * Every Trainer configuration a table kept, per Participant (version 2) or for the table (version 1), is discarded: the
 * Guest's own applies (ADR-0041). Version 1 loads as a Practice Table whose human is joined. It predates scheduled play,
 * so it loads with an empty schedule: its current decision, if any, has no recorded Action Window, and the restoring
 * caller opens one (`mutations.ts` `restorable`).
 */
export function upgradeTableSession(stored: StoredTableSession): PersistedTableSession | undefined {
  if (stored.schemaVersion === 3) return complete(stored) ? stored : undefined;
  if (stored.schemaVersion === 2) {
    const upgraded: PersistedTableSession = { ...stored, schemaVersion: 3, bindings: stored.bindings.map(withoutTrainerConfiguration) };
    return complete(upgraded) ? upgraded : undefined;
  }
  if (stored.schemaVersion !== 1) return undefined;
  const { trainerConfiguration: _discarded, ...rest } = stored;
  return {
    ...rest, schemaVersion: 3, mode: legacyTableMode, options: defaultPracticeOptions, schedule: emptySchedule, pendingChanges: [],
    bindings: stored.bindings.map((binding): PersistedBinding => binding.controller.kind === 'human'
      ? { ...withoutTrainerConfiguration(binding as PersistedHumanBinding), membership: 'joined' }
      : binding as PersistedBotBinding),
  };
}
const complete = (aggregate: PersistedTableSession) => !!(aggregate.mode && aggregate.options && aggregate.schedule && aggregate.pendingChanges);
function withoutTrainerConfiguration<T extends PersistedBinding>(binding: T & { readonly trainerConfiguration?: TrainerConfiguration }): T {
  if (!('trainerConfiguration' in binding)) return binding;
  const { trainerConfiguration: _discarded, ...rest } = binding;
  return rest as unknown as T;
}
export const isHuman = (binding: PersistedBinding | undefined): binding is PersistedHumanBinding => binding?.controller.kind === 'human';
export const isBot = (binding: PersistedBinding | undefined): binding is PersistedBotBinding => binding?.controller.kind === 'bot';
export const humanBindings = (aggregate: PersistedTableSession) => aggregate.bindings.filter(isHuman);
/** The joined, unremoved human Participant whose Human Controller is this Guest. */
export const memberBinding = (aggregate: PersistedTableSession, userId: string) => humanBindings(aggregate).find(binding => binding.userId === userId && binding.membership === 'joined');
export const findBinding = (aggregate: PersistedTableSession, participantId: unknown) => aggregate.bindings.find(binding => binding.participantId === participantId);
/**
 * The places of an Online Table's `onlineTableCapacity` that are taken: every joined human Participant and every Bot
 * the owner has not removed. None is held for anyone who left, a former Table Owner included (ADR-0034).
 */
export function placesTaken(aggregate: PersistedTableSession): number {
  const joined = humanBindings(aggregate).filter(binding => binding.membership === 'joined').length;
  const bots = aggregate.bindings.filter(binding => isBot(binding) && !binding.removed).length;
  return joined + bots;
}
