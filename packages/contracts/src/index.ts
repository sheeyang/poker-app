/** Participant-safe wire contracts. This package imports no authoritative code. */
export type ParticipantId = string;
export type TableSessionId = string;
export type ChipAmount = number;
export type Revision = number;

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
}
export type ConcreteAction =
  | { readonly type: 'fold' | 'check' | 'call' }
  | { readonly type: 'bet' | 'raise'; readonly to: ChipAmount };
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
}
export interface ObservableHistoryEntry {
  readonly handId: string;
  readonly description: string;
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
/** A durable outcome contains no complete view; read the current view separately. */
export interface MutationAcknowledgement {
  readonly ok: true;
  readonly tableSessionId: TableSessionId;
  readonly pokerRevision: Revision;
  readonly sessionRevision: Revision;
}
export type MutationOutcome = MutationAcknowledgement | ApplicationRejection;
export interface ObservableTableSession {
  readonly tableSessionId: TableSessionId;
  readonly pokerRevision: Revision;
  readonly sessionRevision: Revision;
  readonly bindings: readonly ParticipantBinding[];
  readonly view: ObservableGameView;
}
export const defaultConfiguration: Readonly<ObservableGameConfiguration> = Object.freeze({
  seatCount: 6, smallBlind: 10, bigBlind: 20, ante: 0,
  minimumBuyIn: 1000, defaultBuyIn: 1000, maximumBuyIn: 1000,
  allowSeatChanges: true,
});
export const baselinePlayingStrategy: StrategyDescriptor = Object.freeze({
  policy: Object.freeze({ id: 'uniform-choice', version: 'v1', configuration: Object.freeze({}) }),
  selector: Object.freeze({ id: 'seeded-sampling', version: 'v1', configuration: Object.freeze({}) }),
});
