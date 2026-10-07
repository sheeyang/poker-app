import type { ConcreteAction, LegalAction, ObservableGameConfiguration, ObservableGameView, ObservablePresentationEvent, ParticipantId } from '@poker/contracts';
import { draftFaults } from './internal/draft-faults.js';
import type { CashGameState, HandState } from './internal/state.js';
import { shuffledDeck } from './internal/random.js';
import { contributionLayers } from './internal/pots.js';
import { revealLiveHands, settleHand } from './internal/settlement.js';
export { createRandomSource, deriveSeed } from './internal/random.js';
export { rankHand, compareHandRanks } from './internal/ranking.js';
export type { HandRank } from './internal/ranking.js';
export type { ObservableGameConfiguration, ObservableGameView, ParticipantId } from '@poker/contracts';
export interface HiddenGameConfiguration { readonly seed: string }
export type GameConfiguration = ObservableGameConfiguration & HiddenGameConfiguration;
export type CashGameCommand =
  | { readonly type: 'seat-participant'; readonly participantId: ParticipantId; readonly seat: number; readonly buyIn: number }
  | { readonly type: 'start-hand' }
  | { readonly type: 'act'; readonly participantId: ParticipantId; readonly action: ConcreteAction };
export type CashGameEvent = ObservablePresentationEvent | { readonly type: 'hole-cards-dealt'; readonly participantId: ParticipantId; readonly cardCount: number; readonly cards: readonly string[] };
export type CashGameResult =
  | { readonly ok: true; readonly events: readonly CashGameEvent[] }
  | { readonly ok: false; readonly rejection: CashGameRejection };
