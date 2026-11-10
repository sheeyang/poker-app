/** Participant-safe wire contracts. This package imports no authoritative code. */
export type ParticipantId = string;
export type TableSessionId = string;
export type ChipAmount = number;
export type Revision = number;
export type HandId = string;
export type DecisionId = string;
export type Card = string;
/** Authoritative server time in milliseconds since the Unix epoch. */
export type ServerTime = number;
export type Street = 'preflop' | 'flop' | 'turn' | 'river';
export type BoardStreet = Exclude<Street, 'preflop'>;

export interface ObservableGameConfiguration {
  readonly seatCount: number;
  readonly smallBlind: ChipAmount;
  readonly bigBlind: ChipAmount;
  readonly ante: ChipAmount;
  readonly minimumBuyIn: ChipAmount;
  readonly defaultBuyIn: ChipAmount;
  readonly maximumBuyIn: ChipAmount;
  readonly allowSeatChanges: boolean;
}
export interface ObservableParticipant {
  readonly participantId: ParticipantId;
  readonly seat: number | null;
  readonly stack: ChipAmount;
  readonly sittingOut: boolean;
  readonly inHand?: boolean;
  readonly handSeat?: number;
  readonly folded?: boolean;
  readonly allIn?: boolean;
  readonly contribution?: ChipAmount;
  readonly anteContribution?: ChipAmount;
  readonly wager?: ChipAmount;
  readonly cardCount?: number;
  readonly holeCards?: readonly Card[];
}
export type ConcreteAction =
  | { readonly type: 'fold' | 'check' | 'call' }
  | { readonly type: 'bet'; readonly betTo: ChipAmount }
  | { readonly type: 'raise'; readonly raiseTo: ChipAmount };
export type LegalAction =
  | { readonly type: 'fold' | 'check' | 'call' }
  | { readonly type: 'bet' | 'raise'; readonly minimum: ChipAmount; readonly maximum: ChipAmount };
export interface ObservableCashGameState {
  readonly status: 'between-hands' | 'active-hand' | 'completed-hand';
  readonly buttonSeat: number;
  readonly participants: readonly ObservableParticipant[];
  readonly board: readonly string[];
  readonly pots: readonly { readonly amount: ChipAmount; readonly eligibleParticipantIds: readonly ParticipantId[] }[];
  readonly actorId: ParticipantId | null;
  readonly legalActions: readonly LegalAction[];
  readonly amountToCall?: ChipAmount;
  readonly handId?: HandId;
  readonly decisionId?: DecisionId | null;
  readonly street?: Street;
  readonly smallBlindParticipantId?: ParticipantId;
  readonly bigBlindParticipantId?: ParticipantId;
  readonly returns?: readonly { readonly participantId: ParticipantId; readonly amount: ChipAmount }[];
  readonly payouts?: readonly { readonly participantId: ParticipantId; readonly amount: ChipAmount }[];
}
export type ObservablePresentationEvent =
  | { readonly type: 'participant-joined'; readonly participantId: ParticipantId }
  | { readonly type: 'participant-left'; readonly participantId: ParticipantId }
  | { readonly type: 'participant-seated'; readonly participantId: ParticipantId; readonly seat: number; readonly buyIn: ChipAmount }
  | { readonly type: 'participant-stood-up'; readonly participantId: ParticipantId; readonly seat: number; readonly cashOut: ChipAmount }
  | { readonly type: 'participant-moved'; readonly participantId: ParticipantId; readonly fromSeat: number; readonly seat: number }
  | { readonly type: 'sitting-out-changed'; readonly participantId: ParticipantId; readonly sittingOut: boolean }
  | { readonly type: 'participant-topped-up'; readonly participantId: ParticipantId; readonly targetStack: ChipAmount; readonly amount: ChipAmount }
  | { readonly type: 'button-set'; readonly seat: number }
  | { readonly type: 'seat-changes-changed'; readonly allowSeatChanges: boolean }
  | { readonly type: 'hand-started'; readonly handId: HandId; readonly buttonSeat: number; readonly smallBlindParticipantId: ParticipantId; readonly bigBlindParticipantId: ParticipantId }
  | { readonly type: 'forced-contribution'; readonly participantId: ParticipantId; readonly kind: 'ante' | 'small-blind' | 'big-blind'; readonly amount: ChipAmount }
  | { readonly type: 'hole-cards-dealt'; readonly participantId: ParticipantId; readonly cardCount: number; readonly cards?: readonly Card[] }
  | { readonly type: 'acted'; readonly participantId: ParticipantId; readonly action: ConcreteAction }
  | { readonly type: 'card-burned'; readonly street: BoardStreet }
  | { readonly type: 'board-dealt'; readonly street: BoardStreet; readonly cards: readonly Card[] }
  | { readonly type: 'hole-cards-revealed'; readonly participantId: ParticipantId; readonly cards: readonly Card[] }
  | { readonly type: 'uncalled-return' | 'pot-awarded'; readonly participantId: ParticipantId; readonly amount: ChipAmount }
  | { readonly type: 'hand-completed'; readonly handId: HandId };
