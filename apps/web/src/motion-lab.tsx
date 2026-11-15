import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent, type Ref } from 'react';
import { flushSync } from 'react-dom';
import type { TableMode } from '@poker/contracts';
import { PokerTable } from './poker-table.js';
import { actionWindowOpen, deadlineCountdown, presentTable } from './presentation.js';
import { nextHandStatus } from './online-status.js';
import { lanes, motionLab, scenarios, type LabBlock, type LabBeat, type Lane, type MotionLab, type ScenarioId } from './motion-lab-model.js';
import { blockTimings, effectiveTimings, listedTimings, phaseTotals } from './motion-lab-edits.js';
import { useSavedEdits } from './motion-lab-saved-ui.js';
import { TimingPanel } from './motion-lab-timings.js';
import './motion-lab.css';

/**
 * The motion lab (ADR-0040): a development-only page. It plays a scripted Hand on the real poker table on a virtual
 * clock, with no server, and draws the Hand's phases and beats on a timeline under it. Speed, scrubbing, stepping and
 * looping act on that clock only; the timings themselves are never touched here.
 */

const FRAME = 1000 / 60;
const SPEEDS = [0.1, 0.25, 0.5, 1] as const;
const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));
const seconds = (ms: number) => `${(ms / 1000).toFixed(2)} s`;

interface LabTableHandle { moveTo(time: number): void }

/**
 * The real table at a virtual time. Moving forward steps through every instant the table's presentation changes on the
 * way, so its motion is planned as it would have been; moving backward starts the table afresh and replays to the time.
 */
function LabTable({ lab, handle }: { lab: MotionLab; handle: Ref<LabTableHandle> }) {
  const [shown, setShown] = useState({ epoch: 0, clock: 0 }), at = useRef(shown);
  useImperativeHandle(handle, () => ({
    moveTo(time) {
      const go = (next: typeof at.current) => { at.current = next; flushSync(() => setShown(next)); };
      if (time < at.current.clock) go({ epoch: at.current.epoch + 1, clock: 0 });
      for (const b of lab.breakpoints) if (b > at.current.clock && b < time) go({ epoch: at.current.epoch, clock: b });
      if (time !== at.current.clock) go({ epoch: at.current.epoch, clock: time });
    },
  }), [lab]);
  const now = shown.clock, committed = lab.viewAt(now), presented = presentTable(committed, now);
  // A new id per replay: the table keeps no memory of an earlier run (the choreography remembers tables by id).
  const table = { ...presented, tableSessionId: `motion-lab-${shown.epoch}` };
  return <PokerTable key={shown.epoch} table={table} serverNow={now} driven handOpen={false} choosing={false} openSeat={() => {}} openParticipant={() => {}}
    actorWindowOpen={actionWindowOpen(committed, committed.view.state.actorId ?? undefined, now)} countdown={deadlineCountdown(committed, now)} nextHand={nextHandStatus(committed, now)} />;
}

/** The beats of a lane, each in the first row of the lane where it fits. */
function packed(beats: readonly LabBeat[]): { readonly beat: LabBeat; readonly row: number }[] {
  const ends: number[] = [];
  return beats.map(beat => {
    let row = ends.findIndex(end => end <= beat.startsAt);
    if (row < 0) row = ends.length;
    ends[row] = beat.endsAt;
    return { beat, row };
  });
}

