import type { ConcreteAction, LegalAction, ObservableGameConfiguration, ObservableGameView, ObservablePresentationEvent, ParticipantId } from '@poker/contracts';
import { draftFaults } from './internal/draft-faults.js';
import type { CashGameState, HandState } from './internal/state.js';
import { shuffledDeck } from './internal/random.js';
import { contributionLayers } from './internal/pots.js';
export { createRandomSource, deriveSeed } from './internal/random.js';
export type { ObservableGameConfiguration, ObservableGameView, ParticipantId } from '@poker/contracts';
export interface HiddenGameConfiguration { readonly seed: string }
export type GameConfiguration = ObservableGameConfiguration & HiddenGameConfiguration;
export type CashGameCommand =
  | { readonly type: 'seat-participant'; readonly participantId: ParticipantId; readonly seat: number; readonly buyIn: number }
  | { readonly type: 'leave-participant'; readonly participantId: ParticipantId }
  | { readonly type: 'move-participant'; readonly participantId: ParticipantId; readonly seat: number }
  | { readonly type: 'set-sitting-out'; readonly participantId: ParticipantId; readonly sittingOut: boolean }
  | { readonly type: 'top-up-to'; readonly participantId: ParticipantId; readonly targetStack: number }
  | { readonly type: 'set-button'; readonly seat: number }
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
  #state: CashGameState = { status: 'between-hands', buttonSeat: 1, nextButtonSeat: null, participants: [], hands: [], commands: [], bankroll: 0 };
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
        case 'leave-participant':
          if (Object.keys(command).sort().join(',') !== 'participantId,type') return invalid();
          accepted = result.game.leaveParticipant(command.participantId);
          break;
        case 'move-participant':
          if (Object.keys(command).sort().join(',') !== 'participantId,seat,type') return invalid();
          accepted = result.game.moveParticipant(command.participantId, command.seat);
          break;
        case 'set-sitting-out':
          if (Object.keys(command).sort().join(',') !== 'participantId,sittingOut,type') return invalid();
          accepted = result.game.setSittingOut(command.participantId, command.sittingOut);
          break;
        case 'top-up-to':
          if (Object.keys(command).sort().join(',') !== 'participantId,targetStack,type') return invalid();
          accepted = result.game.topUpTo(command.participantId, command.targetStack);
          break;
        case 'set-button':
          if (Object.keys(command).sort().join(',') !== 'seat,type') return invalid();
          accepted = result.game.setButton(command.seat);
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
      const start = draft.nextButtonSeat ?? (draft.status === 'completed-hand' ? draft.hands.at(-1)!.buttonSeat % c.seatCount + 1 : draft.buttonSeat);
      const button = [...eligible].sort((a, b) => clockwise(a.seat!, start) - clockwise(b.seat!, start))[0]!;
      const order = [...eligible].sort((a, b) => clockwise(a.seat!, button.seat! % c.seatCount + 1) - clockwise(b.seat!, button.seat! % c.seatCount + 1));
      const smallBlind = eligible.length === 2 ? button : order[0]!;
      const bigBlind = eligible.length === 2 ? order[0]! : order[1]!;
      const sequence = draft.hands.length + 1;
      const hand: HandState = { handId: 'hand-' + sequence, sequence, completed: false, buttonSeat: button.seat!, smallBlindParticipantId: smallBlind.participantId, bigBlindParticipantId: bigBlind.participantId,
        observerParticipantIds: draft.participants.filter(p => p.seat !== null).map(p => p.participantId),
        participants: eligible.map(p => ({ participantId: p.participantId, seat: p.seat!, holeCards: [], contribution: 0, wager: 0, folded: false, allIn: false, revealed: false })),
        deck: shuffledDeck(c.seed, sequence), drawnCardCount: 0, burns: [], board: [], street: 'preflop', actorId: null, decisionSequence: 0, decisionId: null, price: c.bigBlind, lastFullIncrement: c.bigBlind, pots: [], returns: [], payouts: [], actions: [] };
      draft.hands.push(hand); draft.status = 'active-hand'; draft.buttonSeat = button.seat!; draft.nextButtonSeat = null;
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
    if (!action || typeof action !== 'object' || action.type !== 'fold' || Object.keys(action).join(',') !== 'type' || !this.#legalActions(participantId).some(legal => legal.type === action.type)) return reject('illegal-action', 'Choose an action described by the current decision.');
    return this.#mutate({ type: 'act', participantId, action: { type: 'fold' } }, draft => {
      const current = draft.hands.at(-1)!;
      const member = current.participants.find(p => p.participantId === participantId)!;
      member.folded = true;
      current.actions.push({ participantId, action: { type: 'fold' } });
      const events: CashGameEvent[] = [{ type: 'acted', participantId, action: { type: 'fold' } }];
      const live = current.participants.filter(p => !p.folded);
      const layers = contributionLayers(current);
      current.pots = layers.pots;
      if (live.length === 1) {
        current.returns = layers.returns;
        for (const transfer of current.returns) {
          draft.participants.find(p => p.participantId === transfer.participantId)!.stack += transfer.amount;
          events.push({ type: 'uncalled-return', participantId: transfer.participantId, amount: transfer.amount });
        }
        for (const pot of current.pots) {
          const winner = live[0]!;
          if (!pot.eligibleParticipantIds.includes(winner.participantId)) throw new Error('A matched pot has no eligible live hand.');
          draft.participants.find(p => p.participantId === winner.participantId)!.stack += pot.amount;
          current.payouts.push({ participantId: winner.participantId, amount: pot.amount });
          events.push({ type: 'pot-awarded', participantId: winner.participantId, amount: pot.amount });
        }
        current.completed = true; current.actorId = null; current.decisionId = null;
        draft.status = 'completed-hand';
        events.push({ type: 'hand-completed', handId: current.handId });
      } else {
        const seatCount = this.#configuration.seatCount;
        current.actorId = live.filter(p => !p.allIn).sort((a, b) => ((a.seat - member.seat - 1 + seatCount) % seatCount) - ((b.seat - member.seat - 1 + seatCount) % seatCount))[0]?.participantId ?? null;
        current.decisionId = current.actorId ? current.handId + '/decision-' + ++current.decisionSequence : null;
      }
      return events;
    });
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
  setButton(seat: number): CashGameResult {
    if (this.#state.status === 'active-hand') return { ok: false, rejection: { code: 'active-hand', message: 'Choose the next button between Hands.' } };
    if (!Number.isInteger(seat) || seat < 1 || seat > this.#configuration.seatCount) return { ok: false, rejection: { code: 'invalid-seat', message: 'Choose a valid seat in this table.', field: 'seat' } };
    if (!this.#state.participants.some(p => p.seat === seat && !p.sittingOut && p.stack > 0)) return { ok: false, rejection: { code: 'ineligible-button', message: 'Choose an occupied seat whose Participant is playing and has chips.', field: 'seat' } };
    return this.#mutate({ type: 'set-button', seat }, draft => {
      draft.nextButtonSeat = seat; draft.buttonSeat = seat;
      return [{ type: 'button-set', seat }];
    });
  }
  moveParticipant(participantId: ParticipantId, seat: number): CashGameResult {
    const rejected = this.#managementRejection(participantId);
    if (rejected) return rejected;
    if (!this.#configuration.allowSeatChanges) return { ok: false, rejection: { code: 'seat-changes-disabled', message: 'Seat changes are disabled for this Table Session.' } };
    if (!Number.isInteger(seat) || seat < 1 || seat > this.#configuration.seatCount) return { ok: false, rejection: { code: 'invalid-seat', message: 'Choose a valid seat in this table.', field: 'seat' } };
    if (this.#state.participants.some(p => p.seat === seat)) return { ok: false, rejection: { code: 'seat-occupied', message: 'Choose an empty seat.', field: 'seat' } };
    return this.#mutate({ type: 'move-participant', participantId, seat }, draft => {
      const participant = draft.participants.find(p => p.participantId === participantId)!;
      const fromSeat = participant.seat!;
      participant.seat = seat;
      return [{ type: 'participant-moved', participantId, fromSeat, seat }];
    });
  }
  setSittingOut(participantId: ParticipantId, sittingOut: boolean): CashGameResult {
    const rejected = this.#managementRejection(participantId);
    if (rejected) return rejected;
    if (typeof sittingOut !== 'boolean') return { ok: false, rejection: { code: 'invalid-sitting-out', message: 'Choose whether this Participant is sitting out.', field: 'sittingOut' } };
    if (this.#state.participants.find(p => p.participantId === participantId)!.sittingOut === sittingOut) return { ok: false, rejection: { code: 'sitting-out-unchanged', message: 'This Participant already has the requested sitting-out status.' } };
    return this.#mutate({ type: 'set-sitting-out', participantId, sittingOut }, draft => {
      draft.participants.find(p => p.participantId === participantId)!.sittingOut = sittingOut;
      return [{ type: 'sitting-out-changed', participantId, sittingOut }];
    });
  }
  topUpTo(participantId: ParticipantId, targetStack: number): CashGameResult {
    const rejected = this.#managementRejection(participantId);
    if (rejected) return rejected;
    const participant = this.#state.participants.find(p => p.participantId === participantId)!;
    if (!Number.isSafeInteger(targetStack) || targetStack <= participant.stack || targetStack > this.#configuration.maximumBuyIn || (participant.stack === 0 && targetStack < this.#configuration.minimumBuyIn))
      return { ok: false, rejection: { code: 'invalid-top-up', message: 'Choose an integer target above the current stack, within the maximum buy-in. A zero-stack rebuy must reach the minimum buy-in.', field: 'targetStack' } };
    const amount = targetStack - participant.stack;
    if (BigInt(this.#state.bankroll) + BigInt(amount) > BigInt(Number.MAX_SAFE_INTEGER)) return { ok: false, rejection: { code: 'chip-capacity-exceeded', message: 'This top-up would exceed the table chip capacity.', field: 'targetStack' } };
    return this.#mutate({ type: 'top-up-to', participantId, targetStack }, draft => {
      draft.participants.find(p => p.participantId === participantId)!.stack = targetStack;
      draft.bankroll += amount;
      return [{ type: 'participant-topped-up', participantId, targetStack, amount }];
    });
  }
  leaveParticipant(participantId: ParticipantId): CashGameResult {
    const rejected = this.#managementRejection(participantId);
    if (rejected) return rejected;
    return this.#mutate({ type: 'leave-participant', participantId }, draft => {
      const participant = draft.participants.find(p => p.participantId === participantId)!;
      const seat = participant.seat!;
      const cashOut = participant.stack;
      participant.seat = null; participant.stack = 0; participant.sittingOut = false;
      draft.bankroll -= cashOut;
      return [{ type: 'participant-left', participantId, seat, cashOut }];
    });
  }
  #managementRejection(participantId: ParticipantId): CashGameResult | undefined {
    if (this.#state.status === 'active-hand') return { ok: false, rejection: { code: 'active-hand', message: 'Manage Participants between Hands.' } };
    if (!this.#state.participants.some(p => p.participantId === participantId && p.seat !== null)) return { ok: false, rejection: { code: 'participant-not-seated', message: 'Choose a seated Participant.', field: 'participantId' } };
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
        history: this.#state.hands.filter(h => h.completed && h.observerParticipantIds.includes(participantId)).map(h => ({ handId: h.handId, description: 'Completed Hand ' + h.sequence })),
      });
    }, events => immutable(events.map(event => {
      switch (event.type) {
        case 'participant-seated': return { type: event.type, participantId: event.participantId, seat: event.seat, buyIn: event.buyIn };
        case 'participant-left': return { type: event.type, participantId: event.participantId, seat: event.seat, cashOut: event.cashOut };
        case 'participant-moved': return { type: event.type, participantId: event.participantId, fromSeat: event.fromSeat, seat: event.seat };
        case 'sitting-out-changed': return { type: event.type, participantId: event.participantId, sittingOut: event.sittingOut };
        case 'participant-topped-up': return { type: event.type, participantId: event.participantId, targetStack: event.targetStack, amount: event.amount };
        case 'button-set': return { type: event.type, seat: event.seat };
        case 'hand-started': return { type: event.type, handId: event.handId, buttonSeat: event.buttonSeat, smallBlindParticipantId: event.smallBlindParticipantId, bigBlindParticipantId: event.bigBlindParticipantId };
        case 'forced-contribution': return { type: event.type, participantId: event.participantId, kind: event.kind, amount: event.amount };
        case 'hole-cards-dealt': return { type: event.type, participantId: event.participantId, cardCount: event.cardCount, ...(event.participantId === participantId && event.cards ? { cards: [...event.cards] } : {}) };
        case 'acted': return { type: event.type, participantId: event.participantId, action: projectAction(event.action) };
        case 'uncalled-return': case 'pot-awarded': return { type: event.type, participantId: event.participantId, amount: event.amount };
        case 'hand-completed': return { type: event.type, handId: event.handId };
      }
    })));
  }
  #legalActions(participantId: ParticipantId): LegalAction[] {
    const hand = this.#state.hands.at(-1);
    return hand && !hand.completed && hand.actorId === participantId ? [{ type: 'fold' }] : [];
  }
}
