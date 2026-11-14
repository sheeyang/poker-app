import { describeBeats, evaluateBeats, type BeatDef, type BeatDescription, type PlacedBeat } from './anchored-beats.js';
import { committedTimings, type Timings } from './timings.js';
import { payoutDefs, showdownDefs, streetDefs, sweepDefs } from './presenting-beats.js';
import type { ChipAmount, ParticipantId, PresentationPhaseKind, PresentingPhaseKind, TableMode } from './index.js';

/**
 * Presentation timing, shared by the server and the Trainer (ADR-0039). The server schedules Presentation Phases and
 * the Next-Hand Countdown from it; the Trainer times the table's motion from it. Every value is in milliseconds.
 * Overlays (menus, dialogs, notices, the analysis panel) are not table events and keep their own timings in the web app.
 *
 * Every timing lives in `timings.json` (ADR-0040); the beat functions take a `Timings` and default to the committed ones.
 * Motion offsets are from the moment the motion presents: a phase's start, or the view that carried it.
 */

/**
 * A Presentation Phase's Phase Inputs, by kind, for each kind whose length comes from its beats: what it presents. The
 * phase carries them as `inputs`. They hold only what the view already makes public, so every viewer computes the
 * same beats.
 */
export interface PhaseInputs {
  readonly deal: DealInputs;
  readonly street: StreetInputs;
  readonly showdown: ShowdownInputs;
  readonly payout: PayoutInputs;
}

/** A phase's kind and what it presents: all the server needs for its length, and a Trainer for its beats. */
export type PresentedPhase = { readonly [K in PresentationPhaseKind]: { readonly kind: K } & (K extends keyof PhaseInputs ? { readonly inputs: PhaseInputs[K] } : unknown) }[PresentationPhaseKind];
/** A presenting phase's kind and its Phase Inputs. */
export type PresentingPhase<K extends PresentingPhaseKind = PresentingPhaseKind> = { readonly [P in K]: { readonly kind: P; readonly inputs: PhaseInputs[P] } }[K];

/** A presenting phase of `kind` that presents `inputs`. */
export const presentingPhase = <K extends PresentingPhaseKind>(kind: K, inputs: PhaseInputs[K]): PresentingPhase => ({ kind, inputs }) as PresentingPhase;

/** How long a presenting Presentation Phase lasts: the total of its beats for its Phase Inputs. */
export const presentationPhaseLength = (phase: PresentingPhase): number => beatsOf(phase.kind, phase.inputs).totalMs;

/**
 * The Phase Inputs of a phase of `kind`, read field by field from `value`: nothing a field added elsewhere carries, and
 * `undefined` when `value` is not Phase Inputs of that kind (as from a server of another version, during a deploy).
 */
export const readPhaseInputs = <K extends PresentingPhaseKind>(kind: K, value: unknown): PhaseInputs[K] | undefined => byKind[kind].read(value);

/** Something that moves, from `startsAt` until `endsAt`, in milliseconds from its phase's start. */
export interface Beat { readonly startsAt: number; readonly endsAt: number }

/** What every beat function returns: the phase's beats and their total, the phase's length. No beat ends after it. */
export interface PhaseBeats { readonly totalMs: number }

/**
 * A phase's beat function, from its choreography: `plan(inputs, at)` lays out every beat, passing each offset through
 * `at`. Given the phase's own length, the beats are scaled to fit it exactly, since the phase is authoritative (a
 * Trainer and the server may briefly disagree during a deploy); without one, they keep their natural timing.
 */
function beatFunction<I, B extends PhaseBeats>(plan: (inputs: I, at: (ms: number) => number, timings: Timings) => B): (inputs: I, durationMs?: number, timings?: Timings) => B {
  return (inputs, durationMs, timings = committedTimings) => {
    const natural = plan(inputs, ms => ms, timings);
    if (durationMs === undefined || durationMs === natural.totalMs || natural.totalMs <= 0) return natural;
    const scale = durationMs / natural.totalMs;
    return { ...plan(inputs, ms => ms * scale, timings), totalMs: durationMs };
  };
}

