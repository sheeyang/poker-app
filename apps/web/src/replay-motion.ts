import { presentationPhaseLength, presentingPhase, settleAfter, type ObservableTableSession, type PhaseInputs, type PresentationPhase, type PresentingPhaseKind, type ReplayStep, type TableHandReplay } from '@poker/contracts';
import { replayTable } from './replay.js';
import { planMotion, sceneOf, type Cue } from './table-motion.js';

/**
 * Replay motion (ADR-0041), as pure model: what the felt draws, and the motion it plays, as the reader steps through a
 * Hand. A replay has no server time to follow, so motion is timed by the client from the moment of each step input.
 * Motion only presents a step: what the step shows is the step's own table, whatever motion is playing.
 */

/** How the reader went to a step: one step on with Next or Back (or the arrow keys), or a jump (a street, a decision, an address). */
export type ReplayMove = 'step' | 'jump';

/** The felt of a replay, as it draws and moves. */
export interface ReplayFelt {
  /** The step the reader is at: where the felt rests once its motion is over. */
  readonly step: number;
  /** The step the felt draws now, and its table. */
  readonly drawn: number;
  readonly table: ObservableTableSession;
  /** The motion to play, timed on the client clock. */
  readonly cues: readonly Cue[];
  /** Play the cues backward: a step back, drawn at the later step until its motion is over. */
  readonly reverse: boolean;
  /**
   * Which step input this felt answers. A new one snaps any motion still playing to its end state before its own
   * plays, so fast stepping never queues motion.
   */
  readonly input: number;
}

/** A replay opened at `step`, drawn at once. */
export function openReplay(replay: TableHandReplay, step: number, input = 0): ReplayFelt {
  return { step, drawn: step, table: replayTable(replay, step), cues: [], reverse: false, input };
}

/**
 * A step's transition as Presentation Phases from `at`, one after another with their Settles, as the server schedules
 * a live transition's: so its motion plays M5's choreography from the step's own inputs.
 */
function transitionPhases(step: ReplayStep, handId: string, mode: TableHandReplay['mode'], at: number): PresentationPhase[] {
  const phases: PresentationPhase[] = [], street = step.state.street ?? 'preflop';
  let cursor = at;
  const add = <K extends PresentingPhaseKind>(kind: K, inputs: PhaseInputs[K] | undefined) => {
    if (!inputs) return;
    const durationMs = presentationPhaseLength(presentingPhase(kind, inputs));
    phases.push({ kind, handId, street, startsAt: cursor, endsAt: cursor + durationMs, durationMs, inputs } as PresentationPhase);
    cursor += durationMs + settleAfter(kind, mode);
  };
  const { deal, street: reveal, showdown, payout } = step.transition;
  add('deal', deal); add('street', reveal); add('showdown', showdown); add('payout', payout);
  return phases;
}

/** The step at `index`'s own motion from the step before it, played from client time `at`, and the table it plays on. */
function stepMotion(replay: TableHandReplay, index: number, at: number): { readonly table: ObservableTableSession; readonly cues: Cue[] } {
  const still = replayTable(replay, index);
  const table: ObservableTableSession = { ...still, serverTime: at, schedule: { phases: transitionPhases(replay.steps[index]!, replay.handId, replay.mode, at), actionWindow: null } };
  return { table, cues: planMotion(sceneOf(replayTable(replay, index - 1)), table) };
}

/**
 * The reader goes to step `to`, `how`, at client time `now`. One step on plays that step's motion; one step back plays
 * the same motion in reverse; a jump renders at once. Motion still playing is over: the move starts from the reader's
 * step, where that motion ends.
 */
export function moveReplay(replay: TableHandReplay, felt: ReplayFelt, to: number, how: ReplayMove, now: number): ReplayFelt {
  const from = felt.step, input = felt.input + 1;
  if (how === 'step' && to === from + 1) return { step: to, drawn: to, ...stepMotion(replay, to, now), reverse: false, input };
  // A step back plays the later step's own cues backward, on its felt: it ends where the earlier step begins. One that
  // would undo a deal renders at once: cards gathered back into the deck show nothing worth waiting for.
  if (how === 'step' && to === from - 1 && !replay.steps[from]?.transition.deal) return { step: to, drawn: from, table: replayTable(replay, from), cues: stepMotion(replay, from, now).cues, reverse: true, input };
  return openReplay(replay, to, input);
}

/**
 * `felt` once the motion of step input `input` is over: resting on the reader's step. A motion that a later input
 * snapped settles nothing.
 */
export function settleReplay(replay: TableHandReplay, felt: ReplayFelt, input: number): ReplayFelt {
  return input !== felt.input || felt.drawn === felt.step ? felt : openReplay(replay, felt.step, felt.input + 1);
}