export interface ObservableHistoryEntry {
  readonly handId: string;
  readonly description: string;
  /** Decisions retain their original visibility; the accepted action is public information. */
  readonly decisions: readonly {
    readonly decisionId: DecisionId;
    readonly state: ObservableCashGameState;
    readonly action: { readonly participantId: ParticipantId; readonly action: ConcreteAction };
  }[];
  readonly result?: ObservableCashGameState;
}
export type ObservableSessionHistory = readonly ObservableHistoryEntry[];
export interface ObservableGameView {
  readonly configuration: ObservableGameConfiguration;
  readonly state: ObservableCashGameState;
  readonly history: ObservableSessionHistory;
}
export interface StrategyDescriptor {
  readonly policy: { readonly id: string; readonly version: string; readonly configuration: Readonly<Record<string, unknown>> };
  readonly selector: { readonly id: string; readonly version: string; readonly configuration: Readonly<Record<string, unknown>> };
}
/** One human Participant's study preferences, independent of other Participants and every Bot's Playing Strategy. */
export interface TrainerConfiguration {
  readonly referenceStrategy: StrategyDescriptor;
  readonly liveAnalysis: boolean;
}
export type ControllerDescriptor =
  | { readonly kind: 'human' }
  | { readonly kind: 'bot'; readonly playingStrategy: StrategyDescriptor };
export interface ParticipantBinding {
  readonly participantId: ParticipantId;
  readonly name: string;
  readonly controller: ControllerDescriptor;
}
/** The Action Time Limit lengths a table can offer, in seconds. */
export const actionTimeLimits = [15, 30, 60] as const;
export type ActionTimeLimitSeconds = typeof actionTimeLimits[number];
/** Table-wide options. Enforcement of the Action Time Limit belongs to server timing, not to creation. */
export interface TableOptions {
  /** `null` is off, which only a Practice Table can have: an Online Table always has a limit. */
  readonly actionTimeLimitSeconds: ActionTimeLimitSeconds | null;
  /** Whether Participants may use Live Analysis at this table. */
  readonly allowLiveAnalysis: boolean;
}
/** The table options as Participants see them: the options, and whether the table has a Table Password, never the password. */
export interface ObservableTableOptions extends TableOptions {
  readonly hasTablePassword?: true;
}
/** A Table Password's length in characters. It is case-sensitive and never trimmed. */
export const tablePasswordLength = { minimum: 4, maximum: 64 } as const;
/** Online defaults when creation names no option. */
export const defaultOnlineActionTimeLimitSeconds: ActionTimeLimitSeconds = 30;
/**
 * An Online Table holds at most this many Participants: its joined humans, the Bots its owner has not removed, and the
 * Table Owner's own place, which is held after they leave so that they can always return.
 */