/** The length of the Settle after each presenting phase, by the phase it follows; after the payout, by table mode too. */
export interface SettleLengths {
  readonly deal: number;
  readonly street: number;
  readonly showdown: number;
  readonly payout: Readonly<Record<TableMode, number>>;
}

/**
 * The Settle lengths: a moment to take in the deal or a street before acting; after the showdown, the time to read the
 * turned hands before the pot is pushed (the showdown's own beats end once the last hand is face up); and a moment to
 * see the result before the next Hand can start. Each may be 0: a Settle of 0 is not scheduled, and what follows
 * starts when the phase before it ends.
 */
export const settleLengths: SettleLengths = committedTimings.settle;

/** The length of the Settle after a phase of `kind` at a table of `mode`. */
export const settleAfter = (kind: PresentingPhaseKind, mode: TableMode, lengths: SettleLengths = settleLengths): number => kind === 'payout' ? lengths.payout[mode] : lengths[kind];

/** How long an Online Table's Next-Hand Countdown runs, from its announcement to the next Hand. */
export const nextHandCountdownMs = committedTimings.nextHandCountdownMs;

/** Seats in the order the engine deals them: clockwise from left of the button, or heads-up the button first. */
export function dealingOrder<S extends { readonly seat: number }>(seats: readonly S[], buttonSeat: number): S[] {
  const pastButton = (seat: number) => (seat > buttonSeat ? 0 : 1);
  const clockwise = [...seats].sort((a, b) => pastButton(a.seat) - pastButton(b.seat) || a.seat - b.seat);
  return seats.length === 2 ? clockwise.reverse() : clockwise;
}

/**
 * The betting line swept into the pot: each swept wager's chip flies to the pot, one after another, its amount fading as
 * it leaves (`amountFades`), and the pot brightens once the chips reach it (absent with nothing swept).
 */
export interface SweepBeats {
  readonly wagers: readonly (Beat & { readonly participantId: ParticipantId; readonly amountFades: Beat })[];
  readonly pot?: Beat;
}

/** A placed beat, scaled by `at`. */
const scaleBeat = (at: (ms: number) => number, { startsAt, endsAt }: PlacedBeat): Beat => ({ startsAt: at(startsAt), endsAt: at(endsAt) });

/** The counts a sweep of `swept` reads. */
const sweepCounts = (swept: readonly ParticipantId[]) => ({ swept: swept.length, sweptAny: Math.min(1, swept.length) });

/** The sweep's beats and when its last chip reaches the pot (`lands`, 0 with nothing swept), from its placed beats. */
function sweepOf(placed: Record<'sweepWager' | 'sweepAmountFade' | 'sweepPot', PlacedBeat[]>, swept: readonly ParticipantId[], at: (ms: number) => number): { readonly beats: SweepBeats; readonly lands: number } {
  const wagers = swept.map((participantId, n) => ({ participantId, ...scaleBeat(at, placed.sweepWager[n]!), amountFades: scaleBeat(at, placed.sweepAmountFade[n]!) }));
  const pot = placed.sweepPot[0];
  return { beats: pot ? { wagers, pot: scaleBeat(at, pot) } : { wagers }, lands: placed.sweepWager.at(-1)?.endsAt ?? 0 };
}

/** When a sweep's last beat ends, 0 with nothing swept. */
const sweepEndsAt = ({ wagers, pot }: SweepBeats): number => Math.max(pot?.endsAt ?? 0, ...wagers.flatMap(w => [w.endsAt, w.amountFades.endsAt]));

/**
 * The line swept with no Presentation Phase to present it (a Hand won by folds): the same beats a street reveal or a
 * showdown plays first, from the view that carried it.
 */
export const sweepBeats = (swept: readonly ParticipantId[], timings: Timings = committedTimings): SweepBeats => sweepOf(evaluateBeats(sweepDefs, sweepCounts(swept), timings), swept, ms => ms).beats;

/**
 * The deal: the last Hand's cards back to the deck, the button on, any refill and the blinds in, and the cards out in
 * dealing order. The deal phase lasts as long as these beats (`dealBeats`).
 */