export function MotionLabPage() {
  const [scenario, setScenario] = useState<ScenarioId>('heads-up'), [mode, setMode] = useState<TableMode>('practice'), [gap, setGap] = useState(600);
  const saved = useSavedEdits(), edits = saved.edits;
  const timings = useMemo(() => effectiveTimings(edits), [edits]);
  const lab = useMemo(() => motionLab({ scenario, mode, actionGapMs: gap, timings }), [scenario, mode, gap, timings]);
  const [time, setTime] = useState(0), [playing, setPlaying] = useState(false), [speed, setSpeed] = useState<number>(1), [loop, setLoop] = useState(false), [selected, setSelected] = useState<number | null>(null);
  const table = useRef<LabTableHandle>(null), clock = useRef(0), tracks = useRef<HTMLDivElement>(null);
  const block = selected === null ? undefined : lab.blocks[selected];
  const region = loop && block ? block : { startsAt: 0, endsAt: lab.totalMs };

  const seek = useCallback((to: number) => {
    const next = clamp(to, 0, lab.totalMs);
    clock.current = next;
    setTime(next);
    table.current?.moveTo(next);
  }, [lab]);

  // An edit that shortens the script can leave the playhead past its end.
  useEffect(() => { if (clock.current > lab.totalMs) seek(lab.totalMs); }, [lab, seek]);

  // A different scenario, mode or gap is a different script: start it from the top.
  const script = `${scenario}|${mode}|${gap}`;
  const [seen, setSeen] = useState(script);
  if (seen !== script) { setSeen(script); setTime(0); setPlaying(false); setSelected(null); setLoop(false); clock.current = 0; }

  // The virtual clock: real elapsed time times the speed. Past the region's end it stops, or wraps when looping.
  const live = useRef({ speed, region, seek });
  live.current = { speed, region, seek };
  useEffect(() => {
    if (!playing) return;
    let frame = 0, last = performance.now();
    const tick = (nowMs: number) => {
      const { speed: rate, region: span, seek: to } = live.current;
      const next = clock.current + (nowMs - last) * rate;
      last = nowMs;
      if (next >= span.endsAt) {
        if (loop) to(span.startsAt); else { to(span.endsAt); setPlaying(false); return; }
      } else to(next);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, loop]);

  const play = () => {
    if (playing) { setPlaying(false); return; }
    if (clock.current < region.startsAt || clock.current >= region.endsAt) seek(region.startsAt);
    setPlaying(true);
  };
  const step = (frames: number) => { setPlaying(false); seek(clock.current + frames * FRAME); };

  const timeAt = (event: PointerEvent) => {
    const box = tracks.current?.getBoundingClientRect();
    return box ? clamp((event.clientX - box.left) / box.width, 0, 1) * lab.totalMs : 0;
  };
  const scrub = useRef(false);
  const onKey = (event: KeyboardEvent) => {
    const big = event.shiftKey ? 10 : 1;
    if (event.key === 'ArrowRight') step(big); else if (event.key === 'ArrowLeft') step(-big);
    else if (event.key === 'Home') seek(0); else if (event.key === 'End') seek(lab.totalMs);
    else if (event.key === ' ') play();
    else return;
    event.preventDefault();
  };

  const byLane = useMemo(() => new Map<Lane, ReturnType<typeof packed>>(lanes.map(({ id }) => [id, packed(lab.beats.filter(b => b.lane === id))])), [lab]);
  const percent = (ms: number) => `${(ms / lab.totalMs) * 100}%`;
  const ticks = Array.from({ length: Math.floor(lab.totalMs / 1000) + 1 }, (_, i) => i * 1000);

  return <div className="lab">
    <header className="lab-bar">
      <h1>Motion lab</h1>
      <label className="lab-field"><span>Scenario</span><select value={scenario} onChange={event => setScenario(event.target.value as ScenarioId)}>{scenarios.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}</select></label>
      <div className="lab-segments" role="group" aria-label="Table mode">{(['practice', 'online'] as const).map(m => <button key={m} type="button" aria-pressed={mode === m} onClick={() => setMode(m)}>{m === 'practice' ? 'Practice' : 'Online'}</button>)}</div>
      <label className="lab-field"><span>Time before each action</span><span className="lab-unit"><input type="number" min={0} step={50} value={gap} onChange={event => setGap(Math.max(0, Number(event.target.value) || 0))} /> ms</span></label>
    </header>

    <div className="lab-workbench">
    <div className="lab-main">
    <div className="lab-table"><LabTable key={script} lab={lab} handle={table} /></div>

    <section className="lab-timeline" aria-label="Timeline">
      <div className="lab-transport">
        <div className="lab-buttons">
          <button type="button" className="lab-icon" aria-label="Step back one frame" onClick={() => step(-1)}>Back</button>
          <button type="button" className="lab-play primary" onClick={play}>{playing ? 'Pause' : 'Play'}</button>
          <button type="button" className="lab-icon" aria-label="Step forward one frame" onClick={() => step(1)}>Next</button>
        </div>
        <output className="lab-time" aria-label="Playhead time"><strong>{seconds(time)}</strong> / {seconds(lab.totalMs)}</output>
        <button type="button" className="lab-loop" aria-pressed={loop} disabled={!block} title={block ? undefined : 'Select a phase first'} onClick={() => setLoop(!loop)}>{block ? `Loop ${block.label.toLowerCase()}` : 'Loop phase'}</button>
        <div className="lab-segments lab-speeds" role="group" aria-label="Speed">{SPEEDS.map(s => <button key={s} type="button" aria-pressed={speed === s} onClick={() => setSpeed(s)}>{s}×</button>)}</div>
      </div>

      <div className="lab-grid">
        <div className="lab-labels" aria-hidden="true">
          <span className="lab-label lab-label-ruler" />
          <span className="lab-label lab-label-band">Phases</span>
          {lanes.map(({ id, label }) => <span key={id} className="lab-label" style={{ height: `${(Math.max(...byLane.get(id)!.map(p => p.row), 0) + 1) * 16 + 8}px` }}>{label}</span>)}
        </div>
        <div className="lab-tracks" ref={tracks}
          onPointerDown={event => { if ((event.target as HTMLElement).closest('.lab-block')) return; scrub.current = true; event.currentTarget.setPointerCapture(event.pointerId); setPlaying(false); seek(timeAt(event)); }}
          onPointerMove={event => { if (scrub.current) seek(timeAt(event)); }}
          onPointerUp={() => { scrub.current = false; }} onPointerCancel={() => { scrub.current = false; }}>
          <div className="lab-ruler" aria-hidden="true">{ticks.map(t => <span key={t} style={{ left: percent(t) }}>{t / 1000}s</span>)}</div>
          <div className="lab-band">{lab.blocks.map((b: LabBlock, i) => <button key={i} type="button" className={`lab-block lab-block-${b.kind}`} aria-pressed={selected === i} title={`${b.label}: ${seconds(b.startsAt)} to ${seconds(b.endsAt)}`}
            style={{ left: percent(b.startsAt), width: percent(b.endsAt - b.startsAt) }} onClick={() => setSelected(selected === i ? null : i)}><span>{b.label}</span></button>)}</div>
          {lanes.map(({ id }) => {
            const rows = byLane.get(id)!, height = (Math.max(...rows.map(p => p.row), 0) + 1) * 16 + 8;
            return <div key={id} className={`lab-lane lab-lane-${id}`} style={{ height }}>
              {rows.map(({ beat, row }, i) => <span key={i} className="lab-beat" title={`${beat.label}: ${seconds(beat.startsAt)} to ${seconds(beat.endsAt)}`} style={{ left: percent(beat.startsAt), width: percent(Math.max(beat.endsAt - beat.startsAt, 12)), top: 4 + row * 16 }} />)}
            </div>;
          })}
          {block && loop && <div className="lab-loop-region" style={{ left: percent(block.startsAt), width: percent(block.endsAt - block.startsAt) }} aria-hidden="true" />}
          <div className="lab-playhead" role="slider" tabIndex={0} aria-label="Playhead" aria-valuemin={0} aria-valuemax={Math.round(lab.totalMs)} aria-valuenow={Math.round(time)} aria-valuetext={seconds(time)} style={{ left: percent(time) }} onKeyDown={onKey} />
        </div>
      </div>
    </section>
    </div>
    <TimingPanel groups={listedTimings(selected === null ? undefined : blockTimings(lab.blocks, selected, mode))} edits={edits} saved={saved} onEdit={saved.edit} totals={phaseTotals(lab.blocks)} selected={selected} onSelect={setSelected} />
    </div>
  </div>;
}
