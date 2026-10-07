import type { ObservableGameConfiguration, ObservableGameView, ParticipantId } from '@poker/contracts';
import { draftFaults } from './internal/draft-faults.js';
export type { ObservableGameConfiguration, ObservableGameView, ParticipantId } from '@poker/contracts';
export interface HiddenGameConfiguration { readonly seed: string }
export type GameConfiguration = ObservableGameConfiguration & HiddenGameConfiguration;
export type CashGameCommand = { readonly type: 'seat-participant'; readonly participantId: ParticipantId; readonly seat: number; readonly buyIn: number };
export type CashGameEvent = { readonly type: 'participant-seated'; readonly participantId: ParticipantId; readonly seat: number; readonly buyIn: number };
export type CashGameResult =
  | { readonly ok: true; readonly events: readonly CashGameEvent[] }
  | { readonly ok: false; readonly rejection: CashGameRejection };
interface CashGameState {
  status: 'between-hands' | 'active-hand' | 'completed-hand';
  buttonSeat: number;
  participants: { participantId: ParticipantId; seat: number | null; stack: number; sittingOut: boolean }[];
  commands: CashGameCommand[];
  bankroll: number;
}
export interface TableSessionRecord {
  readonly schemaVersion: 1;
  readonly engineVersion: 'v1';
  readonly configuration: GameConfiguration;
  readonly commands: readonly CashGameCommand[];
}
export interface CashGameRejection { readonly code: string; readonly message: string; readonly field?: string }
export type CashGameConstructionResult =
  | { readonly ok: true; readonly game: CashGame }
  | { readonly ok: false; readonly rejection: CashGameRejection };