/** What the deal presents. Every field is public in the view: who holds cards, the blinds' wagers, and stacks. */
export interface DealInputs {
  /** Who is dealt in, in the order the engine deals (`dealingOrder`), and how many cards each (`cardCount`). */
  readonly dealt: readonly { readonly participantId: ParticipantId; readonly cardCount: number }[];
  /** The blinds, in the order they go in. */
  readonly blinds: readonly ParticipantId[];
  /** Who was refilled with the deal from an empty stack (Practice's Rebuy & deal), and by how much. */
  readonly refills: readonly { readonly participantId: ParticipantId; readonly amount: ChipAmount }[];
}

export interface DealBeats extends PhaseBeats {
  /**
   * The last Hand's cards flying back to the deck: however many a Trainer shows, every one sets off and lands within
   * this beat, each `flight` long and the next up to `stagger` later (`returnBeat`). Their count is no Phase Input:
   * only the cards a viewer saw can return.
   */
  readonly cardsReturn: Beat & { readonly flight: number; readonly stagger: number };
  readonly buttonMoves: Beat;
  /** Each refill's chips (`amount`) flying in, landing before the blinds go in. */
  readonly refills: readonly (Beat & { readonly participantId: ParticipantId; readonly amount: ChipAmount })[];
  /** Each blind's chip flying to the betting line; its amount appears at `appearsAt`. */
  readonly blinds: readonly (Beat & { readonly participantId: ParticipantId; readonly appearsAt: number })[];
  /**
   * Each card, in the order dealt: it leaves the deck at `startsAt` and lands at `endsAt`, appearing in place at
   * `appearsAt`; for its own Participant it then turns face up (`turn`).
   */
  readonly cards: readonly (Beat & { readonly participantId: ParticipantId; readonly card: number; readonly appearsAt: number; readonly turn: Beat })[];
}

/** The `n`th of `count` returning cards' flight back to the deck: within the deal's `cardsReturn`, so within the deal. */
export function returnBeat(cardsReturn: DealBeats['cardsReturn'], n: number, count: number): Beat {
  const room = cardsReturn.endsAt - cardsReturn.startsAt - cardsReturn.flight;
  const gap = count > 1 ? Math.min(cardsReturn.stagger, room / (count - 1)) : 0, startsAt = cardsReturn.startsAt + Math.min(n, count - 1) * gap;
  return { startsAt, endsAt: startsAt + cardsReturn.flight };
}

/**
 * The deal's beats as data (ADR-0040): each an anchor, a gap and a length over the deal's timings. Cards go one at a
 * time to each Participant in dealing order, then round again: the more there are, the closer together. The cards
 * leave once the blinds start; a refill lands before the blinds go in.
 */
const dealDefs = [
  { beat: 'cardsReturn', each: 'once', follows: { to: 'phase' }, gap: [], length: [{ timing: 'deal.returnRoom' }, { timing: 'deal.returnFlight' }] },
  { beat: 'buttonMoves', each: 'once', follows: { to: 'phase' }, gap: [], length: [{ timing: 'deal.buttonMoves' }] },
  { beat: 'refill', each: 'refills', follows: { to: 'phase' }, gap: [], length: [{ timing: 'deal.refillLands' }] },
  { beat: 'blind', each: 'blinds', follows: { to: 'end', of: 'refill', instance: 'last' }, gap: [{ timing: 'deal.blindsAfterRefill', times: 'refilled' }, { timing: 'deal.blindStagger', times: 'index' }], length: [{ timing: 'deal.blindFlight' }] },
  { beat: 'blindAppears', each: 'blinds', follows: { to: 'end', of: 'blind', instance: 'same' }, gap: [{ timing: 'deal.blindAppearsBefore', times: -1 }], length: [] },
  { beat: 'card', each: 'cards', follows: { to: 'start', of: 'blind', instance: 'first' }, gap: [{ timing: 'deal.cardsAfterBlinds' }, { spacing: 'deal.cardGap', room: 'deal.cardsRoom', over: 'cards', times: 'index', whole: true }], length: [{ timing: 'deal.cardFlight' }] },
  { beat: 'cardAppears', each: 'cards', follows: { to: 'end', of: 'card', instance: 'same' }, gap: [{ timing: 'deal.cardAppearsBefore', times: -1 }], length: [] },
  { beat: 'cardTurn', each: 'cards', follows: { to: 'end', of: 'card', instance: 'same' }, gap: [{ timing: 'deal.turnAfterLanding' }], length: [{ timing: 'deal.turn' }] },
] as const satisfies readonly BeatDef[];

