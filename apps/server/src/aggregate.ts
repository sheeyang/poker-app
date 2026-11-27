import type { AfterHandRequest, StrategyDescriptor, TableMode, TableOptions, TableSchedule, TrainerConfiguration } from '@poker/contracts';
import type { TableSessionRecord } from '@poker/engine';
import { emptySchedule } from './schedule.js';
/**
 * A player's application membership. Only `joined` grants access to the table.
 * The membership index (`table_memberships`) mirrors it in the same transaction as each commit.
 */
export type MembershipStatus = 'joined' | 'left';
export interface PersistedPlayerBinding {
  readonly participantId: string;
  readonly name: string;
  readonly controller: { readonly kind: 'player' };
  /** The User who is this Participant's Controller. It never changes. */
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
export type PersistedBinding = PersistedPlayerBinding | PersistedBotBinding;
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
  readonly schemaVersion: 4;
  readonly tableSessionId: string;
  /** Table Ownership: table options, Bots and inspection. Never control of another player. */
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
   * The server time (ms) each completed Hand was completed, by HandId (Table History, ADR-0040). Recorded beside the
   * poker record, never in it. A Hand completed before this was recorded has no entry and shows no time.
   */
  readonly handCompletedAt?: Readonly<Record<string, number>>;
  /**
   * Server-owned play timing, written in the same transaction as the commit that produced it
   * (`schedule.ts`). Never part of `pokerRecord`.
   */
  readonly schedule: TableSchedule;
  /**
   * After-Hand requests: changes to a player asked for during a Hand (`after-hand.ts`). At most one
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
 * A player's binding as stored before version 4, when a player's controller kind was `'human'`. Read-only: version 4
 * names it `'player'`.
 */
export type LegacyPlayerBinding = Omit<PersistedPlayerBinding, 'controller'> & { readonly controller: { readonly kind: 'human' } };
/** Written before the controller kind became `'player'`. Read-only. */
export interface PersistedTableSessionV3 extends Omit<PersistedTableSession, 'schemaVersion' | 'bindings'> {
  readonly schemaVersion: 3;
  readonly bindings: readonly (LegacyPlayerBinding | PersistedBotBinding)[];
}
/**
 * Written before M6: each player kept its own Trainer configuration, which is discarded on reading. The
 * Trainer Configuration belongs to the User now (ADR-0041). Read-only.
 */
export interface PersistedTableSessionV2 extends Omit<PersistedTableSessionV3, 'schemaVersion' | 'bindings'> {
  readonly schemaVersion: 2;
  readonly bindings: readonly ((LegacyPlayerBinding & { readonly trainerConfiguration?: TrainerConfiguration }) | PersistedBotBinding)[];
}
/** Written before M4: one player, its owner, and a table-level Trainer configuration. Read-only. */
export interface PersistedTableSessionV1 {
  readonly schemaVersion: 1;
  readonly tableSessionId: string;
  readonly ownerUserId: string;
  readonly pokerRecord: TableSessionRecord;
  readonly bindings: readonly (Omit<LegacyPlayerBinding, 'membership'> | PersistedBotBinding)[];
  readonly trainerConfiguration: TrainerConfiguration;
  readonly pokerRevision: number;
  readonly sessionRevision: number;
  readonly adminMode: boolean;
  readonly botProvenance?: readonly BotActionProvenance[];
}
/** Any version found in `table_sessions.aggregate`. Read it only through `upgradeTableSession`. */
export type StoredTableSession = PersistedTableSessionV1 | PersistedTableSessionV2 | PersistedTableSessionV3 | PersistedTableSession;
/** Version-1 tables are Practice Tables. The membership index backfill in schema.sql relies on this too. */
export const legacyTableMode: TableMode = 'practice';
/** Practice Tables have no Action Time Limit unless they ask for one. */
export const defaultPracticeOptions: TableOptions = { actionTimeLimitSeconds: null, allowLiveAnalysis: true };

/**
 * Upgrades every stored version in memory, or `undefined` for a row that is not one of them. The row is rewritten in
 * the current version at its next commit. Each version names exactly one format (ADR-0032 on ADR-0014): a row lacking
 * a part of its version's format is not guessed at, and no key is stripped but the ones named here.
 *
 * Every Trainer configuration a table kept, per Participant (version 2) or for the table (version 1), is discarded: the
 * User's own applies (ADR-0041). Version 1 loads as a Practice Table whose player is joined. It predates scheduled play,
 * so it loads with an empty schedule: its current decision, if any, has no recorded Action Window, and the restoring
 * caller opens one (`mutations.ts` `restorable`). Versions 1 to 3 name a player's controller kind `'human'`; version 4
 * names it `'player'`.
 *
 * Any new SQL on the stored controller kind must accept both `'human'` and `'player'`: a row is rewritten only when
 * its table next commits. The query in `schema.sql` that matches `'human'` reads version-1 rows, which hold only that
 * value, and stays as it is.
 */
export function upgradeTableSession(stored: StoredTableSession): PersistedTableSession | undefined {
  if (stored.schemaVersion === 4) return complete(stored) ? stored : undefined;
  if (stored.schemaVersion === 3) {
    const upgraded: PersistedTableSession = { ...stored, schemaVersion: 4, bindings: stored.bindings.map(withPlayerKind) };
    return complete(upgraded) ? upgraded : undefined;
  }
  if (stored.schemaVersion === 2) {
    const upgraded: PersistedTableSession = { ...stored, schemaVersion: 4, bindings: stored.bindings.map(binding => withPlayerKind(withoutTrainerConfiguration(binding))) };
    return complete(upgraded) ? upgraded : undefined;
  }
  if (stored.schemaVersion !== 1) return undefined;
  const { trainerConfiguration: _discarded, ...rest } = stored;
  return {
    ...rest, schemaVersion: 4, mode: legacyTableMode, options: defaultPracticeOptions, schedule: emptySchedule, pendingChanges: [],
    bindings: stored.bindings.map((binding): PersistedBinding => isLegacyPlayer(binding)
      ? { ...withPlayerKind(withoutTrainerConfiguration(binding)), membership: 'joined' } as PersistedPlayerBinding
      : binding),
  };
}
const complete = (aggregate: PersistedTableSession) => !!(aggregate.mode && aggregate.options && aggregate.schedule && aggregate.pendingChanges);
function withoutTrainerConfiguration<T extends object>(binding: T & { readonly trainerConfiguration?: TrainerConfiguration }): T {
  if (!('trainerConfiguration' in binding)) return binding;
  const { trainerConfiguration: _discarded, ...rest } = binding;
  return rest as unknown as T;
}
/** A binding of an older version with the current controller kind: a `'human'` player becomes a `'player'`; a Bot is unchanged. */
function withPlayerKind(binding: Omit<LegacyPlayerBinding, 'membership'> | LegacyPlayerBinding | PersistedBotBinding): PersistedBinding {
  // A version-1 binding has no membership yet: the caller adds it.
  return isLegacyPlayer(binding) ? { ...binding, controller: { kind: 'player' } } as PersistedBinding : binding;
}
const isLegacyPlayer = <B extends { readonly controller: { readonly kind: string } }>(binding: B): binding is Extract<B, { readonly controller: { readonly kind: 'human' } }> => binding.controller.kind === 'human';
export const isPlayer = (binding: PersistedBinding | undefined): binding is PersistedPlayerBinding => binding?.controller.kind === 'player';
export const isBot = (binding: PersistedBinding | undefined): binding is PersistedBotBinding => binding?.controller.kind === 'bot';
export const playerBindings = (aggregate: PersistedTableSession) => aggregate.bindings.filter(isPlayer);
/** The joined, unremoved player whose Controller is this User. */
export const memberBinding = (aggregate: PersistedTableSession, userId: string) => playerBindings(aggregate).find(binding => binding.userId === userId && binding.membership === 'joined');
export const findBinding = (aggregate: PersistedTableSession, participantId: unknown) => aggregate.bindings.find(binding => binding.participantId === participantId);
/**
 * The places of an Online Table's `onlineTableCapacity` that are taken: every joined player and every Bot
 * the owner has not removed. None is held for anyone who left, a former Table Owner included (ADR-0034).
 */
export function placesTaken(aggregate: PersistedTableSession): number {
  const joined = playerBindings(aggregate).filter(binding => binding.membership === 'joined').length;
  const bots = aggregate.bindings.filter(binding => isBot(binding) && !binding.removed).length;
  return joined + bots;
}