function configurationRejection(configuration: GameConfiguration): CashGameRejection | undefined {
  const reject = (field: string, message: string): CashGameRejection => ({ code: 'invalid-configuration', field, message });
  if (!configuration || typeof configuration !== 'object') return reject('configuration', 'Supply a complete Game Configuration.');
  if (!Number.isInteger(configuration.seatCount) || configuration.seatCount < 2 || configuration.seatCount > 9)
    return reject('seatCount', 'Choose an integer seat count from 2 to 9.');
  for (const field of ['smallBlind', 'bigBlind', 'ante', 'minimumBuyIn', 'defaultBuyIn', 'maximumBuyIn'] as const) {
    if (!Number.isSafeInteger(configuration[field]) || configuration[field] < 0)
      return reject(field, 'Chip amounts must be nonnegative representable integers.');
  }
  if (configuration.smallBlind === 0) return reject('smallBlind', 'The small blind must be positive.');
  if (configuration.bigBlind < configuration.smallBlind) return reject('bigBlind', 'The big blind must be at least the small blind.');
  if (configuration.minimumBuyIn > configuration.defaultBuyIn || configuration.defaultBuyIn > configuration.maximumBuyIn)
    return reject('defaultBuyIn', 'Buy-in limits must be ordered minimum, default, maximum.');
  if (typeof configuration.allowSeatChanges !== 'boolean') return reject('allowSeatChanges', 'Seat-change policy must be a boolean.');
  if (typeof configuration.seed !== 'string' || configuration.seed.length === 0) return reject('seed', 'Trusted construction requires an explicit nonempty master seed.');
}
function immutable<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) immutable(child);
    Object.freeze(value);
  }
  return value;
}
function validateState(state: CashGameState, configuration: GameConfiguration): void {
  const identities = new Set<string>();
  const seats = new Set<number>();
  let bankroll = 0n;
  for (const p of state.participants) {
    if (!p.participantId || identities.has(p.participantId)) throw new Error('Participant identity invariant failed.');
    identities.add(p.participantId);
    if (p.seat !== null) {
      if (!Number.isInteger(p.seat) || p.seat < 1 || p.seat > configuration.seatCount || seats.has(p.seat)) throw new Error('Seat invariant failed.');
      seats.add(p.seat);
    }
    if (!Number.isSafeInteger(p.stack) || p.stack < 0) throw new Error('Stack invariant failed.');
    bankroll += BigInt(p.stack);
  }
  if (bankroll > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Chip capacity invariant failed.');
  if (bankroll !== BigInt(state.bankroll)) throw new Error('Chip conservation invariant failed.');
}
export class ParticipantCashGame {
  constructor(private readonly read: () => ObservableGameView) {}
  getView(): ObservableGameView { return this.read(); }
}
export class CashGame {
  #configuration: GameConfiguration;
  #state: CashGameState = { status: 'between-hands', buttonSeat: 1, participants: [], commands: [], bankroll: 0 };
  private constructor(configuration: GameConfiguration) { this.#configuration = structuredClone(configuration); }
  static create(configuration: GameConfiguration): CashGameConstructionResult {
    const rejection = configurationRejection(configuration);
    if (rejection) return { ok: false, rejection };
    return { ok: true, game: new CashGame(configuration) };
  }

  static fromRecord(record: unknown): CashGameConstructionResult {
    const invalid = (): CashGameConstructionResult => ({ ok: false, rejection: { code: 'invalid-record', message: 'The complete record must use supported versions and valid accepted commands.' } });
    if (!record || typeof record !== 'object') return invalid();
    const r = record as Partial<TableSessionRecord>;
    if (Object.keys(r).some(key => !['schemaVersion', 'engineVersion', 'configuration', 'commands'].includes(key)) || r.schemaVersion !== 1 || r.engineVersion !== 'v1' || !Array.isArray(r.commands) || !r.configuration)
      return invalid();
    const result = CashGame.create(r.configuration);
    if (!result.ok) return invalid();
    for (const command of r.commands) {
      if (!command || typeof command !== 'object' || command.type !== 'seat-participant' || Object.keys(command).sort().join(',') !== 'buyIn,participantId,seat,type' || !Number.isSafeInteger(command.buyIn)) return invalid();
      const accepted = result.game.seatParticipant(command.participantId, command.seat, command.buyIn);
      if (!accepted.ok) return invalid();
    }
    validateState(result.game.#state, result.game.#configuration);
    return result;
  }
  fork(): CashGame {
    const fork = new CashGame(this.#configuration);
    fork.#state = structuredClone(this.#state);
    return fork;
  }
  toRecord(): TableSessionRecord {
    return immutable({ schemaVersion: 1, engineVersion: 'v1', configuration: structuredClone(this.#configuration), commands: structuredClone(this.#state.commands) });
  }
  seatParticipant(participantId: ParticipantId, seat: number, buyIn = this.#configuration.defaultBuyIn): CashGameResult {
    const reject = (code: string, message: string, field?: string): CashGameResult => ({ ok: false, rejection: { code, message, ...(field ? { field } : {}) } });
    if (this.#state.status === 'active-hand') return reject('active-hand', 'Seat Participants between Hands.');
    if (typeof participantId !== 'string' || participantId.trim().length === 0) return reject('invalid-participant', 'Supply a nonempty ParticipantId.', 'participantId');
    if (!Number.isInteger(seat) || seat < 1 || seat > this.#configuration.seatCount) return reject('invalid-seat', 'Choose a valid seat in this table.', 'seat');
    if (this.#state.participants.some(p => p.participantId === participantId && p.seat !== null)) return reject('participant-already-seated', 'This Participant is already seated.');
    if (this.#state.participants.some(p => p.seat === seat)) return reject('seat-occupied', 'Choose an empty seat.', 'seat');
    if (!Number.isSafeInteger(buyIn) || buyIn < this.#configuration.minimumBuyIn || buyIn > this.#configuration.maximumBuyIn) return reject('invalid-buy-in', 'Choose an integer buy-in within the inclusive table limits.', 'buyIn');
    const bankroll = this.#state.participants.reduce((total, p) => total + BigInt(p.stack), 0n);
    if (bankroll + BigInt(buyIn) > BigInt(Number.MAX_SAFE_INTEGER)) return reject('chip-capacity-exceeded', 'This buy-in would exceed the table chip capacity.', 'buyIn');
    return this.#mutate({ type: 'seat-participant', participantId, seat, buyIn }, draft => {
      const existing = draft.participants.find(p => p.participantId === participantId);
      if (existing) { existing.seat = seat; existing.stack = buyIn; existing.sittingOut = false; }
      else draft.participants.push({ participantId, seat, stack: buyIn, sittingOut: false });
      draft.bankroll += buyIn;
      return [{ type: 'participant-seated', participantId, seat, buyIn }];
    });
  }
  #mutate(command: CashGameCommand, evaluate: (draft: CashGameState) => CashGameEvent[]): CashGameResult {
    const draft = structuredClone(this.#state);
    const events = evaluate(draft);
    draft.commands.push(structuredClone(command));
    draftFaults.afterEvaluation?.();
    validateState(draft, this.#configuration);
    const result = immutable({ ok: true as const, events });
    this.#state = draft;
    return result;
  }
  forParticipant(_participantId: ParticipantId): ParticipantCashGame {
    return new ParticipantCashGame(() => {
      const c = this.#configuration;
      return immutable({
        configuration: {
          seatCount: c.seatCount, smallBlind: c.smallBlind, bigBlind: c.bigBlind, ante: c.ante,
          minimumBuyIn: c.minimumBuyIn, defaultBuyIn: c.defaultBuyIn, maximumBuyIn: c.maximumBuyIn,
          allowSeatChanges: c.allowSeatChanges,
        },
        state: { status: this.#state.status, buttonSeat: this.#state.buttonSeat, participants: this.#state.participants.map(p => ({ participantId: p.participantId, seat: p.seat, stack: p.stack, sittingOut: p.sittingOut })), board: [], pots: [], actorId: null, legalActions: [] },
        history: [],
      });
    });
  }
}