export const onlineTableCapacity = 20;
export interface CreateTableSessionRequest {
  readonly requestId: string;
  /** Fixed for the table's life. Defaults to a Practice Table. */
  readonly mode?: TableMode;
  readonly configuration?: Partial<ObservableGameConfiguration>;
  readonly options?: Partial<TableOptions>;
  readonly bots?: readonly { readonly name: string; readonly playingStrategy: StrategyDescriptor }[];
  /** An Online Table's optional Table Password. It is never part of the creation's fingerprint or outcome. */
  readonly tablePassword?: string;
}
export interface CreationAcknowledgement {
  readonly ok: true;
  readonly tableSessionId: TableSessionId;
  readonly bindings: readonly ParticipantBinding[];
}
export interface ApplicationRejection {
  readonly ok: false;
  readonly rejection: {
    readonly code: string; readonly message: string; readonly field?: string;
    /** With `current-table-elsewhere`: the Guest's Current Table, which they must leave first. */
    readonly currentTableId?: TableSessionId;
  };
}
export type CreationOutcome = CreationAcknowledgement | ApplicationRejection;
export interface PokerMutationMetadata {
  readonly requestId: string;
  readonly expectedPokerRevision: Revision;
}
export interface SeatParticipantRequest extends PokerMutationMetadata {
  readonly participantId: ParticipantId;
  readonly seat: number;
  readonly buyIn?: ChipAmount;
}
export interface StartHandRequest extends PokerMutationMetadata {}
/** Stand Up: leave the Seat and cash out while remaining at the table. */
export interface StandUpParticipantRequest extends PokerMutationMetadata { readonly participantId: ParticipantId }
export interface MoveParticipantRequest extends PokerMutationMetadata { readonly participantId: ParticipantId; readonly seat: number }
export interface SetSittingOutRequest extends PokerMutationMetadata { readonly participantId: ParticipantId; readonly sittingOut: boolean }
export interface TopUpToRequest extends PokerMutationMetadata { readonly participantId: ParticipantId; readonly targetStack: ChipAmount }
export interface SetButtonRequest extends PokerMutationMetadata { readonly seat: number }
/** Leave Table: stand up if seated, then cease to be at the table. Self-service only. */
export interface LeaveTableRequest extends PokerMutationMetadata { readonly participantId: ParticipantId }
/**
 * Removal: the Table Owner ends a human Participant's membership. During a Hand it waits for the Hand (an
 * After-Hand Request); when it applies the Guest stands up and can no longer join through any Join Link.
 */
export interface RemoveParticipantRequest extends PokerMutationMetadata { readonly participantId: ParticipantId }
/**
 * The Table Owner adds a Bot, at either table mode and at any time, even during a Hand. The Bot takes the open Seat
 * named, or the lowest open one, with the buy-in named (the table's default otherwise); it is dealt in from the
 * next Hand without a missed blind. Its name must differ from every other Participant's, ignoring case.
 */
export interface AddBotRequest extends PokerMutationMetadata {
  readonly name: string;
  readonly playingStrategy: StrategyDescriptor;
  readonly seat?: number;
  readonly buyIn?: ChipAmount;
}
/**
 * The Table Owner removes a Bot: it stands up, cashing out, and leaves the table. A Bot in a Hand goes after it
 * (an After-Hand Request, shown to everyone like a human's). Its name stays taken and its past Hands stay in the history.
 */
export interface RemoveBotRequest extends PokerMutationMetadata { readonly participantId: ParticipantId }
export type ParticipantManagementRequest = StandUpParticipantRequest | MoveParticipantRequest | SetSittingOutRequest | TopUpToRequest | SetButtonRequest | LeaveTableRequest | RemoveParticipantRequest | RemoveBotRequest;
export type ParticipantManagementKind = 'stand-up-participant' | 'move-participant' | 'set-sitting-out' | 'top-up-to' | 'set-button' | 'leave-table' | 'remove-participant' | 'remove-bot';
export interface ActRequest extends PokerMutationMetadata {
  readonly participantId: ParticipantId;
  readonly action: ConcreteAction;
}
export type PokerMutationRequest = SeatParticipantRequest | StartHandRequest | ActRequest | AddBotRequest | ParticipantManagementRequest;
/** A durable outcome contains no complete view; read the current view separately. */
export interface MutationAcknowledgement {
  readonly ok: true;
  readonly tableSessionId: TableSessionId;
  readonly pokerRevision: Revision;
  readonly sessionRevision: Revision;
  /** The request was made during a Hand: it is recorded as pending and applies when the Hand's payout phase ends. */
  readonly afterHand?: true;
}
export type MutationOutcome = MutationAcknowledgement | ApplicationRejection;
/**
 * Joining carries a request ID but no expected revision: the joiner has not seen the table. A Guest who is not at a
 * table with a Table Password gives it too; it is never remembered with the request.
 */
