import { useLayoutEffect, useState, type RefObject } from 'react';
import type { LabBeat } from './motion-lab-model.js';
import type { BeatSelection } from './motion-lab-annotations.js';

/**
 * The motion lab's beat bars and what they say (ADR-0040): each beat a button on its lane, pulsing after an edit that
 * directly sets it, lit while its timing is hovered, and selected to show what it follows and its formulas. Which beats
 * pulse, light or select is decided by the pure annotations; this only draws them.
 */

const seconds = (ms: number) => `${(ms / 1000).toFixed(2)} s`;
const ms = (value: number) => `${Math.round(value)} ms`;

export interface BeatBarsProps {
  readonly rows: readonly { readonly beat: LabBeat; readonly row: number }[];
  readonly totalMs: number;
  readonly pulsed: ReadonlySet<number>;
  /** Bumped on every edit, so a beat that pulses again restarts its pulse. */
  readonly pulseSeq: number;
  readonly lit: ReadonlySet<number>;
  readonly selected: number | null;
  readonly onSelect: (id: number | null) => void;
}

export function BeatBars({ rows, totalMs, pulsed, pulseSeq, lit, selected, onSelect }: BeatBarsProps) {
  const percent = (value: number) => `${(value / totalMs) * 100}%`;
  return <>{rows.map(({ beat, row }) => {
    const pulsing = pulsed.has(beat.id);
    return <button key={pulsing ? `${beat.id}-${pulseSeq}` : beat.id} type="button" data-beat={beat.id}
      className={`lab-beat${pulsing ? ' is-pulsing' : ''}${lit.has(beat.id) ? ' is-lit' : ''}`} aria-pressed={selected === beat.id}
      aria-label={`${beat.label}, ${seconds(beat.startsAt)} to ${seconds(beat.endsAt)}`} title={`${beat.label}: ${seconds(beat.startsAt)} to ${seconds(beat.endsAt)}`}
      style={{ left: percent(beat.startsAt), width: percent(Math.max(beat.endsAt - beat.startsAt, 12)), top: 4 + row * 16 }}
      onClick={() => onSelect(selected === beat.id ? null : beat.id)} />;
  })}</>;
}

interface Line { readonly width: number; readonly height: number; readonly anchor: { x: number; y: number } | null; readonly from: { x: number; y: number }; readonly to: { x: number; y: number } }

/** The line from what the selected beat follows to the beat's start: its gap. Measured from the drawn bars, so it always meets them. */
export function BeatLink({ tracks, selection, totalMs, layout }: { tracks: RefObject<HTMLDivElement | null>; selection: BeatSelection | null; totalMs: number; layout: unknown }) {
  const [line, setLine] = useState<Line | null>(null);
  useLayoutEffect(() => {
    const measure = () => {
      const box = tracks.current;
      const bar = selection && box?.querySelector<HTMLElement>(`[data-beat="${selection.beat.id}"]`);
      if (!selection || !box || !bar) { setLine(null); return; }
      const outer = box.getBoundingClientRect(), mine = bar.getBoundingClientRect();
      const midY = (rect: DOMRect) => rect.top - outer.top + rect.height / 2;
      const target = selection.follows.target && box.querySelector<HTMLElement>(`[data-beat="${selection.follows.target.id}"]`);
      const x = outer.width * (selection.follows.at / totalMs), to = { x: mine.left - outer.left, y: midY(mine) };
      setLine({ width: outer.width, height: outer.height, anchor: target ? null : { x, y: 0 }, from: { x, y: target ? midY(target.getBoundingClientRect()) : to.y }, to });
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [tracks, selection, totalMs, layout]);
  if (!line || !selection) return null;
  const { from, to, anchor } = line, bend = from.y === to.y ? `${from.x},${from.y} ${to.x},${to.y}` : `${from.x},${from.y} ${from.x},${to.y} ${to.x},${to.y}`;
  return <svg className="lab-link" width={line.width} height={line.height} aria-hidden="true">
    {anchor && <line className="lab-link-anchor" x1={anchor.x} x2={anchor.x} y1={0} y2={line.height} />}
    <polyline className="lab-link-line" points={bend} fill="none" />
    <circle className="lab-link-dot" cx={from.x} cy={from.y} r={3} />
    {to.x - from.x > 30 && <text className="lab-link-text" x={(from.x + to.x) / 2} y={to.y - 6} textAnchor="middle">gap</text>}
  </svg>;
}

/** The selected beat's anchor, gap and length with their formulas, and the timings that set it. */
export function BeatDetail({ selection, onClose }: { selection: BeatSelection; onClose: () => void }) {
  const { beat, follows } = selection, gapMs = beat.startsAt - follows.at;
  return <section className="lab-detail" aria-label="Selected beat">
    <header>
      <h2>{beat.label}</h2>
      <span className="lab-detail-when">{seconds(beat.startsAt)} to {seconds(beat.endsAt)}</span>
      <button type="button" className="lab-clear" onClick={onClose}>Clear</button>
    </header>
    <dl>
      <dt>Follows</dt>
      <dd>{follows.text}{follows.target && <> ({follows.target.label})</>}</dd>
      <dt>Gap</dt>
      <dd><code>{selection.gap}</code> <span className="lab-detail-ms">{ms(gapMs)}</span></dd>
      <dt>Length</dt>
      <dd><code>{selection.length}</code> <span className="lab-detail-ms">{ms(beat.endsAt - beat.startsAt)}</span></dd>
      <dt>Set by</dt>
      <dd>{selection.setBy.length ? selection.setBy.map(path => <code key={path} className="lab-chip">{path}</code>) : 'No timing'}</dd>
    </dl>
    {selection.note && <p className="lab-detail-note">{selection.note}</p>}
  </section>;
}
