import { describeBeats, evaluateBeats, type BeatDef, type BeatDescription, type PlacedBeat } from './anchored-beats.js';
import { committedTimings, type Timings } from './timings.js';

/**
 * Motion with no Presentation Phase, as beats from anchors (ADR-0040): each kind is anchored to the table event that
 * causes it, and played from the server time of the view that carried it. It never gates play: nothing here lengthens
 * an Action Window, a deal or the Next-Hand Countdown. Each kind has its definition, its plain beats (milliseconds
 * from the event) and a description of each beat for the motion panel.
 */

/** A beat: milliseconds from the table event that causes it. */
export type MotionBeat = PlacedBeat;

const once = { each: 'once' } as const;
const event = (name: string) => ({ to: 'event', event: name }) as const;
const first = (beats: readonly MotionBeat[]): MotionBeat => beats[0]!;

// A bet: its chip to the betting line (its amount appearing just before the chip lands), or straight to the pot when
// the bet closed the street.
const betDefs = [
  { beat: 'lineChip', each: 'toLine', follows: event('bet'), gap: [], length: [{ timing: 'motion.betFlight' }] },
  { beat: 'lineAmount', each: 'toLine', follows: event('bet'), gap: [{ timing: 'motion.betAmountAppears' }], length: [] },
  { beat: 'potChip', each: 'toPot', follows: event('bet'), gap: [], length: [{ timing: 'motion.betToPot' }] },
  { beat: 'caption', ...once, follows: event('bet'), gap: [], length: [{ timing: 'motion.caption' }] },
] as const satisfies readonly BeatDef[];
export const betBeatDescription: readonly BeatDescription[] = describeBeats(betDefs);

export interface BetBeats {
  /** The chip's flight, to the betting line or (when the bet closed the street) the pot. */
  readonly chip: MotionBeat;
  /** When the amount appears on the betting line; none for a bet straight to the pot. */
  readonly amountAppears?: number;
  readonly caption: MotionBeat;
}
/** A bet's beats from the view that carried it; `toPot`: it closed the street, so its chips go straight to the pot. */
export function betBeats(toPot: boolean, timings: Timings = committedTimings): BetBeats {
  const b = evaluateBeats(betDefs, { toLine: toPot ? 0 : 1, toPot: toPot ? 1 : 0 }, timings);
  return toPot ? { chip: first(b.potChip), caption: first(b.caption) } : { chip: first(b.lineChip), amountAppears: first(b.lineAmount).startsAt, caption: first(b.caption) };
}

// A fold: each mucked card flies to the middle, one after another, and the caption appears.
const foldDefs = [
  { beat: 'muck', each: 'mucked', follows: event('fold'), gap: [{ timing: 'motion.muckStagger', times: 'index' }], length: [{ timing: 'motion.muckFlight' }] },
  { beat: 'caption', ...once, follows: event('fold'), gap: [], length: [{ timing: 'motion.caption' }] },
] as const satisfies readonly BeatDef[];
export const foldBeatDescription: readonly BeatDescription[] = describeBeats(foldDefs);

export interface FoldBeats { readonly mucks: readonly MotionBeat[]; readonly caption: MotionBeat }
/** A fold's beats; `mucked`: how many cards are mucked (none when the viewer's own hand stays, dimmed). */
export function foldBeats(mucked: number, timings: Timings = committedTimings): FoldBeats {
  const b = evaluateBeats(foldDefs, { mucked }, timings);
  return { mucks: b.muck, caption: first(b.caption) };
}

// A check: the seat presses in, and the caption appears.
const checkDefs = [
  { beat: 'press', ...once, follows: event('check'), gap: [], length: [{ timing: 'motion.check' }] },
  { beat: 'caption', ...once, follows: event('check'), gap: [], length: [{ timing: 'motion.caption' }] },
] as const satisfies readonly BeatDef[];
export const checkBeatDescription: readonly BeatDescription[] = describeBeats(checkDefs);

export interface CheckBeats { readonly press: MotionBeat; readonly caption: MotionBeat }
export function checkBeats(timings: Timings = committedTimings): CheckBeats {
  const b = evaluateBeats(checkDefs, {}, timings);
  return { press: first(b.press), caption: first(b.caption) };
}

// A Participant sitting down: the empty seat fades while the new seat arrives.
const sitDefs = [
  { beat: 'fade', ...once, follows: event('arrival'), gap: [], length: [{ timing: 'motion.sitFade' }] },
  { beat: 'arrives', ...once, follows: event('arrival'), gap: [{ timing: 'motion.sitArrivesAt' }], length: [{ timing: 'motion.seatArrives' }] },
] as const satisfies readonly BeatDef[];
export const sitBeatDescription: readonly BeatDescription[] = describeBeats(sitDefs);

export interface SitBeats { readonly fade: MotionBeat; readonly arrives: MotionBeat }
export function sitBeats(timings: Timings = committedTimings): SitBeats {
  const b = evaluateBeats(sitDefs, {}, timings);
  return { fade: first(b.fade), arrives: first(b.arrives) };
}

