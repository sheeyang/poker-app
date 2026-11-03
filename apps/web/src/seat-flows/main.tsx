import { StrictMode, useEffect, useId, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AfterPreview } from './after-preview.js';
import { Field, Icon } from './ui.js';
import './styles.css';

type Scenario = { title: string; short: string; priority: string; context: string; gesture: string; before: string; after: string; principle: string };
const scenarios: Scenario[] = [
  { title: 'Rebuy from the tray', short: 'Rebuy', priority: 'High impact', context: 'You’re out of chips. The hand has ended.', gesture: 'Click Rebuy in the tray', before: 'A familiar action opens an unfamiliar detour. Expand your player row, find the amount, then rebuy.', after: 'One task, one dialog. Your starting stack is already filled in, ready to confirm.', principle: 'Carry the intent forward.' },
  { title: 'Move to an empty seat', short: 'Move seat', priority: 'High impact', context: 'You’re in seat 1. Seat changes are allowed; no hand is running.', gesture: 'Click empty seat 4', before: 'The seat you clicked is forgotten. Open your row and choose seat 4 again from a dropdown.', after: 'Clicking the seat opens its menu. Choose Move here to move deliberately, keeping your stack.', principle: 'A seat click opens a choice.' },
  { title: 'Add a Bot to a seat', short: 'Add a Bot', priority: 'High impact', context: 'You’re the seated Table Owner. You want a Bot in seat 4.', gesture: 'Click empty seat 4', before: 'Table options opens. Find Add a Bot, then replace “First open seat” with the seat you clicked.', after: 'The owner’s menu offers Move here and Add a Bot here. Choose Add a Bot here; the form remembers the seat.', principle: 'Ask for intent. Remember the seat.' },
  { title: 'Manage participants directly', short: 'Participant actions', priority: 'Small fix', context: 'You’re watching. Click You for your actions, or a player at the table for theirs.', gesture: 'Before: open You in Table options · After: click You', before: 'Participant controls live inside Table options, including another seat form.', after: 'Your actions open beside you. Choose a seat highlights the table; seated players and Bots have their own contextual actions.', principle: 'Click the person you want to manage.' },
  { title: 'Top up from your participant', short: 'Top-up', priority: 'Small fix', context: 'Your stack is 2,010 chips. The maximum buy-in is 4,000.', gesture: 'Before: open your row in Table options · After: click You', before: 'The default 2,000 is below your current stack. Correct the amount before the button works.', after: 'Choose Top up from your menu. The amount starts at 4,000, adding 1,990 chips. Participant controls stay on the table.', principle: 'Keep the action beside its participant.' },
  { title: 'The same flow for the last seat', short: 'Last open seat', priority: 'Polish', context: 'You’re watching. Seat 4 is the only open seat.', gesture: 'Before: Choose a seat · After: click the open +', before: 'The picker asks you to choose from one seat. There is no decision left to make.', after: 'Click the open +, choose Take this seat, and confirm the buy-in. No separate seat picker or redundant Choose a seat button.', principle: 'One seat or several. One interaction.' },
  { title: 'Return straight to the table', short: 'Join link', priority: 'Polish', context: 'You open a Join Link for a table you have already joined.', gesture: 'Open the Join Link', before: 'An “already at this table” card makes you click Open table before you can continue.', after: 'Your existing Participant is recognized. The link opens the table directly.', principle: 'Recognition should remove a step.' },
];

