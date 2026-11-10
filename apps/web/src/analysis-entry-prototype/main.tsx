// PROTOTYPE (throwaway): where does the "open analysis" control live at a table? Four variants, synthetic data, no API.
// Run: pnpm --filter @poker/web dev, then open /analysis-entry-prototype.html?variant=A|B|C|D
import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../styles.css';
import './prototype.css';
import { Icon } from '../icons.js';

type Key = 'A' | 'B' | 'C' | 'D';
const names: Record<Key, string> = { A: 'Edge tab', B: 'Tool rail', C: 'Live dock', D: 'Hand timeline' };
const keys = Object.keys(names) as Key[];

const decisions = [
  { street: 'Preflop', you: 'Raise 60', grade: 'good', note: 'Standard open from the button.' },
  { street: 'Flop', you: 'Bet 90', grade: 'good', note: 'Value bet; villain calls too wide.' },
  { street: 'Turn', you: 'Check', grade: 'miss', note: 'A bet of 40% pot earns more here.' },
  { street: 'River', you: 'Call 210', grade: 'ok', note: 'Close; priced at 28% equity needed.' },
] as const;

function Seat({ n, name, stack, hero }: { n: number; name: string; stack: string; hero?: boolean }) {
  return <div className={`pe-seat pe-seat-${n}${hero ? ' is-hero' : ''}`}><span className="pe-avatar" /><b>{name}</b><span>{stack}</span></div>;
}

function Table({ compact }: { compact: boolean }) {
  return <div className={`pe-stage${compact ? ' is-compact' : ''}`}>
    <div className="pe-felt"><div className="pe-board">{['A♠', 'K♦', '7♣', '2♥', ' '].map((c, i) => <i key={i} className={c.trim() ? 'pe-card' : 'pe-card pe-empty'}>{c}</i>)}</div><span className="pe-pot">Pot 420</span></div>
    <Seat n={1} name="You" stack="1,840" hero /><Seat n={2} name="Mara" stack="2,100" /><Seat n={3} name="Bot Ellis" stack="960" /><Seat n={4} name="Jun" stack="1,300" />
    <div className="pe-tray"><button>Fold</button><button>Call 210</button><button className="primary">Raise to 600</button></div>
  </div>;
}

function Panel({ close, focus }: { close: () => void; focus?: number }) {
  const [tab, setTab] = useState('Hand');
  return <aside className="pe-panel" aria-label="Analysis">
    <div className="pe-panel-head"><h2>Analysis</h2><button className="icon-button" aria-label="Close analysis" onClick={close}><Icon name="close" /></button></div>
    <div className="pe-tabs" role="tablist">{['Live', 'Hand', 'Session'].map(t => <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}>{t}</button>)}</div>
    <ol className="pe-decisions">{decisions.map((d, i) => <li key={d.street} className={focus === i ? 'is-focus' : ''}><span className="pe-street">{d.street}</span><strong>{d.you}</strong><span className={`pe-grade pe-${d.grade}`}>{d.grade === 'good' ? 'Best' : d.grade === 'ok' ? 'Close' : 'Missed value'}</span><p>{d.note}</p></li>)}</ol>
  </aside>;
}

const Toolbar = ({ children }: { children?: React.ReactNode }) => <div className="table-toolbar pe-toolbar"><div className="table-title"><h1>4-player table</h1><span>No-limit Hold’em · 10 / 20</span><span className="mode-badge mode-online">Online</span></div><div className="toolbar-actions">{children}</div></div>;

/* A: one vertical tab on the viewport edge. The toolbar keeps only Join link / Leave table. */
function VariantA() {
  const [open, setOpen] = useState(false);
  return <div className="pe-page"><main className={`pe-main${open ? ' with-panel' : ''}`}>
    <div className="pe-left"><Toolbar><button className="quiet-button">Join link</button><button className="quiet-button">Leave table</button><button className="icon-button" aria-label="Table options"><Icon name="settings" /></button></Toolbar><Table compact={open} /></div>
    {open && <Panel close={() => setOpen(false)} />}
    <button className={`pe-edge-tab${open ? ' is-open' : ''}`} aria-expanded={open} onClick={() => setOpen(!open)}><Icon name="chart" size={18} /><span>Analysis</span><Icon name="chevron" size={14} /></button>
  </main></div>;
}