// A Participant standing up: the seat they left fades while the empty seat arrives.
const standDefs = [
  { beat: 'fade', ...once, follows: event('departure'), gap: [], length: [{ timing: 'motion.leaveFade' }] },
  { beat: 'arrives', ...once, follows: event('departure'), gap: [{ timing: 'motion.leaveArrivesAt' }], length: [{ timing: 'motion.seatArrives' }] },
] as const satisfies readonly BeatDef[];
export const standBeatDescription: readonly BeatDescription[] = describeBeats(standDefs);

export interface StandBeats { readonly fade: MotionBeat; readonly arrives: MotionBeat }
export function standBeats(timings: Timings = committedTimings): StandBeats {
  const b = evaluateBeats(standDefs, {}, timings);
  return { fade: first(b.fade), arrives: first(b.arrives) };
}

// A Participant moving: the seat left and the new seat fade, then the new seat and the vacated seat arrive.
const moveDefs = [
  { beat: 'leftFade', ...once, follows: event('move'), gap: [], length: [{ timing: 'motion.leaveFade' }] },
  { beat: 'newFade', ...once, follows: event('move'), gap: [], length: [{ timing: 'motion.sitFade' }] },
  { beat: 'newArrives', ...once, follows: event('move'), gap: [{ timing: 'motion.leaveArrivesAt' }], length: [{ timing: 'motion.seatArrives' }] },
  { beat: 'vacatedArrives', ...once, follows: event('move'), gap: [{ timing: 'motion.moveVacatedArrivesAt' }], length: [{ timing: 'motion.seatArrives' }] },
] as const satisfies readonly BeatDef[];
export const moveBeatDescription: readonly BeatDescription[] = describeBeats(moveDefs);

export interface MoveBeats { readonly leftFade: MotionBeat; readonly newFade: MotionBeat; readonly newArrives: MotionBeat; readonly vacatedArrives: MotionBeat }
export function moveBeats(timings: Timings = committedTimings): MoveBeats {
  const b = evaluateBeats(moveDefs, {}, timings);
  return { leftFade: first(b.leftFade), newFade: first(b.newFade), newArrives: first(b.newArrives), vacatedArrives: first(b.vacatedArrives) };
}

// Chips added to a stack: the flight in, the floating amount and the figure's roll, together.
const chipsDefs = [
  { beat: 'flight', ...once, follows: event('chips added'), gap: [], length: [{ timing: 'motion.chipsFlight' }] },
  { beat: 'label', ...once, follows: event('chips added'), gap: [], length: [{ timing: 'motion.chipsLabel' }] },
  { beat: 'roll', ...once, follows: event('chips added'), gap: [], length: [{ timing: 'motion.stackRoll' }] },
] as const satisfies readonly BeatDef[];
export const chipsBeatDescription: readonly BeatDescription[] = describeBeats(chipsDefs);

export interface ChipsBeats { readonly flight: MotionBeat; readonly label: MotionBeat; readonly roll: MotionBeat }
export function chipsBeats(timings: Timings = committedTimings): ChipsBeats {
  const b = evaluateBeats(chipsDefs, {}, timings);
  return { flight: first(b.flight), label: first(b.label), roll: first(b.roll) };
}

// The viewer's own seat change: the old seats fade, then the new seats and the label naming the seat arrive.
const seatChangeDefs = [
  { beat: 'fade', ...once, follows: event('seat change'), gap: [], length: [{ timing: 'motion.seatChangeFade' }] },
  { beat: 'arrives', ...once, follows: event('seat change'), gap: [{ timing: 'motion.seatChangeArrivesAt' }], length: [{ timing: 'motion.seatChangeArrives' }] },
  { beat: 'label', ...once, follows: event('seat change'), gap: [{ timing: 'motion.seatChangeArrivesAt' }], length: [{ timing: 'motion.seatChangeLabel' }] },
] as const satisfies readonly BeatDef[];
export const seatChangeBeatDescription: readonly BeatDescription[] = describeBeats(seatChangeDefs);

export interface SeatChangeBeats { readonly fade: MotionBeat; readonly arrives: MotionBeat; readonly label: MotionBeat }
export function seatChangeBeats(timings: Timings = committedTimings): SeatChangeBeats {
  const b = evaluateBeats(seatChangeDefs, {}, timings);
  return { fade: first(b.fade), arrives: first(b.arrives), label: first(b.label) };
}

// A seat's status changing: its caption and its connection label.
const statusDefs = [
  { beat: 'caption', ...once, follows: event('status change'), gap: [], length: [{ timing: 'motion.status' }] },
  { beat: 'connection', ...once, follows: event('status change'), gap: [], length: [{ timing: 'motion.status' }] },
] as const satisfies readonly BeatDef[];
export const statusBeatDescription: readonly BeatDescription[] = describeBeats(statusDefs);

export interface StatusBeats { readonly caption: MotionBeat; readonly connection: MotionBeat }
export function statusBeats(timings: Timings = committedTimings): StatusBeats {
  const b = evaluateBeats(statusDefs, {}, timings);
  return { caption: first(b.caption), connection: first(b.connection) };
}
