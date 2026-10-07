import type { ObservableGameConfiguration, ObservableGameView, ParticipantId } from '@poker/contracts';
export type { ObservableGameConfiguration, ObservableGameView, ParticipantId } from '@poker/contracts';
export interface HiddenGameConfiguration { readonly seed: string }
export type GameConfiguration = ObservableGameConfiguration & HiddenGameConfiguration;
export type CashGameCommand = never;
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
export class ParticipantCashGame {
  constructor(private readonly read: () => ObservableGameView) {}
  getView(): ObservableGameView { return this.read(); }
}
export class CashGame {
  #configuration: GameConfiguration;
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
    if (r.schemaVersion !== 1 || r.engineVersion !== 'v1' || !Array.isArray(r.commands) || r.commands.length !== 0 || !r.configuration)
      return invalid();
    const result = CashGame.create(r.configuration);
    return result.ok ? result : invalid();
  }
  fork(): CashGame { return new CashGame(this.#configuration); }
  toRecord(): TableSessionRecord {
    return immutable({ schemaVersion: 1, engineVersion: 'v1', configuration: structuredClone(this.#configuration), commands: [] });
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
        state: { status: 'between-hands', buttonSeat: 1, participants: [], board: [], pots: [], actorId: null, legalActions: [] },
        history: [],
      });
    });
  }
}