export interface AuthoritativeHandFacts {
  readonly handId: string;
  readonly sequence: number;
  readonly completed: boolean;
  readonly buttonSeat: number;
  readonly smallBlindParticipantId: ParticipantId;
  readonly bigBlindParticipantId: ParticipantId;
  readonly participants: readonly { readonly participantId: ParticipantId; readonly seat: number; readonly holeCards: readonly string[]; readonly contribution: number; readonly wager: number; readonly folded: boolean; readonly allIn: boolean; readonly revealed: boolean }[];
  readonly deck: readonly string[];
  readonly drawnCardCount: number;
  readonly burns: readonly string[];
  readonly board: readonly string[];
  readonly street: HandState['street'];
  readonly actorId: ParticipantId | null;
  readonly decisionId: string | null;
  readonly pots: readonly { readonly amount: number; readonly eligibleParticipantIds: readonly ParticipantId[] }[];
  readonly returns: readonly { readonly participantId: ParticipantId; readonly amount: number }[];
  readonly payouts: readonly { readonly participantId: ParticipantId; readonly amount: number }[];
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
function projectAction(action: ConcreteAction): ConcreteAction {
  if (action.type === 'bet') return { type: 'bet', betTo: action.betTo };
  if (action.type === 'raise') return { type: 'raise', raiseTo: action.raiseTo };
  return { type: action.type };
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
  const current = state.hands.at(-1);
  if (current && !current.completed) for (const p of current.participants) bankroll += BigInt(p.contribution);
  for (const hand of state.hands) {
    if (hand.deck.length !== 52 || new Set(hand.deck).size !== 52) throw new Error('Deck uniqueness invariant failed.');
    const locations = [...hand.participants.flatMap(p => p.holeCards), ...hand.burns, ...hand.board];
    if (new Set(locations).size !== locations.length || locations.length !== hand.drawnCardCount || locations.some(card => !hand.deck.slice(0, hand.drawnCardCount).includes(card))) throw new Error('Card location invariant failed.');
    for (const p of hand.participants) if (![p.contribution, p.wager].every(amount => Number.isSafeInteger(amount) && amount >= 0) || p.wager > p.contribution) throw new Error('Contribution invariant failed.');
  }
  if (bankroll > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Chip capacity invariant failed.');
  if (bankroll !== BigInt(state.bankroll)) throw new Error('Chip conservation invariant failed.');
}
export class ParticipantCashGame {
  constructor(private readonly read: () => ObservableGameView, private readonly project: (events: readonly CashGameEvent[]) => readonly ObservablePresentationEvent[]) {}
  getView(): ObservableGameView { return this.read(); }
  projectEvents(events: readonly CashGameEvent[]): readonly ObservablePresentationEvent[] { return this.project(events); }
}
export class CashGame {
  #configuration: GameConfiguration;
  #state: CashGameState = { status: 'between-hands', buttonSeat: 1, participants: [], hands: [], commands: [], bankroll: 0 };
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
      if (!command || typeof command !== 'object') return invalid();
      let accepted: CashGameResult;
      switch (command.type) {
        case 'seat-participant':
          if (Object.keys(command).sort().join(',') !== 'buyIn,participantId,seat,type' || !Number.isSafeInteger(command.buyIn)) return invalid();
          accepted = result.game.seatParticipant(command.participantId, command.seat, command.buyIn);
          break;
        case 'start-hand':
          if (Object.keys(command).join(',') !== 'type') return invalid();
          accepted = result.game.startHand();
          break;
        case 'act':
          if (Object.keys(command).sort().join(',') !== 'action,participantId,type') return invalid();
          accepted = result.game.act(command.participantId, command.action);
          break;
        default: return invalid();
      }
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
  getHand(handId: string): AuthoritativeHandFacts | undefined {
    const hand = this.#state.hands.find(h => h.handId === handId);
    if (!hand) return undefined;
    return immutable({ handId: hand.handId, sequence: hand.sequence, completed: hand.completed, buttonSeat: hand.buttonSeat, smallBlindParticipantId: hand.smallBlindParticipantId, bigBlindParticipantId: hand.bigBlindParticipantId,
      participants: hand.participants.map(p => ({ participantId: p.participantId, seat: p.seat, holeCards: [...p.holeCards], contribution: p.contribution, wager: p.wager, folded: p.folded, allIn: p.allIn, revealed: p.revealed })),
      deck: [...hand.deck], drawnCardCount: hand.drawnCardCount, burns: [...hand.burns], board: [...hand.board], street: hand.street, actorId: hand.actorId, decisionId: hand.decisionId,
      pots: hand.pots.map(p => ({ amount: p.amount, eligibleParticipantIds: [...p.eligibleParticipantIds] })), returns: hand.returns.map(p => ({ participantId: p.participantId, amount: p.amount })), payouts: hand.payouts.map(p => ({ participantId: p.participantId, amount: p.amount })) });
  }
  startHand(): CashGameResult {
    if (this.#state.status === 'active-hand') return { ok: false, rejection: { code: 'active-hand', message: 'Complete the current Hand before starting another.' } };
    const eligible = this.#state.participants.filter(p => p.seat !== null && !p.sittingOut && p.stack > 0);
    if (eligible.length < 2) return { ok: false, rejection: { code: 'insufficient-participants', message: 'Seat at least two eligible Participants with chips.' } };
    return this.#mutate({ type: 'start-hand' }, draft => {
      const c = this.#configuration;
      const clockwise = (seat: number, start: number) => (seat - start + c.seatCount) % c.seatCount;
      const start = draft.status === 'completed-hand' ? draft.buttonSeat % c.seatCount + 1 : draft.buttonSeat;
      const button = [...eligible].sort((a, b) => clockwise(a.seat!, start) - clockwise(b.seat!, start))[0]!;
      const order = [...eligible].sort((a, b) => clockwise(a.seat!, button.seat! % c.seatCount + 1) - clockwise(b.seat!, button.seat! % c.seatCount + 1));
      const smallBlind = eligible.length === 2 ? button : order[0]!;
      const bigBlind = eligible.length === 2 ? order[0]! : order[1]!;
      const sequence = draft.hands.length + 1;
      const hand: HandState = { handId: 'hand-' + sequence, sequence, completed: false, buttonSeat: button.seat!, smallBlindParticipantId: smallBlind.participantId, bigBlindParticipantId: bigBlind.participantId,
        participants: eligible.map(p => ({ participantId: p.participantId, seat: p.seat!, holeCards: [], contribution: 0, wager: 0, folded: false, allIn: false, revealed: false, actedAtPrice: null })),
        deck: shuffledDeck(c.seed, sequence), drawnCardCount: 0, burns: [], board: [], street: 'preflop', actorId: null, decisionSequence: 0, decisionId: null, price: c.bigBlind, lastFullIncrement: c.bigBlind, pots: [], returns: [], payouts: [], actions: [] };
      draft.hands.push(hand); draft.status = 'active-hand'; draft.buttonSeat = button.seat!;
      const events: CashGameEvent[] = [{ type: 'hand-started', handId: hand.handId, buttonSeat: hand.buttonSeat, smallBlindParticipantId: hand.smallBlindParticipantId, bigBlindParticipantId: hand.bigBlindParticipantId }];
      const contribute = (id: string, requested: number, kind: 'ante' | 'small-blind' | 'big-blind') => {
        const p = draft.participants.find(p => p.participantId === id)!;
        const member = hand.participants.find(p => p.participantId === id)!;
        const amount = Math.min(p.stack, requested);
        p.stack -= amount; member.contribution += amount; if (kind !== 'ante') member.wager += amount;
        member.allIn = p.stack === 0;
        if (amount > 0) events.push({ type: 'forced-contribution', participantId: id, kind, amount });
      };
      for (const p of hand.participants) contribute(p.participantId, c.ante, 'ante');
      contribute(smallBlind.participantId, c.smallBlind, 'small-blind'); contribute(bigBlind.participantId, c.bigBlind, 'big-blind');
      const dealOrder = eligible.length === 2 ? [button, bigBlind] : order;
      for (let pass = 0; pass < 2; pass++) for (const p of dealOrder) hand.participants.find(member => member.participantId === p.participantId)!.holeCards.push(hand.deck[hand.drawnCardCount++]!);
      for (const p of hand.participants) events.push({ type: 'hole-cards-dealt', participantId: p.participantId, cardCount: 2, cards: [...p.holeCards] });
      const firstSeat = eligible.length === 2 ? button.seat! : bigBlind.seat! % c.seatCount + 1;
      hand.actorId = [...hand.participants].sort((a, b) => clockwise(a.seat, firstSeat) - clockwise(b.seat, firstSeat)).find(p => !p.allIn)?.participantId ?? null;
      if (hand.actorId) { hand.decisionSequence = 1; hand.decisionId = hand.handId + '/decision-1'; }
      hand.pots = contributionLayers(hand).pots;
      return events;
    });
  }
  act(participantId: ParticipantId, action: ConcreteAction): CashGameResult {
    const reject = (code: string, message: string): CashGameResult => ({ ok: false, rejection: { code, message } });
    const hand = this.#state.hands.at(-1);
    if (!hand || hand.completed) return reject('no-active-hand', 'Start a Hand before acting.');
    if (hand.actorId !== participantId) return reject('wrong-actor', 'Only the current actor can act.');
    if (!action || typeof action !== 'object' || !['fold', 'check', 'call'].includes(action.type) || Object.keys(action).join(',') !== 'type' || !this.#legalActions(participantId).some(legal => legal.type === action.type)) return reject('illegal-action', 'Choose an action described by the current decision.');
    const concrete = projectAction(action);
    return this.#mutate({ type: 'act', participantId, action: concrete }, draft => {
      const current = draft.hands.at(-1)!;
      const member = current.participants.find(p => p.participantId === participantId)!;
      if (concrete.type === 'fold') member.folded = true;
      else if (concrete.type === 'call') {
        const participant = draft.participants.find(p => p.participantId === participantId)!;
        const amount = Math.min(current.price - member.wager, participant.stack);
        participant.stack -= amount; member.wager += amount; member.contribution += amount;
        member.allIn = participant.stack === 0;
      }
      member.actedAtPrice = current.price;
      current.actions.push({ participantId, action: concrete });
      const events: CashGameEvent[] = [{ type: 'acted', participantId, action: concrete }];
      const live = current.participants.filter(p => !p.folded);
      current.pots = contributionLayers(current).pots;
      if (live.length === 1) {
        settleHand(draft, current, events, this.#configuration.seatCount);
      } else {
        this.#continueBetting(draft, current, member.seat, events);
      }
      return events;
    });
  }
  #continueBetting(draft: CashGameState, hand: HandState, afterSeat: number, events: CashGameEvent[]): void {
    const seatCount = this.#configuration.seatCount;
    const able = hand.participants.filter(p => !p.folded && !p.allIn);
    const awaiting = able.filter(p => p.wager < hand.price || (able.length > 1 && p.actedAtPrice === null));
    if (awaiting.length > 0) {
      hand.actorId = awaiting.sort((a, b) => ((a.seat - afterSeat - 1 + seatCount) % seatCount) - ((b.seat - afterSeat - 1 + seatCount) % seatCount))[0]!.participantId;
      hand.decisionId = hand.handId + '/decision-' + ++hand.decisionSequence;
      return;
    }
    if (able.length < 2) revealLiveHands(hand, events);
    if (hand.street === 'river') { settleHand(draft, hand, events, seatCount); return; }
    hand.street = hand.street === 'preflop' ? 'flop' : hand.street === 'flop' ? 'turn' : 'river';
    hand.price = 0; hand.lastFullIncrement = this.#configuration.bigBlind;
    for (const p of hand.participants) { p.wager = 0; p.actedAtPrice = null; }
    hand.burns.push(hand.deck[hand.drawnCardCount++]!);
    events.push({ type: 'card-burned', street: hand.street });
    const cards = Array.from({ length: hand.street === 'flop' ? 3 : 1 }, () => hand.deck[hand.drawnCardCount++]!);
    hand.board.push(...cards);
    events.push({ type: 'board-dealt', street: hand.street, cards });
    this.#continueBetting(draft, hand, hand.buttonSeat, events);
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
  forParticipant(participantId: ParticipantId): ParticipantCashGame {
    return new ParticipantCashGame(() => {
      const c = this.#configuration;
      const hand = this.#state.hands.at(-1);
      return immutable({
        configuration: {
          seatCount: c.seatCount, smallBlind: c.smallBlind, bigBlind: c.bigBlind, ante: c.ante,
          minimumBuyIn: c.minimumBuyIn, defaultBuyIn: c.defaultBuyIn, maximumBuyIn: c.maximumBuyIn,
          allowSeatChanges: c.allowSeatChanges,
        },
        state: { status: this.#state.status, buttonSeat: this.#state.buttonSeat, participants: this.#state.participants.map(p => {
          const member = hand?.participants.find(member => member.participantId === p.participantId);
          return { participantId: p.participantId, seat: p.seat, stack: p.stack, sittingOut: p.sittingOut, ...(member ? { inHand: true, handSeat: member.seat, folded: member.folded, allIn: member.allIn, contribution: member.contribution, wager: member.wager, cardCount: member.holeCards.length, ...(p.participantId === participantId || member.revealed ? { holeCards: [...member.holeCards] } : {}) } : {}) };
        }), board: hand ? [...hand.board] : [], pots: hand ? hand.pots.map(p => ({ amount: p.amount, eligibleParticipantIds: [...p.eligibleParticipantIds] })) : [], actorId: hand?.actorId ?? null, legalActions: this.#legalActions(participantId),
          ...(hand ? { handId: hand.handId, decisionId: hand.decisionId, street: hand.street, smallBlindParticipantId: hand.smallBlindParticipantId, bigBlindParticipantId: hand.bigBlindParticipantId, returns: hand.returns.map(p => ({ participantId: p.participantId, amount: p.amount })), payouts: hand.payouts.map(p => ({ participantId: p.participantId, amount: p.amount })) } : {}) },
        history: [],
      });
    }, events => immutable(events.map(event => {
      switch (event.type) {
        case 'participant-seated': return { type: event.type, participantId: event.participantId, seat: event.seat, buyIn: event.buyIn };
        case 'hand-started': return { type: event.type, handId: event.handId, buttonSeat: event.buttonSeat, smallBlindParticipantId: event.smallBlindParticipantId, bigBlindParticipantId: event.bigBlindParticipantId };
        case 'forced-contribution': return { type: event.type, participantId: event.participantId, kind: event.kind, amount: event.amount };
        case 'hole-cards-dealt': return { type: event.type, participantId: event.participantId, cardCount: event.cardCount, ...(event.participantId === participantId && event.cards ? { cards: [...event.cards] } : {}) };
        case 'acted': return { type: event.type, participantId: event.participantId, action: projectAction(event.action) };
        case 'card-burned': return { type: event.type, street: event.street };
        case 'board-dealt': return { type: event.type, street: event.street, cards: [...event.cards] };
        case 'hole-cards-revealed': return { type: event.type, participantId: event.participantId, cards: [...event.cards] };
        case 'uncalled-return': case 'pot-awarded': return { type: event.type, participantId: event.participantId, amount: event.amount };
        case 'hand-completed': return { type: event.type, handId: event.handId };
      }
    })));
  }
  #legalActions(participantId: ParticipantId): LegalAction[] {
    const hand = this.#state.hands.at(-1);
    if (!hand || hand.completed || hand.actorId !== participantId) return [];
    const member = hand.participants.find(p => p.participantId === participantId)!;
    return [{ type: 'fold' }, { type: member.wager < hand.price ? 'call' : 'check' }];
  }
}