export interface JoinTableRequest { readonly requestId: string; readonly tablePassword?: string }
/** The Guest's Participant at the table: the same one every time they join. */
export interface JoinAcknowledgement extends MutationAcknowledgement { readonly participantId: ParticipantId }
export type JoinOutcome = JoinAcknowledgement | ApplicationRejection;
/**
 * What an Online Table's Join Link, its own address, shows a Guest before they join. A table with a Table Password
 * shows a Guest who is not at it only its owner's name (`ProtectedJoinLinkPreview`).
 */
export type JoinLinkPreview = OpenJoinLinkPreview | ProtectedJoinLinkPreview;
export interface ProtectedJoinLinkPreview {
  readonly ok: true;
  readonly ownerName: string;
  readonly passwordRequired: true;
}
export interface OpenJoinLinkPreview {
  readonly ok: true;
  readonly ownerName: string;
  readonly passwordRequired?: undefined;
  readonly configuration: ObservableGameConfiguration;
  readonly options: TableOptions;
  /** How many of the table's `onlineTableCapacity` places are taken (see there). Joining is refused once all are. */
  readonly placesTaken: number;
  /** The requesting Guest has already joined, so joining returns their own Participant. */
  readonly alreadyJoined: boolean;
  /** The requesting Guest left this table earlier: joining returns them to their Participant under this original name. */
  readonly returningAs?: string;
}
/** Explicitly authorized completed-Hand Research output; never an Observable Game View. */
export interface CompletedHandInspection {
  readonly handId: HandId;
  readonly sequence: number;
  readonly buttonSeat: number;
  readonly smallBlindParticipantId: ParticipantId;
  readonly bigBlindParticipantId: ParticipantId;
  readonly participants: readonly { readonly participantId: ParticipantId; readonly seat: number; readonly holeCards: readonly Card[]; readonly contribution: ChipAmount; readonly anteContribution: ChipAmount; readonly folded: boolean; readonly allIn: boolean }[];
  readonly deck: readonly Card[];
  readonly drawnCardCount: number;
  readonly burns: readonly Card[];
  readonly board: readonly Card[];
  readonly pots: readonly { readonly amount: ChipAmount; readonly eligibleParticipantIds: readonly ParticipantId[] }[];
  readonly returns: readonly { readonly participantId: ParticipantId; readonly amount: ChipAmount }[];
  readonly payouts: readonly { readonly participantId: ParticipantId; readonly amount: ChipAmount }[];
}
export interface InspectHandRequest { readonly handId: HandId }
export type CompletedHandInspectionOutcome = { readonly ok: true; readonly tableSessionId: TableSessionId; readonly hand: CompletedHandInspection } | ApplicationRejection;
/** Owner application metadata, outside Participant histories and Policy inputs. */
export interface InspectionCapabilities {
  readonly adminMode: boolean;
  readonly completedHands: readonly { readonly handId: HandId; readonly sequence: number }[];
}
/** Fixed when a Table Session is created. */
export type TableMode = 'practice' | 'online';
/**
 * One entry of the saved-tables list: every table the Guest has a membership at, including those they left. It is built
 * from stored rows (mode, format, blinds, membership) and never loads a table, so it says nothing of play: how a Hand
 * stands and the Guest's stack come only from the Current Table's live copy. The size and stakes are absent only while
 * the stored table cannot be read.
 */
export interface SavedTable {
  readonly tableSessionId: TableSessionId;
  readonly mode: TableMode;
  readonly left?: true;
  /** A Closed Table: nobody can open, join or act at it. Its memberships have ended, so it is `left` too. */
  readonly closed?: true;
  readonly seatCount?: number;
  readonly stakes?: { readonly smallBlind: ChipAmount; readonly bigBlind: ChipAmount; readonly ante: ChipAmount };
}
export interface SavedTables { readonly tables: readonly SavedTable[] }
/**
 * What a Presentation Phase presents. The deal reveals hole cards; a street reveal reveals that street's
 * board cards; the showdown turns the remaining hands up; the payout awards the pots and returns uncalled chips.
 * The pause, only under Automatic Dealing (Online Tables), follows the payout and presents nothing new: the next
 * Next-Hand Countdown is announced when it ends.
 */
