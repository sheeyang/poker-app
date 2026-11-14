import {
  betBeats, checkBeats, chipsBeats, committedTimings, foldBeats, moveBeats, seatChangeBeats, sitBeats, standBeats, statusBeats,
  type BetBeats, type CheckBeats, type ChipsBeats, type FoldBeats, type MoveBeats, type SeatChangeBeats, type SitBeats, type StandBeats, type StatusBeats, type Timings,
} from '@poker/contracts';
import type { Cue } from './table-motion.js';

/**
 * Motion with no Presentation Phase, planned from anchored beats (ADR-0040). A cue of these kinds, with its beats: each
 * is milliseconds from the cue's own `at`, the server time of the view that carried it, so a late viewer joins part-way.
 * None of it lengthens an Action Window, a deal or the Next-Hand Countdown: it is only played.
 */
type Anchored<K extends Cue['kind'], B> = Extract<Cue, { kind: K }> & { readonly beats: B };
export type BeatCue =
  | Anchored<'bet', BetBeats> | Anchored<'fold', FoldBeats> | Anchored<'check', CheckBeats> | Anchored<'sit', SitBeats> | Anchored<'stand', StandBeats>
  | Anchored<'move', MoveBeats> | Anchored<'chips', ChipsBeats> | Anchored<'turn', SeatChangeBeats> | Anchored<'status', StatusBeats>;

/** A cue as the choreography plays it: the cues with no phase carry their beats, at `timings` (the committed ones by default). */
export type PlayedCue = Exclude<Cue, { kind: BeatCue['kind'] }> | BeatCue;

export function withBeats(cue: Cue, timings: Timings = committedTimings): PlayedCue {
  switch (cue.kind) {
    case 'bet': return { ...cue, beats: betBeats(cue.toPot, timings) };
    // A fold mucks an opponent's cards; the viewer's own stay, dimmed.
    case 'fold': return { ...cue, beats: foldBeats(cue.muck ? cue.cards : 0, timings) };
    case 'check': return { ...cue, beats: checkBeats(timings) };
    case 'sit': return { ...cue, beats: sitBeats(timings) };
    case 'stand': return { ...cue, beats: standBeats(timings) };
    case 'move': return { ...cue, beats: moveBeats(timings) };
    case 'chips': return { ...cue, beats: chipsBeats(timings) };
    case 'turn': return { ...cue, beats: seatChangeBeats(timings) };
    case 'status': return { ...cue, beats: statusBeats(timings) };
    default: return cue;
  }
}