function App() {
  const [selected, setSelected] = useState(0);
  const [version, setVersion] = useState<'before' | 'after'>('after');
  const [run, setRun] = useState(0);
  const scenario = scenarios[selected]!;
  return <>
    <header className="masthead flex items-center justify-between gap-4">
      <a href="/seat-flows.html" className="brand flex items-center gap-3"><span className="brand-mark"><Icon name="spade" size={23} /></span><strong>Poker</strong><span className="brand-divider" /><span>Interaction study</span></a>
      <span className="demo-label"><span className="status-dot" />Interactive prototype</span>
    </header>
    <div className="workspace">
      <aside className="sidebar">
        <div className="sidebar-heading"><h2>Table shortcuts</h2><p>Seven changes, in priority order.</p></div>
        <nav aria-label="Scenarios by priority">{scenarios.map((s, i) => <button key={s.short} className={`scenario-button ${selected === i ? 'selected' : ''}`} aria-current={selected === i ? 'true' : undefined} onClick={() => { setSelected(i); setRun(0); }}>
          <span className="priority-number">{i + 1}</span><span><strong>{s.short}</strong><small>{s.priority}</small></span><Icon name="chevron" size={14} />
        </button>)}</nav>
        <div className="sidebar-note"><Icon name="spade" size={23} /><p>Less setup.<br />More time at the table.</p></div>
      </aside>
      <main>
        <div className="page-heading flex flex-wrap items-end justify-between gap-4"><div><h1>Same table. Fewer steps.</h1><p>Let the interface remember what the player already told it.</p></div><button className="quiet replay" onClick={() => setRun(v => v + 1)}><Icon name="reset" size={15} />Replay both</button></div>
        <section className="scenario-intro"><div className="flex flex-wrap items-center gap-3"><span className="priority-tag">Priority {selected + 1} of 7</span><h2>{scenario.title}</h2></div><p>{scenario.context}</p><div className="gesture"><span className="gesture-dot" />{scenario.gesture}</div></section>
        <div className="mobile-switch" aria-label="Comparison version">{(['before', 'after'] as const).map(v => <button key={v} aria-pressed={version === v} onClick={() => setVersion(v)}>{v === 'before' ? 'Before' : 'After'}</button>)}</div>
        <div className={`comparison show-${version}`}>
          {(['before', 'after'] as const).map(v => <section className={`version ${v}`} key={`${selected}-${run}-${v}`} aria-label={`${v === 'before' ? 'Before' : 'After'}: ${scenario.title}`}>
            <div className="version-heading flex items-center justify-between"><h3>{v === 'before' ? 'Before' : 'After'}</h3><span>{v === 'before' ? 'Current flow' : 'Proposed flow'}{v === 'after' && <Icon name="check" size={14} />}</span></div>
            {v === 'after' ? <AfterPreview index={selected} /> : <Simulation index={selected} improved={false} />}
            <p className="version-description">{scenario[v]}</p>
          </section>)}
        </div>
        <div className="takeaway flex items-center justify-between gap-4"><div><h2>{scenario.principle}</h2></div><button className="quiet" onClick={() => { setSelected((selected + 1) % scenarios.length); setRun(0); }}>{selected === 6 ? 'Back to Rebuy' : 'Next change'}<Icon name="arrow" /></button></div>
        <footer className="flex flex-wrap items-center justify-between gap-2"><span>Demo data · Actions stay in this prototype</span><span>React / Vite / Tailwind</span></footer>
      </main>
    </div>
  </>;
}

