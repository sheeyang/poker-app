import { describeBeats, type BeatDef, type BeatDescription } from './anchored-beats.js';

/**
 * The street reveal's, the showdown's and the payout's beats as data (ADR-0040): each an anchor, a gap and a length over
 * the motion timings. `presentation.ts` evaluates them into the beats the server and the Trainer consume.
 */

/**
 * The betting line swept into the pot, shared by a street reveal, a showdown, and a Hand won by folds: each swept
 * wager's chip flies to the pot one after another, its amount fading as it leaves, and the pot brightens once the chips
 * reach it (counted by `sweptAny`: absent with nothing swept). Counts: `swept`, `sweptAny`.
 */
export const sweepDefs = [
  { beat: 'sweepWager', each: 'swept', follows: { to: 'phase' }, gap: [{ timing: 'motion.sweepAt' }, { timing: 'motion.sweepStagger', times: 'index' }], length: [{ timing: 'motion.sweepFlight' }] },
  { beat: 'sweepAmountFade', each: 'swept', follows: { to: 'start', of: 'sweepWager', instance: 'same' }, gap: [], length: [{ timing: 'motion.sweepAmountFade' }] },
  { beat: 'sweepPot', each: 'sweptAny', follows: { to: 'phase' }, gap: [{ timing: 'motion.sweepAt' }, { timing: 'motion.potAfterSweep' }, { timing: 'motion.sweepStagger', times: 'swept' }], length: [{ timing: 'motion.potBrightens' }] },
] as const satisfies readonly BeatDef[];

/** What each sweep beat follows, its gap and length formulas, and the timings that directly set it. */
export const sweepBeatDescription: readonly BeatDescription[] = describeBeats(sweepDefs);

/**
 * A street reveal: the line swept, the burn once the last swept chip reaches the pot (or `street.burnEarliest`, if
 * later), then the board cards: the flop leaves the deck as one stack and spreads, the turn and the river one card each,
 * and each card turns face up once it lands. Counts: those of the sweep, `flopCards` (3, or 0 after the flop) and
 * `singleCards` (1 for the turn and the river, else 0).
 */
export const streetDefs = [
  ...sweepDefs,
  { beat: 'burn', each: 'once', follows: { to: 'end', of: 'sweepWager', instance: 'last', atLeast: 'street.burnEarliest' }, gap: [], length: [{ timing: 'street.burnFlight' }] },
  { beat: 'burnAppears', each: 'once', follows: { to: 'end', of: 'burn', instance: 'same' }, gap: [{ timing: 'street.appearsBefore', times: -1 }], length: [] },
  { beat: 'flopCard', each: 'flopCards', follows: { to: 'start', of: 'burn', instance: 'first' }, gap: [{ timing: 'street.boardAfterBurn' }], length: [{ timing: 'street.flopFlight' }] },
  { beat: 'flopCardAppears', each: 'flopCards', follows: { to: 'end', of: 'flopCard', instance: 'same' }, gap: [{ timing: 'street.appearsBefore', times: -1 }], length: [] },
  { beat: 'flopSpread', each: 'flopCards', follows: { to: 'end', of: 'flopCard', instance: 'same' }, gap: [], length: [{ timing: 'street.flopSpread' }] },
  { beat: 'flopCardTurn', each: 'flopCards', follows: { to: 'end', of: 'flopCard', instance: 'same' }, gap: [{ timing: 'street.flopTurnsAfterLanding' }, { timing: 'street.flopTurnStagger', times: 'index' }], length: [{ timing: 'street.flopTurn' }] },
  { beat: 'boardCard', each: 'singleCards', follows: { to: 'start', of: 'burn', instance: 'first' }, gap: [{ timing: 'street.boardAfterBurn' }], length: [{ timing: 'street.cardFlight' }] },
  { beat: 'boardCardAppears', each: 'singleCards', follows: { to: 'end', of: 'boardCard', instance: 'same' }, gap: [{ timing: 'street.appearsBefore', times: -1 }], length: [] },
  { beat: 'boardCardTurn', each: 'singleCards', follows: { to: 'end', of: 'boardCard', instance: 'same' }, gap: [{ timing: 'street.cardTurnsAfterLanding' }], length: [{ timing: 'street.cardTurn' }] },
] as const satisfies readonly BeatDef[];

/** What each street reveal beat follows, its gap and length formulas, and the timings that directly set it. */
export const streetBeatDescription: readonly BeatDescription[] = describeBeats(streetDefs);

/**
 * The showdown: the line swept, then each hand turned up in turn, card by card, once the last swept chip reaches the
 * pot. Counts: those of the sweep, `shownCards` (every card turned), and per card `hand` (which hand it is in, in the
 * order shown) and `cardInHand` (its place in that hand).
 */
export const showdownDefs = [
  ...sweepDefs,
  { beat: 'cardTurn', each: 'shownCards', follows: { to: 'end', of: 'sweepWager', instance: 'last' }, gap: [{ timing: 'showdown.turnsAfterSweep' }, { timing: 'showdown.handStagger', times: 'hand' }, { timing: 'showdown.cardStagger', times: 'cardInHand' }], length: [{ timing: 'showdown.turn' }] },
] as const satisfies readonly BeatDef[];

/** What each showdown beat follows, its gap and length formulas, and the timings that directly set it. */
export const showdownBeatDescription: readonly BeatDescription[] = describeBeats(showdownDefs);

/**
 * The payout: the pot pushed onto each winner's stack in turn. Each award's chips leave the pot a `push` before they land,
 * then fade into the stack, and the winner's caption shows just before they land. Counts: `awards`.
 */
export const payoutDefs = [
  { beat: 'pot', each: 'once', follows: { to: 'phase' }, gap: [{ timing: 'payout.potAt' }], length: [{ timing: 'payout.potPulse' }] },
  { beat: 'award', each: 'awards', follows: { to: 'phase' }, gap: [{ timing: 'payout.firstLands' }, { timing: 'payout.stagger', times: 'index' }, { timing: 'payout.push', times: -1 }], length: [{ timing: 'payout.push' }] },
  { beat: 'awardFade', each: 'awards', follows: { to: 'end', of: 'award', instance: 'same' }, gap: [], length: [{ timing: 'payout.landFade' }] },
  { beat: 'awardCaption', each: 'awards', follows: { to: 'end', of: 'award', instance: 'same' }, gap: [{ timing: 'payout.captionBeforeLanding', times: -1 }], length: [{ timing: 'payout.caption' }] },
] as const satisfies readonly BeatDef[];

/** What each payout beat follows, its gap and length formulas, and the timings that directly set it. */
export const payoutBeatDescription: readonly BeatDescription[] = describeBeats(payoutDefs);
