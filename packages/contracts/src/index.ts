/** Participant-safe wire contracts. This package imports no authoritative code. */
export type ParticipantId = string;
export type TableSessionId = string;
export type ChipAmount = number;
export type Revision = number;
export type HandId = string;
export type DecisionId = string;
export type Card = string;

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
  readonly street?: 'preflop' | 'flop' | 'turn' | 'river';
  readonly smallBlindParticipantId?: ParticipantId;
  readonly bigBlindParticipantId?: ParticipantId;
  readonly returns?: readonly { readonly participantId: ParticipantId; readonly amount: ChipAmount }[];
  readonly payouts?: readonly { readonly participantId: ParticipantId; readonly amount: ChipAmount }[];
}
export type ObservablePresentationEvent =
  | { readonly type: 'participant-seated'; readonly participantId: ParticipantId; readonly seat: number; readonly buyIn: ChipAmount }
  | { readonly type: 'participant-left'; readonly participantId: ParticipantId; readonly seat: number; readonly cashOut: ChipAmount }
  | { readonly type: 'participant-moved'; readonly participantId: ParticipantId; readonly fromSeat: number; readonly seat: number }
  | { readonly type: 'sitting-out-changed'; readonly participantId: ParticipantId; readonly sittingOut: boolean }
  | { readonly type: 'participant-topped-up'; readonly participantId: ParticipantId; readonly targetStack: ChipAmount; readonly amount: ChipAmount }
  | { readonly type: 'button-set'; readonly seat: number }
  | { readonly type: 'hand-started'; readonly handId: HandId; readonly buttonSeat: number; readonly smallBlindParticipantId: ParticipantId; readonly bigBlindParticipantId: ParticipantId }
  | { readonly type: 'forced-contribution'; readonly participantId: ParticipantId; readonly kind: 'ante' | 'small-blind' | 'big-blind'; readonly amount: ChipAmount }
  | { readonly type: 'hole-cards-dealt'; readonly participantId: ParticipantId; readonly cardCount: number; readonly cards?: readonly Card[] }
  | { readonly type: 'acted'; readonly participantId: ParticipantId; readonly action: ConcreteAction }
  | { readonly type: 'card-burned'; readonly street: 'flop' | 'turn' | 'river' }
  | { readonly type: 'board-dealt'; readonly street: 'flop' | 'turn' | 'river'; readonly cards: readonly Card[] }
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
/** Table Owner preferences, independent of every Bot's Playing Strategy. */
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
export interface CreateTableSessionRequest {
  readonly requestId: string;
  readonly configuration?: Partial<ObservableGameConfiguration>;
  readonly bots?: readonly { readonly name: string; readonly playingStrategy: StrategyDescriptor }[];
}
export interface CreationAcknowledgement {
  readonly ok: true;
  readonly tableSessionId: TableSessionId;
  readonly bindings: readonly ParticipantBinding[];
}
export interface ApplicationRejection {
  readonly ok: false;
  readonly rejection: { readonly code: string; readonly message: string; readonly field?: string };
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
export interface LeaveParticipantRequest extends PokerMutationMetadata { readonly participantId: ParticipantId }
export interface MoveParticipantRequest extends PokerMutationMetadata { readonly participantId: ParticipantId; readonly seat: number }
export interface SetSittingOutRequest extends PokerMutationMetadata { readonly participantId: ParticipantId; readonly sittingOut: boolean }
export interface TopUpToRequest extends PokerMutationMetadata { readonly participantId: ParticipantId; readonly targetStack: ChipAmount }
export interface SetButtonRequest extends PokerMutationMetadata { readonly seat: number }
export type ParticipantManagementRequest = LeaveParticipantRequest | MoveParticipantRequest | SetSittingOutRequest | TopUpToRequest | SetButtonRequest;
export type ParticipantManagementKind = 'leave-participant' | 'move-participant' | 'set-sitting-out' | 'top-up-to' | 'set-button';
export interface ActRequest extends PokerMutationMetadata {
  readonly participantId: ParticipantId;
  readonly action: ConcreteAction;
}
export type PokerMutationRequest = SeatParticipantRequest | StartHandRequest | ActRequest | ParticipantManagementRequest;
/** A durable outcome contains no complete view; read the current view separately. */
export interface MutationAcknowledgement {
  readonly ok: true;
  readonly tableSessionId: TableSessionId;
  readonly pokerRevision: Revision;
  readonly sessionRevision: Revision;
}
export type MutationOutcome = MutationAcknowledgement | ApplicationRejection;
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
export interface ObservableTableSession {
  readonly tableSessionId: TableSessionId;
  readonly pokerRevision: Revision;
  readonly sessionRevision: Revision;
  readonly bindings: readonly ParticipantBinding[];
  readonly trainerConfiguration: TrainerConfiguration;
  readonly view: ObservableGameView;
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
export type TableLiveMessage = ObservableTableUpdate | TableRuntimeStatus | AnalysisUpdate;
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
export const defaultTrainerConfiguration: TrainerConfiguration = Object.freeze({ referenceStrategy: baselinePlayingStrategy, liveAnalysis: false });

export interface ControllerMutationMetadata { readonly requestId: string; readonly expectedSessionRevision: Revision; readonly participantId: ParticipantId }
export interface SetPlayingStrategyRequest extends ControllerMutationMetadata { readonly playingStrategy: StrategyDescriptor }
export interface RetryBotRequest extends ControllerMutationMetadata {}
export interface SetTrainerConfigurationRequest {
  readonly requestId: string;
  readonly expectedSessionRevision: Revision;
  readonly trainerConfiguration: TrainerConfiguration;
}
export const highestProbabilityPlayingStrategy: StrategyDescriptor = Object.freeze({ policy: baselinePlayingStrategy.policy, selector: Object.freeze({ id: 'highest-probability', version: 'v1', configuration: Object.freeze({}) }) });