/* B: a permanent icon rail on the right holds every table-level tool; the toolbar holds only the title. */
function VariantB() {
  const [open, setOpen] = useState(false);
  const tools = [{ id: 'analysis', icon: 'chart', label: 'Analysis' }, { id: 'link', icon: 'link', label: 'Join link' }, { id: 'settings', icon: 'settings', label: 'Table options' }] as const;
  return <div className="pe-page"><main className={`pe-main${open ? ' with-panel' : ''}`}>
    <div className="pe-left"><Toolbar /><Table compact={open} /></div>
    {open && <Panel close={() => setOpen(false)} />}
    <nav className="pe-rail" aria-label="Table tools">{tools.map(t => <button key={t.id} className={t.id === 'analysis' && open ? 'is-on' : ''} aria-pressed={t.id === 'analysis' ? open : undefined} onClick={() => t.id === 'analysis' && setOpen(!open)}><Icon name={t.icon} size={20} /><span className="pe-tip">{t.label}</span></button>)}<span className="pe-rail-fill" /><button className="pe-leave"><Icon name="arrow" size={20} /><span className="pe-tip">Leave table</span></button></nav>
  </main></div>;
}

/* C: a labelled dock that previews what analysis would say right now, so opening it is worth it. */
function VariantC() {
  const [open, setOpen] = useState(false);
  return <div className="pe-page"><main className={`pe-main${open ? ' with-panel' : ''}`}>
    <div className="pe-left"><Toolbar><button className="quiet-button">Join link</button><button className="icon-button" aria-label="Table options"><Icon name="settings" /></button></Toolbar><Table compact={open} /></div>
    {open && <Panel close={() => setOpen(false)} />}
    <aside className="pe-dock" aria-label="Table sidebar">
      <button className={`pe-dock-main${open ? ' is-on' : ''}`} aria-expanded={open} onClick={() => setOpen(!open)}><Icon name="chart" size={20} /><span><b>Analysis</b><small>{open ? 'Close' : '4 decisions this hand'}</small></span></button>
      {!open && <div className="pe-dock-peek"><span>Right now</span><strong>Call 210</strong><small>needs 28% · you have 41%</small></div>}
      <span className="pe-rail-fill" /><button className="pe-dock-leave">Leave table</button>
    </aside>
  </main></div>;
}

/* D: the sidebar is a timeline of this hand's decisions. Clicking one opens analysis on it. */
function VariantD() {
  const [focus, setFocus] = useState<number | null>(null);
  const open = focus !== null;
  return <div className="pe-page"><main className={`pe-main${open ? ' with-panel' : ''}`}>
    <div className="pe-left"><Toolbar><button className="quiet-button">Join link</button><button className="quiet-button">Leave table</button><button className="icon-button" aria-label="Table options"><Icon name="settings" /></button></Toolbar><Table compact={open} /></div>
    {open && <Panel close={() => setFocus(null)} focus={focus} />}
    <nav className="pe-timeline" aria-label="This hand's decisions">
      <button className="pe-tl-head" aria-label="Analysis" onClick={() => setFocus(open ? null : decisions.length - 1)}><Icon name="chart" size={18} /></button>
      {decisions.map((d, i) => <button key={d.street} className={`pe-dot pe-${d.grade}${focus === i ? ' is-on' : ''}`} aria-label={`${d.street}: ${d.you}`} onClick={() => setFocus(i)}><i /><span className="pe-tip">{d.street} · {d.you}</span></button>)}
      <span className="pe-dot pe-now" aria-label="Your turn now"><i /></span>
    </nav>
  </main></div>;
}

const views: Record<Key, () => React.ReactElement> = { A: VariantA, B: VariantB, C: VariantC, D: VariantD };

function App() {
  const [variant, setVariant] = useState<Key>(() => (keys as string[]).includes(new URLSearchParams(location.search).get('variant') ?? '') ? new URLSearchParams(location.search).get('variant') as Key : 'A');
  const go = (v: Key) => { setVariant(v); history.replaceState(null, '', `?variant=${v}`); };
  const cycle = (s: number) => go(keys[(keys.indexOf(variant) + s + keys.length) % keys.length]!);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if ((e.target as HTMLElement).closest('input, textarea, select, [contenteditable]')) return; if (e.key === 'ArrowLeft') cycle(-1); if (e.key === 'ArrowRight') cycle(1); };
    addEventListener('keydown', onKey); return () => removeEventListener('keydown', onKey);
  });
  const View = views[variant];
  return <><View key={variant} />{import.meta.env.DEV && <div className="sd-switcher" role="toolbar" aria-label="Prototype controls"><button aria-label="Previous" onClick={() => cycle(-1)}><span className="sd-flip"><Icon name="chevron" size={16} /></span></button><span className="sd-switcher-label"><b>{variant}</b> {names[variant]}</span><button aria-label="Next" onClick={() => cycle(1)}><Icon name="chevron" size={16} /></button></div>}</>;
}
createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
