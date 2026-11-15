import type { KeyboardEvent } from 'react';
import type { TimingPath } from '@poker/contracts';
import { SavedEditsSection, type SavedEdits } from './motion-lab-saved-ui.js';
import { nudged, sliderMax, type Edits, type TimingGroup } from './motion-lab-edits.js';

/**
 * The motion lab's side column (ADR-0040): every table timing with its description, a millisecond field and a slider,
 * grouped like the timing file; and each phase's total beside it. It edits nothing itself: it reports each change.
 */

const GROUP_LABEL: Record<string, string> = { deal: 'Deal', street: 'Street reveal', showdown: 'Showdown', payout: 'Payout', settle: 'Settles', nextHandCountdownMs: 'Next-Hand Countdown', motion: 'Motion' };
const seconds = (ms: number) => `${(ms / 1000).toFixed(2)} s`;
/** `deal.cardFlight` as "Card flight"; `settle.payout.online` as "Payout online". */
const nameOf = (path: TimingPath) => {
  const text = path.split('.').slice(1).join(' ').replace(/([A-Z])/g, ' $1').toLowerCase();
  return text ? text[0]!.toUpperCase() + text.slice(1) : 'Length';
};

export interface TimingPanelProps {
  readonly groups: readonly TimingGroup[];
  readonly edits: Edits;
  readonly saved: SavedEdits;
  readonly onEdit: (path: TimingPath, value: number) => void;
  readonly totals: readonly { readonly label: string; readonly ms: number }[];
  /** The selected block's index in `totals`, or null. */
  readonly selected: number | null;
  readonly onSelect: (index: number | null) => void;
  /** Told which timing the pointer or focus is on, or null: hovering lights the beats it directly sets. */
  readonly hovered: (path: TimingPath | null) => void;
  /** The timings that set the selected beat. */
  readonly marked: readonly TimingPath[];
}

function TimingRow({ path, note, committed, edits, onEdit, hovered, marked }: { path: TimingPath; note: string; committed: number; edits: Edits; onEdit: TimingPanelProps['onEdit']; hovered: TimingPanelProps['hovered']; marked: boolean }) {
  const changed = path in edits, value = edits[path] ?? committed, max = Math.max(sliderMax(path), value);
  const onKey = (event: KeyboardEvent) => {
    const direction = event.key === 'ArrowUp' || event.key === 'ArrowRight' ? 1 : event.key === 'ArrowDown' || event.key === 'ArrowLeft' ? -1 : 0;
    if (!direction) return;
    event.preventDefault();
    onEdit(path, nudged(value, direction, event.shiftKey));
  };
  return <li className={`lab-timing${changed ? ' is-changed' : ''}${marked ? ' is-setting' : ''}`} data-timing={path} onPointerEnter={() => hovered(path)} onPointerLeave={() => hovered(null)} onFocus={() => hovered(path)} onBlur={() => hovered(null)}>
    <div className="lab-timing-head">
      <span className="lab-timing-name">{nameOf(path)}{changed && <span className="lab-changed" title={`Committed: ${committed} ms`}>changed</span>}</span>
      <span className="lab-timing-ms">
        <input type="number" min={0} step={10} value={value} aria-label={`${path} in milliseconds`} onKeyDown={onKey} onChange={event => onEdit(path, Number(event.target.value) || 0)} />
        <span aria-hidden="true">ms</span>
        <button type="button" className="lab-reset" disabled={!changed} aria-label={`Reset ${path} to ${committed} ms`} title={`Reset to ${committed} ms`} onClick={() => onEdit(path, committed)}>Reset</button>
      </span>
    </div>
    <input type="range" className="lab-slider" min={0} max={max} step={10} value={value} aria-label={`${path} slider`} onKeyDown={onKey} onChange={event => onEdit(path, Number(event.target.value))} />
    <p className="lab-timing-note">{note}</p>
  </li>;
}

export function TimingPanel({ groups, edits, saved, onEdit, totals, selected, onSelect, hovered, marked }: TimingPanelProps) {
  const count = Object.keys(edits).length;
  return <aside className="lab-panel" aria-label="Timings">
    <section className="lab-totals" aria-label="Phase totals">
      <h2>Phase totals</h2>
      <ul>{totals.map((t, i) => <li key={i}><button type="button" aria-pressed={selected === i} onClick={() => onSelect(selected === i ? null : i)}><span>{t.label}</span><strong>{seconds(t.ms)}</strong></button></li>)}</ul>
    </section>
    <SavedEditsSection saved={saved} />
    <div className="lab-panel-head">
      <h2>Timings</h2>
      <span className="lab-panel-meta">{selected === null ? 'All phases' : `For ${totals[selected]!.label.toLowerCase()}`}{count > 0 && ` · ${count} changed`}</span>
      {selected !== null && <button type="button" className="lab-clear" onClick={() => onSelect(null)}>Show all</button>}
    </div>
    <div className="lab-panel-list">
      {groups.map(g => <section key={g.id} className="lab-group">
        <h3>{GROUP_LABEL[g.id] ?? g.id}</h3>
        <ul>{g.timings.map(t => <TimingRow key={t.path} {...t} edits={edits} onEdit={onEdit} hovered={hovered} marked={marked.includes(t.path)} />)}</ul>
      </section>)}
    </div>
  </aside>;
}