export type PresentationPhaseKind = 'deal' | 'street' | 'showdown' | 'payout' | 'pause';
/**
 * A server-timed interval in which no Participant may act. Clients show the step it presents from
 * `startsAt`; the next phase, or the Action Window, begins at `endsAt`. Phases are never poker commands.
 * A Hand's last phase is its payout, and Deal is accepted when that phase ends.
 */
export interface PresentationPhase {
  readonly kind: PresentationPhaseKind;
  readonly handId: HandId;
  /** The street presented: `preflop` for the deal, the street whose board cards a street reveal shows, and the street the Hand had reached for the showdown and the payout. */
  readonly street: Street;
  readonly startsAt: ServerTime;
  readonly endsAt: ServerTime;
  /** The server constant used for this entry. */
  readonly durationMs: number;
}
/** The interval in which the current decision's Participant may act. It opens when the preceding phase ends. */
export interface ActionWindow {
  readonly participantId: ParticipantId;
  readonly decisionId: DecisionId;
  readonly opensAt: ServerTime;
  /**
   * The Action Deadline of a human's window under an Action Time Limit: `opensAt` plus the limit. An action the
   * server receives later than this is rejected (`action-deadline-passed`), and the server plays the Timeout
   * Action (Check, or Fold when Check is not legal) as that Participant's decision. Bots never have one.
   */
  readonly deadlineAt?: ServerTime;
  /**
   * Present on a human's window when the table disallowed Live Analysis as the window opened: each window captures
   * Allow Live Analysis then, so a change between Hands applies from the next decision. Live Analysis of this
   * decision is refused (`live-analysis-disallowed`); post-action analysis and scoring are not affected.
   */
  readonly liveAnalysisDisallowed?: true;
}
/**
 * What an After-Hand Request changes: a change to a Participant that waits for the Hand in progress to end. A weaker
 * request is superseded by a stronger one (`sit-out` < `stand-up` < `leave-table` < `remove`): nothing a Guest asks for
 * undoes the owner's Removal. The server queues sit-outs of its own (an Online Timeout Action, a failed Bot).
 */
export type AfterHandRequestKind = 'sit-out' | 'stand-up' | 'leave-table' | 'remove';
/** How strong each kind is: a request replaces a pending one of the same Participant only if it is stronger. */
export const afterHandRequestStrength: Readonly<Record<AfterHandRequestKind, number>> = Object.freeze({ 'sit-out': 1, 'stand-up': 2, 'leave-table': 3, remove: 4 });
/** The public facts about a Participant that decide whether they are an Eligible Participant at an Online Table. */
export interface EligibilityFacts {
  readonly seat: number | null;
  readonly stack: ChipAmount;
  readonly sittingOut: boolean;
  readonly human: boolean;
  /** For a human: at least one live connection of their Guest is subscribed to the table. */
  readonly connected: boolean;
}
/** An Eligible Participant: seated with chips, not Sitting Out, and either a Bot or a connected human. */
export const isEligibleParticipant = (participant: EligibilityFacts): boolean => participant.seat !== null && participant.stack > 0 && !participant.sittingOut && (!participant.human || participant.connected);
/** Automatic Dealing deals only while at least two Eligible Participants remain, at least one of them human: Bots never play on alone. */
export function canDealNextHand(participants: readonly EligibilityFacts[]): boolean {
  const ready = participants.filter(isEligibleParticipant);
  return ready.length >= 2 && ready.some(participant => participant.human);
}
/** An After-Hand Request, public to everyone at the table. The view and the Persisted Table Session list them as `pendingChanges`. */
export interface AfterHandRequest { readonly participantId: ParticipantId; readonly change: AfterHandRequestKind }
/**
 * The announced server time at which an Online Table deals its next Hand (Automatic Dealing). When it expires
 * the server rechecks eligibility: it deals if at least two Eligible Participants remain, at least one of them
 * a connected human, and otherwise cancels the countdown until the condition holds again.
 */
