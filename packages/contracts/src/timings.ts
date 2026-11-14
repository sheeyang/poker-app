import timingsJson from './timings.json' with { type: 'json' };

/**
 * Every table timing, in milliseconds, as committed in `timings.json` (ADR-0040). The server and the Trainer read the
 * same values; the beat functions take a `Timings` and default to these.
 */
export type Timings = typeof timingsJson;

/** The committed timings. */
export const committedTimings: Timings = timingsJson;

type PathsOf<T> = { [K in keyof T & string]: T[K] extends number ? K : `${K}.${PathsOf<T[K]>}` }[keyof T & string];
/** A timing's path in the JSON file, such as `deal.cardFlight` or `settle.payout.online`. */
export type TimingPath = PathsOf<Timings>;

/** What each timing times, keyed by its path. Typecheck fails if a timing has no note, or a note names no timing. */
export const timingNotes: { readonly [P in TimingPath]: string } = {
  'deal.returnFlight': 'Each of the last Hand\'s cards returning to the deck: its flight.',
  'deal.returnStagger': 'The gap between one returning card setting off and the next.',
  'deal.returnRoom': 'The most time from the first returning card setting off to the last, so the gap tightens when many return.',
  'deal.buttonMoves': 'The button moving to its seat.',
  'deal.refillLands': 'A refill that came with the deal (Practice\'s Rebuy & deal): its chips flying in.',
  'deal.blindsAfterRefill': 'The gap from a refill landing to the blinds setting off.',
  'deal.blindFlight': 'Each blind\'s chip flight to the betting line.',
  'deal.blindAppearsBefore': 'A blind\'s amount appearing, this long before its chip lands.',
  'deal.blindStagger': 'The gap between one blind setting off and the next.',
  'deal.cardsAfterBlinds': 'When the first card leaves the deck, after the blinds start.',
  'deal.cardsRoom': 'The room the dealt cards share, so the spacing tightens past twelve cards.',
  'deal.cardGap': 'The most time between one card leaving the deck and the next.',
  'deal.cardFlight': 'Each dealt card\'s flight from the deck.',
  'deal.cardAppearsBefore': 'A dealt card appearing in place, this long before it lands.',
  'deal.turnAfterLanding': 'A Participant\'s own card starting to turn, after it lands.',
  'deal.turn': 'A Participant\'s own card turning face up.',
  'street.burnEarliest': 'When the burn sets off with nothing swept; with a sweep, it sets off as the last chip reaches the pot.',
  'street.burnFlight': 'The burn card\'s flight to the burn pile.',
  'street.appearsBefore': 'A card (the burn, or a board card) appearing in place, this long before it lands.',
  'street.boardAfterBurn': 'When the board cards leave the deck, after the burn sets off.',
  'street.flopFlight': 'The flop stack\'s flight from the deck.',
  'street.flopSpread': 'The flop spreading to its places once it lands.',
  'street.flopTurnsAfterLanding': 'The first flop card starting to turn, after the flop lands.',
  'street.flopTurnStagger': 'The gap between one flop card turning and the next.',
  'street.flopTurn': 'Each flop card turning face up.',
  'street.cardFlight': 'The turn or river card\'s flight from the deck.',
  'street.cardTurnsAfterLanding': 'The turn or river card starting to turn, after it lands.',
  'street.cardTurn': 'The turn or river card turning face up.',
  'showdown.turnsAfterSweep': 'The first card turning, after the last swept chip reaches the pot.',
  'showdown.handStagger': 'The gap from one hand starting to turn to the next.',
  'showdown.cardStagger': 'The gap from one card of a hand turning to the next.',
  'showdown.turn': 'Each showdown card turning face up.',
  'payout.potAt': 'When the pot starts dimming and brightening as it is pushed.',
  'payout.potPulse': 'The pot dimming and brightening.',
  'payout.firstLands': 'When the first award lands on its winner\'s stack.',
  'payout.stagger': 'The gap between one award landing and the next.',
  'payout.push': 'Each award\'s push from the pot, ending as it lands.',
  'payout.landFade': 'The pushed chips fading into the stack once they land.',
  'payout.captionBeforeLanding': 'The winner\'s caption appearing, this long before the chips land.',
  'payout.caption': 'The winner\'s caption appearing.',
  'settle.deal': 'The Settle after the deal: a moment to take in the cards before acting.',
  'settle.street': 'The Settle after a street reveal: a moment to take in the board before acting.',
  'settle.showdown': 'The Settle after the showdown: the time to read the turned hands before the pot is pushed.',
  'settle.payout.practice': 'The Settle after the payout at a Practice Table: a moment to see the result.',
  'settle.payout.online': 'The Settle after the payout at an Online Table, before the Next-Hand Countdown.',
  'nextHandCountdownMs': 'How long an Online Table\'s Next-Hand Countdown runs, from its announcement to the next Hand.',
  'motion.betFlight': 'A bet\'s chip flight from the seat to the betting line.',
  'motion.betAmountAppears': 'A bet\'s amount appearing, just before the chip lands.',
  'motion.betToPot': 'A bet straight into the pot, when there is no betting line to land on.',
  'motion.caption': 'An acting seat\'s caption appearing.',
  'motion.muckFlight': 'A folded card mucked to the middle of the table: its flight.',
  'motion.muckStagger': 'The gap between one mucked card and the next.',
  'motion.check': 'A check.',
  'motion.sweepAt': 'The line swept to the pot: when it starts, after the view that carried it.',
  'motion.sweepFlight': 'A swept chip\'s flight to the pot.',
  'motion.sweepStagger': 'The gap between one wager\'s chip leaving and the next.',
  'motion.sweepAmountFade': 'A swept wager\'s amount fading as its chip leaves.',
  'motion.potAfterSweep': 'The pot brightening, after the sweep starts (plus one stagger per wager).',
  'motion.potBrightens': 'The pot brightening once the chips reach it.',
  'motion.seatArrives': 'A seat settling in place.',
  'motion.sitFade': 'A Participant sitting down: the empty seat fading.',
  'motion.sitArrivesAt': 'A Participant sitting down: when the seat arrives.',
  'motion.leaveFade': 'A Participant standing up or moving: the seat they left fading and shrinking.',
  'motion.leaveArrivesAt': 'A Participant standing up: when the seats arrive.',
  'motion.moveVacatedArrivesAt': 'A Participant moving: when the seats arrive.',
  'motion.chipsFlight': 'Chips added to a stack: their flight in from the table\'s edge.',
  'motion.chipsLabel': 'Chips added to a stack: the floating amount.',
  'motion.stackRoll': 'Chips added to a stack: the figure\'s roll.',
  'motion.seatChangeFade': 'The viewer\'s own seat change: the old seats fading.',
  'motion.seatChangeArrivesAt': 'The viewer\'s own seat change: when the new seats start arriving.',
  'motion.seatChangeArrives': 'The viewer\'s own seat change: the new seats arriving.',
  'motion.seatChangeLabel': 'The viewer\'s own seat change: the label naming the seat.',
  'motion.status': 'A seat\'s status changing: its caption and connection label.',
};