/** What each deal beat follows, its gap and length formulas, and the timings that directly set it: the deal's description. */
export const dealBeatDescription: readonly BeatDescription[] = describeBeats(dealDefs);

/**
 * The deal's beats, from the phase's start, given what it presents; with `durationMs`, fitted to that length. Cards go
 * one at a time to each Participant in dealing order, then round again: the more there are, the closer together.
 */
export const dealBeats = beatFunction((inputs: DealInputs, at, timings): DealBeats => {
  const rounds = Math.max(0, ...inputs.dealt.map(s => s.cardCount));
  const dealt: { participantId: ParticipantId; card: number }[] = [];
  for (let card = 0; card < rounds; card++) for (const { participantId, cardCount: held } of inputs.dealt) if (card < held) dealt.push({ participantId, card });
  const placed = evaluateBeats(dealDefs, { refills: inputs.refills.length, refilled: Math.min(1, inputs.refills.length), blinds: inputs.blinds.length, cards: dealt.length }, timings);
  const scaled = ({ startsAt, endsAt }: PlacedBeat): Beat => ({ startsAt: at(startsAt), endsAt: at(endsAt) });
  const refills = inputs.refills.map(({ participantId, amount }, n) => ({ participantId, amount, ...scaled(placed.refill[n]!) }));
  const blinds = inputs.blinds.map((participantId, n) => ({ participantId, ...scaled(placed.blind[n]!), appearsAt: at(placed.blindAppears[n]!.endsAt) }));
  const cards = dealt.map(({ participantId, card }, n) => ({ participantId, card, ...scaled(placed.card[n]!), appearsAt: at(placed.cardAppears[n]!.endsAt), turn: scaled(placed.cardTurn[n]!) }));
  const cardsReturn = { ...scaled(placed.cardsReturn[0]!), flight: at(timings.deal.returnFlight) - at(0), stagger: at(timings.deal.returnStagger) - at(0) };
  const buttonMoves = scaled(placed.buttonMoves[0]!);
  const totalMs = Math.max(cardsReturn.endsAt, buttonMoves.endsAt, ...refills.map(b => b.endsAt), ...blinds.map(b => b.endsAt), ...cards.map(c => c.turn.endsAt));
  return { totalMs, cardsReturn, buttonMoves, refills, blinds, cards };
});

/**
 * A street reveal: the line swept, the burn once the last swept chip reaches the pot, then the board cards: the flop
 * leaves the deck as one stack and spreads, the turn and the river one card each, and each card turns face up once it
 * lands. The street reveal lasts as long as these beats (`streetBeats`).
 */

/** What a street reveal presents. Every field is public in the view: whose wagers left the line, and the board. */
export interface StreetInputs {
  /** Whose wagers the street reveal sweeps into the pot, in seat order: none for a runout's later streets. */
  readonly swept: readonly ParticipantId[];
  /** How many board cards it reveals: 3 for the flop, 1 for the turn and the river. */
  readonly cardCount: number;
}

export interface StreetBeats extends PhaseBeats {
  readonly sweep: SweepBeats;
  /** The burn card's flight to the burn pile; it appears there at `appearsAt`. */
  readonly burn: Beat & { readonly appearsAt: number };
  /**
   * Each board card the street reveals (`card` counts from the street's first): it leaves the deck at `startsAt` and
   * lands at `endsAt`, appearing in place at `appearsAt`; a flop card then spreads to its place (`spread`); it turns
   * face up (`turn`).
   */
  readonly cards: readonly (Beat & { readonly card: number; readonly appearsAt: number; readonly spread?: Beat; readonly turn: Beat })[];
}