function Simulation({ index, improved }: { index: number; improved: boolean }) {
  const id = useId();
  const initial = index === 6 ? improved ? 'table' : 'join' : index === 3 || index === 4 || !improved && index < 3 ? 'options' : 'task';
  const [panel, setPanel] = useState(initial);
  const [expanded, setExpanded] = useState(index === 3 || index === 4);
  const [botExpanded, setBotExpanded] = useState(false);
  const [amount, setAmount] = useState(index === 4 && improved ? '4000' : '2000');
  const [seat, setSeat] = useState(improved || index === 5 ? '4' : '2');
  const [botSeat, setBotSeat] = useState(improved ? '4' : '');
  const [botName, setBotName] = useState('Bot 3');
  const [strategy, setStrategy] = useState('Uniform Choice · Probability Selector');
  const [done, setDone] = useState('');
  const [actions, setActions] = useState(index === 6 && improved ? 0 : 1);
  const [stack, setStack] = useState(index === 0 ? 0 : index === 4 ? 2010 : 2000);
  const [heroSeat, setHeroSeat] = useState(index === 3 || index === 5 ? 0 : 1);
  const [botAdded, setBotAdded] = useState(false);
  const [botStack, setBotStack] = useState(2000);
  const [attempted, setAttempted] = useState(false);
  const panelRef = useRef<HTMLElement>(null);
  const simulationRef = useRef<HTMLDivElement>(null);
  const lastTrigger = useRef<HTMLElement | null>(null);
  const previousPanel = useRef(panel);
  useEffect(() => {
    if (previousPanel.current === panel) return;
    if (panel === 'table') {
      const trigger = lastTrigger.current;
      if (trigger?.isConnected) trigger.focus();
      else simulationRef.current?.querySelector<HTMLButtonElement>('.action-tray .primary')?.focus();
    }
    else {
      const active = document.activeElement;
      if (active instanceof HTMLElement && simulationRef.current?.contains(active)) lastTrigger.current = active;
      const control = panelRef.current?.querySelector<HTMLElement>('input:not(:disabled), select:not(:disabled), button.primary, button.player-toggle, button.disclosure');
      (control ?? panelRef.current)?.focus();
    }
    previousPanel.current = panel;
  }, [panel]);
  const topUp = index === 4;
  const min = topUp ? 2011 : 400;
  const valid = amount.trim() !== '' && Number.isSafeInteger(Number(amount)) && Number(amount) >= min && Number(amount) <= 4000;
  const count = () => setActions(a => a + 1);
  const finish = (message: string) => { count(); setDone(message); setPanel('table'); };
  function launch(target = '4') {
    count(); setDone(''); setAttempted(false);
    if (index === 6) { setPanel(improved ? 'table' : 'join'); return; }
    if (improved && (index === 1 || index === 2)) { setSeat(target); setBotSeat(target); }
    if (index === 3 || index === 4 || !improved && index < 3) setPanel('options');
    else setPanel('task');
  }
  const submitMoney = () => { if (valid) { setStack(Number(amount)); finish(topUp ? `Stack topped up to ${Number(amount).toLocaleString()} chips.` : `Rebought to ${Number(amount).toLocaleString()} chips. You’re in for the next hand.`); } };
  const submitSeat = () => { if (valid) { setHeroSeat(Number(seat)); setStack(Number(amount)); finish(`You’re in seat ${seat} with ${Number(amount).toLocaleString()} chips.`); } };
  const submitBot = () => {
    setAttempted(true);
    if (!valid || !botName.trim()) return;
    setBotStack(Number(amount)); setBotAdded(true); finish(`${botName.trim()} added to seat ${botSeat || '2'}.`);
  };
  const moneyField = (label: string) => <Field label={label} hint={`${min.toLocaleString()}–4,000 chips${topUp && improved && valid ? ` · Adds ${(Number(amount) - 2010).toLocaleString()} chips` : ''}`}><input aria-label={label} type="number" inputMode="numeric" step="1" min={min} max={4000} required value={amount} aria-invalid={!valid} onChange={e => setAmount(e.target.value)} /></Field>;
  const seatField = (label = 'Seat') => <Field label={label}><select value={seat} onChange={e => { count(); setSeat(e.target.value); }}>{(index === 5 ? ['4'] : ['2', '4', '6']).map(s => <option key={s} value={s}>{s}</option>)}</select></Field>;
  const botForm = <form className="form-stack" onSubmit={e => { e.preventDefault(); submitBot(); }}>
    {improved && <p className="context-line">Seat {botSeat} is selected.</p>}
    <Field label="Name"><input value={botName} maxLength={20} required onChange={e => setBotName(e.target.value)} /></Field>
    <Field label="Playing Strategy"><select value={strategy} onChange={e => setStrategy(e.target.value)}><option>Uniform Choice · Probability Selector</option><option>Always Fold · Probability Selector</option></select></Field>
    <div className="form-grid">{moneyField('Buy-in · chips')}<Field label="Seat"><select value={botSeat} onChange={e => { count(); setBotSeat(e.target.value); }}>{!improved && <option value="">First open seat</option>}{['2', '4', '6'].map(s => <option key={s} value={s}>{s}</option>)}</select></Field></div>
    {attempted && !botName.trim() && <p className="field-error" role="alert">Enter a name for the Bot.</p>}
    <button className="primary" disabled={!valid || !botName.trim()}>Add Bot{improved ? ` to seat ${botSeat}` : ''}<Icon name="arrow" size={16} /></button>
  </form>;
  const taskTitle = index === 0 ? 'Rebuy' : index === 1 ? `Move to seat ${seat}?` : index === 2 ? 'Add a Bot' : index === 5 ? improved ? 'Take seat 4' : 'Take a seat' : 'Take a seat';
  return <>
    <div className="simulation" ref={simulationRef}>
      <div inert={panel !== 'table'}>
      <div className="sim-toolbar flex items-center justify-between"><div><strong>6-player table</strong><span>10 / 20 · Online</span></div><button className="sim-settings" aria-label="Open Table options" onClick={() => { count(); setPanel('options'); }}><Icon name="settings" size={18} /></button></div>
      <div className="table-area">
        <span className="hand-label">Between hands</span>
        <div className="felt"><div className="felt-copy"><Icon name="spade" size={22} /><span>No-limit Hold’em</span><strong>{done ? 'Ready for the next hand' : 'Waiting for the next hand'}</strong></div></div>
        {[1, 2, 3, 4, 5, 6].map(s => {
          const hero = s === heroSeat;
          const occupied = hero || s === 3 || s === 5 || index === 5 && s !== 4 || botAdded && s === Number(botSeat || '2');
          return <div className={`demo-seat seat-${s} ${hero ? 'hero-seat' : ''}`} key={s}>{occupied ? <div className="occupied-seat"><span className="avatar">{hero ? 'Y' : 'B'}</span><span><strong>{hero ? 'You' : botAdded && s === Number(botSeat || '2') ? botName : `Bot ${s === 3 ? 1 : s === 5 ? 2 : s + 1}`}</strong><small>{hero ? stack.toLocaleString() : botAdded && s === Number(botSeat || '2') ? botStack.toLocaleString() : '2,000'} chips</small></span></div> : <button className="open-seat" aria-label={`Click empty seat ${s}`} onClick={() => launch(String(s))}><strong>Seat {s}</strong><small>{improved && index === 1 ? 'Move here' : improved && index === 2 ? 'Add a Bot' : 'Open'}</small></button>}</div>;
        })}
      </div>
      <div className="action-tray"><div><strong>{index === 0 && !done ? 'You’re out of chips.' : heroSeat === 0 ? 'You’re watching.' : 'Ready when the table is.'}</strong><span>{index === 0 && !done ? 'Rebuy to be dealt into the next hand.' : 'Changes apply before the next hand.'}</span></div><button className="primary" onClick={() => launch()}>{index === 0 ? 'Rebuy' : index === 1 ? 'Move seat' : index === 2 ? 'Add a Bot' : index === 3 || index === 5 ? 'Choose a seat' : index === 4 ? 'Top up' : 'Open Join Link'}<Icon name="arrow" size={15} /></button></div>
      </div>
      {panel !== 'table' && <div className="panel-layer"><section ref={panelRef} tabIndex={-1} onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); setPanel('table'); } }} className={`demo-dialog ${panel === 'options' ? 'options-dialog' : ''}`} aria-labelledby={`${id}-heading`}>
        <div className="dialog-heading flex items-center justify-between"><h4 id={`${id}-heading`}>{panel === 'options' ? 'Table options' : panel === 'join' ? 'You’re already at this table.' : taskTitle}</h4><button className="close-button" aria-label="Close panel" onClick={() => { count(); setPanel('table'); }}><Icon name="close" size={18} /></button></div>
        <div className="dialog-content">
          {panel === 'join' ? <><p>You’ve already joined this Online Table. Your seat and history are waiting.</p><button className="primary" onClick={() => finish('Your existing table is open.')}>Open table<Icon name="arrow" size={16} /></button></> : panel === 'options' ? <>
            <div className="settings-summary"><span>Online · No-limit Hold’em</span><strong>10 / 20 chips</strong><small>6 seats · Seat changes allowed</small></div>
            <h5>Players</h5><p className="settings-hint">Buy-in 400–4,000 chips. Changes apply to the next hand.</p>
            <div className="player-row"><button className="player-toggle" aria-expanded={expanded} onClick={() => { count(); setExpanded(v => !v); }}><span><strong>You</strong><small>{heroSeat ? `Seat ${heroSeat} · ${stack.toLocaleString()} chips` : 'Not seated'}</small></span><span className={expanded ? 'rotated' : ''}><Icon name="chevron" size={16} /></span></button>
              {expanded && <div className="player-fields">{index === 3 ? improved ? <><p>Take an open seat to join the next hand.</p><button className="primary" onClick={() => { count(); setPanel('task'); }}>Choose a seat<Icon name="arrow" size={16} /></button></> : <form className="form-stack" onSubmit={e => { e.preventDefault(); submitSeat(); }}><div className="form-grid">{seatField()}{moneyField('Buy-in · chips')}</div><button className="secondary" disabled={!valid}>Take seat</button></form> : index === 1 ? <form className="form-stack" onSubmit={e => { e.preventDefault(); setHeroSeat(Number(seat)); finish(`Moved to seat ${seat}. Your stack stays the same.`); }}>{seatField('Move to seat')}<button className="secondary">Move seat</button></form> : <form className="form-stack" onSubmit={e => { e.preventDefault(); submitMoney(); }}>{moneyField(topUp ? 'Top up to · chips' : 'Rebuy to · chips')}{!valid && <p className="field-error">Enter at least {min.toLocaleString()} chips to increase your stack.</p>}<button className={improved ? 'primary' : 'secondary'} disabled={!valid}>{topUp ? 'Top up' : 'Rebuy'}</button></form>}</div>}
            </div>
            <div className="other-player"><strong>Bot 1</strong><small>Seat 3 · 2,000 chips</small></div>
            <div className="other-player"><strong>Bot 2</strong><small>Seat 5 · 2,000 chips</small></div>
            {index === 2 && <div className="bot-section"><button className="disclosure" aria-expanded={botExpanded} onClick={() => { count(); setBotExpanded(v => !v); }}><strong>Add a Bot</strong><span className={botExpanded ? 'rotated' : ''}><Icon name="chevron" size={15} /></span></button>{botExpanded && botForm}</div>}
          </> : index === 2 ? botForm : index === 1 ? <><p>Move from seat {heroSeat} to seat {seat} for the next hand.</p><div className="stack-summary"><span>Your stack stays the same</span><strong>{stack.toLocaleString()} chips</strong></div><button className="primary" onClick={() => { setHeroSeat(Number(seat)); finish(`Moved to seat ${seat}. Your stack stays the same.`); }}>Move to seat {seat}<Icon name="arrow" size={16} /></button></> : <form className="form-stack" onSubmit={e => { e.preventDefault(); if (index === 0) submitMoney(); else submitSeat(); }}>
            {index !== 0 && !(index === 5 && improved) && <fieldset><legend>Open seats</legend><div className="seat-picker">{(index === 5 ? ['4'] : ['2', '4', '6']).map(s => <button type="button" key={s} aria-pressed={seat === s} onClick={() => { count(); setSeat(s); }}>{s}</button>)}</div></fieldset>}
            {index === 0 && <p>Get back in for the next hand.</p>}{moneyField(index === 0 ? 'Rebuy to · chips' : 'Buy-in · chips')}
            {index === 0 && <div className="amount-presets">{[1000, 2000, 4000].map(n => <button type="button" key={n} aria-pressed={Number(amount) === n} onClick={() => { count(); setAmount(String(n)); }}>{n.toLocaleString()}</button>)}</div>}
            {!valid && <p className="field-error">Enter a whole number from {min.toLocaleString()} to 4,000.</p>}
            <p className="next-hand-note">You’re dealt in from the next hand.</p><button className="primary" disabled={!valid}>{index === 0 ? 'Rebuy' : `Sit in seat ${seat}`}<span>{valid ? `${Number(amount).toLocaleString()} chips` : ''}</span></button>
          </form>}
        </div>
      </section></div>}
      {panel === 'table' && (done || index === 6 && improved) && <div className="success-message" role="status"><Icon name="check" size={18} />{done || 'You’re back at your table.'}</div>}
    </div>
    <div className="flow-status flex items-center justify-between"><span>{panel === 'table' ? done || index === 6 && improved ? 'At the table' : 'Click an action to try the flow' : panel === 'options' ? 'General settings' : panel === 'join' ? 'An extra stop' : 'Focused on your task'}</span><span>{actions} {actions === 1 ? 'interaction' : 'interactions'}</span></div>
  </>;
}

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