export interface NextHandCountdown {
  readonly startsAt: ServerTime;
  readonly endsAt: ServerTime;
  /** The server constant used for this countdown. */
  readonly durationMs: number;
}
/**
 * The current Hand's Presentation Phases, in order, the current decision's Action Window, if any, and, between
 * Hands at an Online Table, the announced Next-Hand Countdown.
 */
export interface TableSchedule {
  readonly phases: readonly PresentationPhase[];
  readonly actionWindow: ActionWindow | null;
  readonly nextHandCountdown?: NextHandCountdown;
}
/** Who becomes the Table Owner when the owner leaves, or that the table closes with no other human at it. */
export type OwnerSuccession = { readonly successorParticipantId: ParticipantId } | { readonly closes: true };
export interface ObservableTableSession {
  readonly tableSessionId: TableSessionId;
  readonly mode: TableMode;
  readonly options: ObservableTableOptions;
  /** The Participant this view was projected for: the viewing Guest's own. */
  readonly viewerParticipantId: ParticipantId;
  /** The Table Owner's Participant: who manages table options and Bots. Never a right to control another human. */
  readonly ownerParticipantId: ParticipantId;
  readonly pokerRevision: Revision;
  readonly sessionRevision: Revision;
  readonly bindings: readonly ParticipantBinding[];
  /** The viewing Participant's own Trainer configuration. */
  readonly trainerConfiguration: TrainerConfiguration;
  readonly view: ObservableGameView;
  /** The committed schedule, durable with the revisions above. */
  readonly schedule: TableSchedule;
  /** When the server produced this view, so clients can estimate the server clock. */
  readonly serverTime: ServerTime;
  /** Changes asked for during the Hand in progress, applied together when its payout phase ends. Public. */
  readonly pendingChanges: readonly AfterHandRequest[];
  /**
   * At an Online Table, the human Participants connected to it when the view was produced: their Guest has at least
   * one live connection subscribed to it. Public and transient: it is never persisted and changes no revision, and
   * each change is also published live (`table-presence`). A Practice Table, with its single human, has none.
   */
  readonly connectedParticipantIds?: readonly ParticipantId[];
  /**
   * The Participants who are no longer at the table: humans who left it or were removed, and Bots the owner removed.
   * Public, and absent while nobody has departed. They keep their names in the history, and the owner is not offered
   * Removal of them.
   */
  readonly departedParticipantIds?: readonly ParticipantId[];
  /**
   * Only in the Table Owner's own view of an Online Table: what their Leave Table would do to ownership if they asked
   * for it now. Ownership passes to the earliest-joined human still at the table (ADR-0034), or, with nobody to take it,
   * the table closes. The server works out the join order, so the client only shows it.
   */
  readonly ownerSuccession?: OwnerSuccession;
  /** Application feedback; never part of the game view or a Policy input. */
  readonly runtimeStatus?: TableRuntimeStatus['status'];
  readonly inspection: InspectionCapabilities;
}
/** Every live update is a complete participant-safe snapshot of a committed aggregate. */
export interface ObservableTableUpdate extends ObservableTableSession {
  readonly type: 'table-update';
  readonly presentationEvents: readonly ObservablePresentationEvent[];
}
/** Transient controller/recovery feedback does not advance a durable revision. */
export interface TableRuntimeStatus {
  readonly type: 'table-status';
  readonly tableSessionId: TableSessionId;
  readonly status: { readonly phase: 'idle' | 'thinking' | 'failed' | 'recovering'; readonly participantId?: ParticipantId; readonly message?: string; readonly code?: 'capacity' | 'cancelled' | 'timeout' | 'failed' | 'incompatible' | 'invalid-policy' | 'selection-failed' | 'persistence-unavailable' };
}
/** Results remain HTTP resources; live analysis delivery only invalidates a request/attempt. */
export interface AnalysisUpdate {
  readonly type: 'analysis-update';
  readonly tableSessionId: TableSessionId;
  readonly resource: 'analysis' | 'summary';
  readonly requestId: string;
  readonly attemptId: string;
  readonly status: 'complete' | 'error';
}
export interface UserChannelReady { readonly type: 'user-channel-ready' }
export interface SubscribeTable { readonly type: 'subscribe-table'; readonly requestId: string; readonly tableSessionId: TableSessionId }
export interface UnsubscribeTable { readonly type: 'unsubscribe-table'; readonly requestId: string; readonly tableSessionId: TableSessionId }
export type ClientLiveMessage = SubscribeTable | UnsubscribeTable;
export type TableSubscriptionResult = {
  readonly type: 'table-subscription-result';
  readonly requestId: string;
  readonly tableSessionId: TableSessionId;
} & ({ readonly status: 'subscribed' | 'unsubscribed' } | { readonly status: 'rejected'; readonly code: 'not-found' | 'unavailable' });
/**
 * The last message a Guest's subscription receives after their Participant leaves the table or is removed, or the
 * table closes.
 * Their client returns to its saved tables.
 */