/** A street reveal's beats, from the phase's start, given what it presents; with `durationMs`, fitted to that length. */
export const streetBeats = beatFunction((inputs: StreetInputs, at, timings): StreetBeats => {
  const flop = inputs.cardCount > 1;
  const placed = evaluateBeats(streetDefs, { ...sweepCounts(inputs.swept), flopCards: flop ? inputs.cardCount : 0, singleCards: inputs.cardCount === 1 ? 1 : 0 }, timings);
  const sweep = sweepOf(placed, inputs.swept, at), burnBeat = placed.burn[0]!;
  const burn = { ...scaleBeat(at, burnBeat), appearsAt: at(placed.burnAppears[0]!.endsAt) };
  const cards = Array.from({ length: inputs.cardCount }, (_, card) => {
    if (!flop) return { card, ...scaleBeat(at, placed.boardCard[0]!), appearsAt: at(placed.boardCardAppears[0]!.endsAt), turn: scaleBeat(at, placed.boardCardTurn[0]!) };
    return { card, ...scaleBeat(at, placed.flopCard[card]!), appearsAt: at(placed.flopCardAppears[card]!.endsAt), spread: scaleBeat(at, placed.flopSpread[card]!), turn: scaleBeat(at, placed.flopCardTurn[card]!) };
  });
  const totalMs = Math.max(burn.endsAt, sweepEndsAt(sweep.beats), ...cards.flatMap(c => [c.turn.endsAt, ('spread' in c ? c.spread.endsAt : 0)]));
  return { totalMs, sweep: sweep.beats, burn, cards };
});

/**
 * The showdown: the line swept, then each hand turned up in turn, card by card, once the last swept chip reaches the
 * pot. The showdown lasts as long as these beats (`showdownBeats`); the time to read the hands is the Settle after it.
 */

/** What the showdown presents. Every field is public in the view: whose wagers left the line, and whose hands are face up. */
export interface ShowdownInputs {
  /** Whose wagers the showdown sweeps into the pot, in seat order. In an all-in runout the showdown comes first, so it sweeps the line. */
  readonly swept: readonly ParticipantId[];
  /** Whose hands are turned up, in the order they are shown, and how many cards each. */
  readonly shown: readonly { readonly participantId: ParticipantId; readonly cardCount: number }[];
}

export interface ShowdownBeats extends PhaseBeats {
  readonly sweep: SweepBeats;
  /** Each hand turned up, in the order shown: each of its cards turning face up (`turn`). */
  readonly hands: readonly { readonly participantId: ParticipantId; readonly cards: readonly { readonly card: number; readonly turn: Beat }[] }[];
}

/** The showdown's beats, from the phase's start, given what it presents; with `durationMs`, fitted to that length. */
export const showdownBeats = beatFunction((inputs: ShowdownInputs, at, timings): ShowdownBeats => {
  const hand: number[] = [], cardInHand: number[] = [];
  inputs.shown.forEach(({ cardCount }, h) => { for (let card = 0; card < cardCount; card++) { hand.push(h); cardInHand.push(card); } });
  const placed = evaluateBeats(showdownDefs, { ...sweepCounts(inputs.swept), shownCards: hand.length, hand, cardInHand }, timings);
  const sweep = sweepOf(placed, inputs.swept, at);
  let turned = 0;
  const hands = inputs.shown.map(({ participantId, cardCount }) => ({ participantId, cards: Array.from({ length: cardCount }, (_, card) => ({ card, turn: scaleBeat(at, placed.cardTurn[turned++]!) })) }));
  const totalMs = Math.max(sweepEndsAt(sweep.beats), ...hands.flatMap(h => h.cards.map(c => c.turn.endsAt)));
  return { totalMs, sweep: sweep.beats, hands };
});

/**
 * The payout: the pot pushed onto each winner's stack in turn. The payout phase lasts as long as these beats
 * (`payoutBeats`).
 */

/** What the payout presents. Every field is public in the view once the Hand is complete: its payouts and returns. */
export interface PayoutInputs {
  /**
   * Each Participant the payout pushes chips to, in seat order: what they won from the pots, and what came back to
   * them uncalled. A Participant appears once, however many pots they won.
   */
  readonly awards: readonly { readonly participantId: ParticipantId; readonly won: ChipAmount; readonly returned: ChipAmount }[];
}

