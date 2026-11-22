import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { TableHandReplay } from '@poker/contracts';
import { PokerTable } from './poker-table.js';
import { replayTable } from './replay.js';
import { moveReplay, openReplay, settleReplay, type ReplayMove } from './replay-motion.js';
import type { ReplayPlayback } from './table-choreography.js';

const ignore = () => {};

/**
 * The felt of a replay at step `index`, moving there with M5's motion (replay-motion.ts). `move` says how the reader went
 * to `index`: one step on or back plays that step's motion forward or reversed, and anything else renders at once.
 *
 * Motion starts from where things rested at the step it leaves: the earlier step, forward or back. When the felt last
 * drew another step (a step back draws the later one; a step input can snap it mid-way), it draws that earlier step
 * first, unseen, since the motion's layout effect settles it before the browser paints; then the motion's own felt.
 */
export function ReplayFelt({ replay, index, move }: { replay: TableHandReplay; index: number; move: ReplayMove }) {
  const [felt, setFelt] = useState(() => openReplay(replay, index));
  // The step input whose starting step has been drawn, and the step the felt drew at its last commit.
  const [measured, setMeasured] = useState<number>();
  const drew = useRef(index);
  if (felt.step !== index) setFelt(moveReplay(replay, felt, index, move, Date.now()));
  const from = felt.reverse ? felt.step : felt.step - 1;
  const measuring = felt.cues.length > 0 && measured !== felt.input && drew.current !== from;
  const before = useMemo(() => replayTable(replay, Math.max(0, from)), [replay, from]);
  const drawn = measuring ? from : felt.drawn;
  useLayoutEffect(() => { drew.current = drawn; });
  const playback: ReplayPlayback = measuring
    ? { key: `${felt.input}:from`, cues: [], reverse: false, settled: () => setMeasured(felt.input) }
    : { key: String(felt.input), cues: felt.cues, reverse: felt.reverse, settled: () => setFelt(f => settleReplay(replay, f, felt.input)) };
  return <PokerTable replay={playback} table={measuring ? before : felt.table} serverNow={Date.now()} actorWindowOpen={replay.steps[drawn]?.kind === 'decision'} handOpen={false} choosing={false} openSeat={ignore} openParticipant={ignore} />;
}