export interface TableMembershipEnded {
  readonly type: 'table-membership-ended';
  readonly tableSessionId: TableSessionId;
  /** The table closed, which ended everyone's membership: it is a Closed Table now. */
  readonly closed?: true;
}
/**
 * A change of who is connected at an Online Table, sent to everyone subscribed to it. Transient like
 * `table-status`: it advances no revision, and every complete view carries the same list.
 */
export interface TablePresence { readonly type: 'table-presence'; readonly tableSessionId: TableSessionId; readonly connectedParticipantIds: readonly ParticipantId[] }
export type TableLiveMessage = ObservableTableUpdate | TableRuntimeStatus | AnalysisUpdate | TableMembershipEnded | TablePresence;
export type ServerLiveMessage = UserChannelReady | TableSubscriptionResult | TableLiveMessage;
export const defaultConfiguration: Readonly<ObservableGameConfiguration> = Object.freeze({
  seatCount: 6, smallBlind: 10, bigBlind: 20, ante: 0,
  minimumBuyIn: 1000, defaultBuyIn: 1000, maximumBuyIn: 1000,
  allowSeatChanges: true,
});
export const baselinePlayingStrategy: StrategyDescriptor = Object.freeze({
  policy: Object.freeze({ id: 'uniform-choice', version: 'v1', configuration: Object.freeze({}) }),
  selector: Object.freeze({ id: 'seeded-sampling', version: 'v1', configuration: Object.freeze({}) }),
});
export const simpleHeuristicPlayingStrategy: StrategyDescriptor = Object.freeze({
  policy: Object.freeze({ id: 'simple-heuristic', version: 'v1', configuration: Object.freeze({}) }),
  selector: baselinePlayingStrategy.selector,
});
export const defaultPlayingStrategy = simpleHeuristicPlayingStrategy;
export const defaultTrainerConfiguration: TrainerConfiguration = Object.freeze({ referenceStrategy: defaultPlayingStrategy, liveAnalysis: true });

export interface ControllerMutationMetadata { readonly requestId: string; readonly expectedSessionRevision: Revision; readonly participantId: ParticipantId }
export interface SetPlayingStrategyRequest extends ControllerMutationMetadata { readonly playingStrategy: StrategyDescriptor }
export interface RetryBotRequest extends ControllerMutationMetadata {}
/** Sets the requesting Guest's own Participant's Trainer configuration. */
export interface SetTrainerConfigurationRequest {
  readonly requestId: string;
  readonly expectedSessionRevision: Revision;
  readonly trainerConfiguration: TrainerConfiguration;
}
/**
 * The options the Table Owner can change at an Online Table, between Hands. Each is optional; the request names only
 * what it changes. There is no way to turn the Action Time Limit off: an Online Table always has one.
 */
export interface TableOptionChanges {
  readonly actionTimeLimitSeconds?: ActionTimeLimitSeconds;
  readonly allowLiveAnalysis?: boolean;
  /** Applied through CashGame, so the Observable Game Configuration shows the current value. */
  readonly allowSeatChanges?: boolean;
}
/**
 * The Table Owner changes the table options of an Online Table between Hands. `options` names only the options to
 * change, at least one. Everyone at the table sees the change. Allow Live Analysis applies from the next Action Window
 * that opens: each window captures it.
 */