export interface PayoutBeats extends PhaseBeats {
  /** The pot dimming and brightening as it is pushed. */
  readonly pot: Beat;
  /**
   * Each award, in turn: its chips (`amount`, won and returned together) leave the pot at `startsAt` and land on the
   * winner's stack at `endsAt`, when the stack figure takes its new value; they then fade into the stack (`fade`), and
   * the winner's caption shows (`caption`).
   */
  readonly awards: readonly (Beat & { readonly participantId: ParticipantId; readonly amount: ChipAmount; readonly fade: Beat; readonly caption: Beat })[];
}

/** The payout's beats, from the phase's start, given what it presents; with `durationMs`, fitted to that length. */
export const payoutBeats = beatFunction((inputs: PayoutInputs, at, timings): PayoutBeats => {
  const placed = evaluateBeats(payoutDefs, { awards: inputs.awards.length }, timings);
  const pot = scaleBeat(at, placed.pot[0]!);
  const awards = inputs.awards.map(({ participantId, won, returned }, i) => ({ participantId, amount: won + returned, ...scaleBeat(at, placed.award[i]!), fade: scaleBeat(at, placed.awardFade[i]!), caption: scaleBeat(at, placed.awardCaption[i]!) }));
  const totalMs = Math.max(pot.endsAt, ...awards.flatMap(a => [a.endsAt, a.fade.endsAt, a.caption.endsAt]));
  return { totalMs, pot, awards };
});

/** Table motion with no Presentation Phase: timed from the view that carried it, and never gates play. */
export const tableMotion = committedTimings.motion;

/** Reading Phase Inputs field by field: each reader returns `undefined` for a value of the wrong shape. */
const record = (value: unknown): Record<string, unknown> | undefined => (typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined);
const count = (value: unknown): number | undefined => (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined);
const participant = (value: unknown): ParticipantId | undefined => (typeof value === 'string' ? value : undefined);
/** Each item of a list read by `item`, or `undefined` unless every one reads. */
function list<T>(value: unknown, item: (value: unknown) => T | undefined): T[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.map(item);
  return items.every(read => read !== undefined) ? items as T[] : undefined;
}
/** A list of objects, each read from its fields by `fields`. */
const listOf = <T>(value: unknown, fields: (item: Record<string, unknown>) => T | undefined) => list(value, item => { const r = record(item); return r && fields(r); });
/** Participants paired with a count, as `{ participantId, [key]: count }`. */
const counted = <K extends string>(value: unknown, key: K) => listOf(value, item => {
  const participantId = participant(item.participantId), n = count(item[key]);
  return participantId === undefined || n === undefined ? undefined : { participantId, [key]: n } as { readonly participantId: ParticipantId } & { readonly [P in K]: number };
});
/** `fields`, unless one of them failed to read. */
const whole = <T extends object>(fields: { readonly [P in keyof T]: T[P] | undefined }): T | undefined => (Object.values(fields).every(field => field !== undefined) ? fields as T : undefined);

/** Each presenting phase kind's beat function and its Phase Inputs reader. */
const byKind: { readonly [K in PresentingPhaseKind]: { readonly beats: (inputs: PhaseInputs[K], durationMs?: number) => PhaseBeats; readonly read: (value: unknown) => PhaseInputs[K] | undefined } } = {
  deal: { beats: dealBeats, read: value => { const r = record(value); return r && whole<DealInputs>({ dealt: counted(r.dealt, 'cardCount'), blinds: list(r.blinds, participant), refills: counted(r.refills, 'amount') }); } },
  street: { beats: streetBeats, read: value => { const r = record(value); return r && whole<StreetInputs>({ swept: list(r.swept, participant), cardCount: count(r.cardCount) }); } },
  showdown: { beats: showdownBeats, read: value => { const r = record(value); return r && whole<ShowdownInputs>({ swept: list(r.swept, participant), shown: counted(r.shown, 'cardCount') }); } },
  payout: { beats: payoutBeats, read: value => { const r = record(value); return r && whole<PayoutInputs>({ awards: listOf(r.awards, item => whole({ participantId: participant(item.participantId), won: count(item.won), returned: count(item.returned) })) }); } },
};

/** The beats of a phase of `kind` presenting `inputs`; with `durationMs`, fitted to that length. */
function beatsOf<K extends PresentingPhaseKind>(kind: K, inputs: PhaseInputs[K], durationMs?: number): PhaseBeats {
  return byKind[kind].beats(inputs, durationMs);
}
