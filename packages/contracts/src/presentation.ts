import type { PresentingPhaseKind, TableMode } from './index.js';

/**
 * Presentation timing, shared by the server and the Trainer (ADR-0039). The server schedules Presentation Phases and
 * the Next-Hand Countdown from it; the Trainer times the table's motion from it. Every value is in milliseconds.
 * Overlays (menus, dialogs, notices, the analysis panel) are not table events and keep their own timings in the web app.
 *
 * Motion offsets are from the moment the motion presents: a phase's start, or the view that carried it.
 */

/** Each presenting Presentation Phase's length, by kind. */
export const presentationPhaseDurations: Readonly<Record<PresentingPhaseKind, number>> = Object.freeze({ deal: 1500, street: 1000, showdown: 2000, payout: 2000 });

/** The length of the Settle after each presenting phase, by the phase it follows; after the payout, by table mode too. */
export interface SettleLengths {
  readonly deal: number;
  readonly street: number;
  readonly showdown: number;
  readonly payout: Readonly<Record<TableMode, number>>;
}

/**
 * The Settle lengths: a moment to take in the deal or a street before acting, time to read the turned hands before the
 * pot is pushed, and a moment to see the result before the next Hand can start. Each may be 0: a Settle of 0 is not
 * scheduled, and what follows starts when the phase before it ends.
 */
export const settleLengths: SettleLengths = Object.freeze({ deal: 300, street: 300, showdown: 1200, payout: Object.freeze({ practice: 600, online: 3000 }) });

/** The length of the Settle after a phase of `kind` at a table of `mode`. */
export const settleAfter = (kind: PresentingPhaseKind, mode: TableMode, lengths: SettleLengths = settleLengths): number => kind === 'payout' ? lengths.payout[mode] : lengths[kind];

/** How long an Online Table's Next-Hand Countdown runs, from its announcement to the next Hand. */
export const nextHandCountdownMs = 5000;

/**
 * Chips on the betting line inside a Presentation Phase: the blinds going in with the deal, and the room a street reveal
 * or showdown leaves for the line to be swept. A bet and the sweep itself are motion with no phase (`tableMotion`).
 */
export const wagerMotion = Object.freeze({
  /** A blind's chip flight from the seat to the betting line, and when its amount appears, just before the chip lands. */
  chipFlight: 300, amountAppears: 290,
  /** The room a sweep of n wagers takes before what follows it: `sweptBase + n × sweepStagger`, or 0 with none. */
  sweptBase: 320, sweepStagger: 40,
});

const refillLands = 480;

/** The deal: the last Hand's cards back to the deck, the button on, the blinds in, and the cards out in dealing order. */
export const dealMotion = Object.freeze({
  /** Each of the last Hand's cards returning to the deck, one after another. */
  returnFlight: 360, returnStagger: 18,
  buttonMoves: 520,
  /** The gap between one blind going in and the next. */
  blindStagger: 80,
  /** When a card's real face appears, before its flight ends. */
  cardAppearsBefore: 10,
  /** Your own cards turning face up, after landing. */
  turnAfterLanding: 20, turn: 260,
  /**
   * When the blinds and the first card go in; the room the cards share, and the most between two of them, so the
   * spacing tightens past twelve cards; and each card's flight.
   */
  plain: Object.freeze({ blinds: 0, cards: 220, room: 900, most: 75, flight: 340 }),
  /** The same after a refill that came with the deal: the chips land first, and the Hand is dealt a little faster. */
  afterRefill: Object.freeze({ blinds: refillLands + 20, cards: refillLands + 160, room: 520, most: 55, flight: 300 }),
  /** When a refill that came with the deal lands, before the blinds go in: the refill's chips fly in for this long. */
  refillLands,
});

/** A street reveal: the line swept, the burn, then the board cards (the flop as one stack that spreads). */
export const streetMotion = Object.freeze({
  /** The burn's earliest start, and how far it may overlap the end of a sweep. */
  burnEarliest: 160, burnOverlapsSweep: 40,
  burnFlight: 200,
  /** When the burn pile's first card appears, after its burn sets off. */
  burnPileAppears: 190,
  /** When the board cards leave the deck, after the burn sets off. */
  boardAfterBurn: 200,
  /** The flop: its stack's flight, when its cards appear, their spread, and their turns one after another. */
  flopFlight: 220, flopAppears: 215, flopSpreadsAt: 220, flopSpread: 180, flopTurnsAt: 240, flopTurnStagger: 40, flopTurn: 240,
  /** The turn and the river: the card's flight, when it appears, and its turn. */
  cardFlight: 260, cardAppears: 255, cardTurnsAt: 270, cardTurn: 260,
});

/** The showdown: the line swept, then each hand turned up, card by card. */
export const showdownMotion = Object.freeze({
  /** When the first card turns, after the sweep's room; the gap to the second card; and each turn. */
  turnsAfterSweep: 150, cardStagger: 120, turn: 380,
});

/** The payout: the pot pushed onto each winner's stack in turn. */
export const payoutMotion = Object.freeze({
  /** The pot dimming and brightening as it is pushed. */
  potAt: 150, potPulse: 700,
  /** When the first award lands on its winner's stack, and the gap to each next award. */
  firstLands: 710, stagger: 60,
  /** Each award's push from the pot, ending as it lands. */
  push: 560,
  /** The pushed chips fading into the stack once they land. */
  landFade: 160,
  /** The winner's caption appearing, from just before the chips land. */
  captionBeforeLanding: 20, caption: 160,
});

/**
 * Table motion with no Presentation Phase: it is timed from the view that carried it and never gates play. It plays at
 * the phases' followable tempo, 1.5× the M5 motion's timings.
 */
export const tableMotion = Object.freeze({
  /** A bet's chip flight from the seat to the betting line, and when its amount appears, just before the chip lands. */
  betFlight: 450, betAmountAppears: 435,
  /** A bet straight into the pot (when there is no betting line to land on). */
  betToPot: 510,
  /** An acting seat's caption appearing. */
  caption: 225,
  /** A folded hand mucked to the middle of the table, card after card. */
  muckFlight: 510, muckStagger: 60,
  check: 360,
  /** The line swept to the pot: when it starts, after the view that carried it. */
  sweepAt: 180,
  /** A swept chip's flight to the pot, and the gap between one wager's chip and the next. */
  sweepFlight: 420, sweepStagger: 60,
  /** A swept wager's amount fading as its chip leaves. */
  sweepAmountFade: 210,
  /** The pot brightening once the chips reach it, after the sweep starts (plus one stagger per wager). */
  potAfterSweep: 390, potBrightens: 240,
  /** A seat settling in place. */
  seatArrives: 360,
  /** A Participant sitting down: the empty seat fading, then the seat arriving. */
  sitFade: 210, sitArrivesAt: 120,
  /** A Participant standing up or moving: the seat they left fading and shrinking, then the seats arriving. */
  leaveFade: 300, leaveArrivesAt: 210, moveVacatedArrivesAt: 300,
  /** Chips added to a stack: their flight in from the table's edge, the floating amount, and the figure's roll. */
  chipsFlight: 840, chipsLabel: 1650, stackRoll: 1050,
  /** The viewer's own seat change: the old seats fading, the new ones arriving, and the label naming the seat. */
  seatChangeFade: 240, seatChangeArrivesAt: 180, seatChangeArrives: 330, seatChangeLabel: 2400,
  /** A seat's status changing: its caption and connection label. */
  status: 270,
});