export interface SetTableOptionsRequest {
  readonly requestId: string;
  readonly expectedSessionRevision: Revision;
  readonly options: TableOptionChanges;
}
/**
 * The Table Owner sets, changes (`tablePassword`) or removes (`null`) an Online Table's Table Password, at any time,
 * even during a Hand. There is no expected revision: the latest password wins, and nobody at the table is affected.
 */
export interface SetTablePasswordRequest {
  readonly requestId: string;
  readonly tablePassword: string | null;
}
export const highestProbabilityPlayingStrategy: StrategyDescriptor = Object.freeze({ policy: baselinePlayingStrategy.policy, selector: Object.freeze({ id: 'highest-probability', version: 'v1', configuration: Object.freeze({}) }) });

/** Reproducible evaluation identity; effective seeds never enter a game view. */
export interface EvaluationIdentity {
  readonly tableSessionId: TableSessionId;
  readonly participantId: ParticipantId;
  readonly handId: HandId;
  readonly decisionId: string;
  readonly referenceStrategy: StrategyDescriptor;
  readonly inputFingerprint: string;
  readonly evaluationSeed: string;
  readonly selectionSeed: string;
  readonly engineVersion: 'v1';
  readonly randomVersion: 'v1';
  readonly evaluationVersion: 'v1';
}
export interface ReferenceStrategyEvaluation {
  readonly policyResult: { readonly choices: readonly { readonly action: ConcreteAction; readonly probability: number }[] };
  readonly selectedAction: ConcreteAction;
  readonly actionProbabilities: readonly ActionProbability[];
}
export interface ActionProbability { readonly type: ConcreteAction['type']; readonly probability: number }
export interface DecisionScores {
  readonly decisionScore: number;
  readonly actionRankScore: number;
  readonly actionProbabilities: readonly ActionProbability[];
}
export type AnalysisFailureCode = 'capacity' | 'cancelled' | 'timeout' | 'failed' | 'incompatible' | 'invalid-policy' | 'selection-failed' | 'persistence-unavailable';
export interface ScoredDecision { readonly acceptedAction: ConcreteAction; readonly scoringMethodVersion: 'v1' }
export interface AnalysisRequestIdentity extends EvaluationIdentity {
  readonly ok: true; readonly requestId: string; readonly attemptId: string;
  readonly scoredDecision?: ScoredDecision;
  readonly evaluationRequestId?: string;
}
export type DecisionAnalysis = AnalysisRequestIdentity & (
  | { readonly status: 'pending' }
  | { readonly status: 'complete'; readonly evaluation: ReferenceStrategyEvaluation; readonly scores?: DecisionScores }
  | { readonly status: 'error'; readonly error: { readonly code: AnalysisFailureCode; readonly message: string } }
);
export interface GetOrStartAnalysisRequest { readonly decisionId: string }

/** One immutable, explicitly requested set of accepted human decisions. */
interface ScoreSummaryMetadata {
  readonly ok: true; readonly tableSessionId: TableSessionId;
  readonly requestId: string; readonly attemptId: string; readonly capturedPokerRevision: Revision;
  readonly decisionIds: readonly string[]; readonly decisionCount: number; readonly referenceStrategy: StrategyDescriptor;
}
export type ScoreSummaryScope = { readonly scope: 'hand'; readonly handId: HandId } | { readonly scope: 'table-session' };
export type ScoreSummaryIdentity = ScoreSummaryMetadata & ScoreSummaryScope;
export type ScoreSummary = ScoreSummaryIdentity & (
  | { readonly status: 'empty' | 'pending' }
  | { readonly status: 'complete'; readonly averages: ScoreAverages }
  | { readonly status: 'error'; readonly error: { readonly code: AnalysisFailureCode; readonly message: string } }
);

export type HandScoreSummary = ScoreSummary & { readonly scope: 'hand'; readonly handId: HandId };
export type TableSessionScoreSummary = ScoreSummary & { readonly scope: 'table-session' };

export interface ScoreAverages { readonly decisionScore: number; readonly actionRankScore: number }
