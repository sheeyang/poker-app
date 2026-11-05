import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { Field, Icon } from './ui.js';

type Viewer = 'guest-seated' | 'guest-watching' | 'owner-seated' | 'owner-watching';
type Task = 'rebuy' | 'take-seat' | 'add-bot' | 'top-up' | 'strategy' | 'remove-bot' | 'leave-table';
type Panel = 'table' | Task;
type Participant = 'you' | number;
type Bot = { name: string; stack: number; sittingOut?: boolean; pending?: string; strategy?: string };
const defaultStrategy = 'Uniform Choice · Probability Selector';

export function AfterPreview({ index }: { index: number }) {
  const [viewer, setViewer] = useState<Viewer>(index === 2 ? 'owner-seated' : index === 3 || index === 5 ? 'guest-watching' : 'guest-seated');
  const [handOpen, setHandOpen] = useState(false);
  return <>
    <AfterSimulation key={`${viewer}-${handOpen}`} index={index} viewer={viewer} handOpen={handOpen} />
    {[1, 2, 3, 4, 5].includes(index) && <div className="demo-conditions">
      <label>Try After as<select name="demoViewer" value={viewer} onChange={e => setViewer(e.target.value as Viewer)}><option value="guest-seated">Seated guest</option><option value="guest-watching">Watching guest</option><option value="owner-seated">Seated owner</option><option value="owner-watching">Watching owner</option></select></label>
      <label className="demo-hand-toggle"><input name="demoHand" type="checkbox" checked={handOpen} onChange={e => setHandOpen(e.target.checked)} />Hand in progress</label>
    </div>}
  </>;
}

function AfterSimulation({ index, viewer, handOpen }: { index: number; viewer: Viewer; handOpen: boolean }) {
  const id = useId(), owner = viewer.startsWith('owner');
  const [heroSeat, setHeroSeat] = useState(viewer.endsWith('seated') ? 1 : 0);
  const [stack, setStack] = useState(index === 0 ? 0 : index === 4 ? 2010 : viewer.endsWith('seated') ? 2000 : 0);
  const [bots, setBots] = useState<Record<number, Bot>>(() => Object.fromEntries((index === 5 ? [1, 2, 3, 5, 6].filter(s => !(s === 1 && viewer.endsWith('seated'))) : [3, 5]).map((s, i) => [s, { name: `Bot ${i + 1}`, stack: 2000 }])));
  const [panel, setPanel] = useState<Panel>(index === 0 ? 'rebuy' : 'table');
  const [menuSeat, setMenuSeat] = useState<number | null>(index === 1 || index === 2 ? 4 : null);
  const [participantMenu, setParticipantMenu] = useState<Participant | null>(index === 3 || index === 4 ? 'you' : null);
  const [managed, setManaged] = useState<Participant>('you');
  const [selectedSeat, setSelectedSeat] = useState(4);
  const [choosing, setChoosing] = useState(index === 5);
  const [movingBot, setMovingBot] = useState<number | null>(null);
  const [sittingOut, setSittingOut] = useState(false), [pending, setPending] = useState('');
  const [joined, setJoined] = useState(true);
  const [amount, setAmount] = useState(index === 4 ? '4000' : '2000');
  const [botName, setBotName] = useState(`Bot ${Object.keys(bots).length + 1}`);
  const [strategy, setStrategy] = useState(defaultStrategy);
  const [message, setMessage] = useState(index === 6 ? 'You’re back at your table.' : '');
  const [actions, setActions] = useState(index === 6 ? 0 : 1);
  const simulation = useRef<HTMLDivElement>(null), dialog = useRef<HTMLElement>(null);
  const focusMenu = useRef(false), previousPanel = useRef(panel);
  const occupied = (seat: number) => seat === heroSeat || !!bots[seat];
  const openSeats = [1, 2, 3, 4, 5, 6].filter(s => !occupied(s));
  const targetStack = managed === 'you' ? stack : bots[managed]?.stack ?? 0;
  const targetName = managed === 'you' ? 'You' : bots[managed]?.name ?? 'Bot';
  const topUp = panel === 'top-up' && targetStack > 0;
  const minimum = topUp ? Math.max(400, targetStack + 1) : 400;
  const valid = amount.trim() !== '' && Number.isSafeInteger(Number(amount)) && Number(amount) >= minimum && Number(amount) <= 4000;
  const count = () => setActions(a => a + 1);
  const participantAnchor = (who: Participant) => who === 'you' ? '[data-participant="you"]' : `.seat-${who} .occupied-seat`;
  const focusAnchor = (selector: string) => requestAnimationFrame(() => simulation.current?.querySelector<HTMLElement>(selector)?.focus({ preventScroll: true }));
  const focusSeat = (seat: number) => focusAnchor(`.seat-${seat} button`);
  const closeMenus = (restore = true) => {
    if (restore) { if (participantMenu !== null) focusAnchor(participantAnchor(participantMenu)); else if (menuSeat !== null) focusSeat(menuSeat); }
    setMenuSeat(null); setParticipantMenu(null);
  };
  const closePanel = () => { count(); setPanel('table'); focusAnchor(panel === 'take-seat' || panel === 'add-bot' ? `.seat-${selectedSeat} button` : participantAnchor(managed)); };
  useEffect(() => {
    if (previousPanel.current !== panel && panel !== 'table') dialog.current?.querySelector<HTMLElement>('input, select, button.primary, button.secondary')?.focus({ preventScroll: true });
    previousPanel.current = panel;
  }, [panel]);
  function chooseSeats(bot: number | null = null) {
    count(); setPanel('table'); setMessage(''); closeMenus(false); setChoosing(true); setMovingBot(bot);
    if (openSeats[0]) focusSeat(openSeats[0]);
  }
  function openMenu(seat: number) {
    if (occupied(seat) || !joined) return;
    count(); setMessage(''); focusMenu.current = true; setParticipantMenu(null); setMenuSeat(seat);
  }
  function openParticipant(who: Participant) {
    count(); setMessage(''); focusMenu.current = true; setMenuSeat(null); setParticipantMenu(who);
  }
  function chooseSeatAction(task: 'take-seat' | 'add-bot') {
    if (menuSeat === null || occupied(menuSeat)) return;
    count(); setSelectedSeat(menuSeat); closeMenus(false); setChoosing(false); setMovingBot(null); setPanel(task); setAmount('2000');
  }
  function participantTask(task: Task) {
    if (participantMenu === null) return;
    count(); setManaged(participantMenu);
    const currentStack = participantMenu === 'you' ? stack : bots[participantMenu]?.stack ?? 0;
    setAmount(currentStack === 0 ? '2000' : '4000');
    if (typeof participantMenu === 'number') setStrategy(bots[participantMenu]?.strategy ?? defaultStrategy);
    closeMenus(false); setPanel(task);
  }
  function finish(text: string) { count(); setPanel('table'); closeMenus(false); setChoosing(false); setMovingBot(null); setMessage(text); }
  function moveHere() {
    if (handOpen || menuSeat === null || occupied(menuSeat)) return;
    if (movingBot !== null && owner && bots[movingBot]) {
      const bot = bots[movingBot]; setBots(current => { const next = { ...current, [menuSeat]: bot }; delete next[movingBot]; return next; }); finish(`${bot.name} moved to seat ${menuSeat}.`);
    } else if (heroSeat) { setHeroSeat(menuSeat); finish(`Moved to seat ${menuSeat}.`); }
  }
  function sitOut(who: Participant) {
    const isOut = who === 'you' ? sittingOut : !!bots[who]?.sittingOut;
    const name = who === 'you' ? 'You' : bots[who]?.name;
    if (isOut && handOpen) return;
    if (who === 'you') { if (handOpen) setPending('Sitting out after this hand'); else setSittingOut(!isOut); }
    else setBots(current => ({ ...current, [who]: { ...current[who]!, ...(handOpen ? { pending: 'Sitting out after this hand' } : { sittingOut: !isOut }) } }));
    finish(handOpen ? `${name}: sitting out after this hand.` : `${name}: ${isOut ? 'back in play' : 'sitting out'}.`);
  }
  function standUp() {
    if (handOpen) { setPending('Standing up after this hand'); finish('You’ll stand up after this hand.'); }
    else { const cashOut = stack; setHeroSeat(0); setStack(0); setSittingOut(false); finish(`You stood up and cashed out ${cashOut.toLocaleString()} chips.`); }
  }
  function submit() {
    if (panel === 'strategy' && owner && typeof managed === 'number' && bots[managed]) { setBots(current => ({ ...current, [managed]: { ...current[managed]!, strategy } })); finish(`${targetName}’s Playing Strategy updated.`); return; }
    if (panel === 'remove-bot' && owner && typeof managed === 'number' && bots[managed]) {
      if (handOpen) setBots(current => ({ ...current, [managed]: { ...current[managed]!, pending: 'Leaving after this hand' } }));
      else setBots(current => { const next = { ...current }; delete next[managed]; return next; });
      finish(`${targetName} ${handOpen ? 'leaves after this hand' : 'removed'}.`); return;
    }
    if (panel === 'leave-table') {
      if (handOpen && heroSeat) { setPending('Leaving after this hand'); finish('You’ll leave after this hand.'); }
      else { setHeroSeat(0); setStack(0); setJoined(false); finish('You left the table.'); } return;
    }
    if (!valid) return;
    if (panel === 'add-bot') {
      if (!owner || !botName.trim() || occupied(selectedSeat)) return;
      setBots(current => ({ ...current, [selectedSeat]: { name: botName.trim(), stack: Number(amount), strategy } }));
      finish(`${botName.trim()} added to seat ${selectedSeat} with ${Number(amount).toLocaleString()} chips.`);
    } else if (panel === 'take-seat') {
      if (heroSeat || occupied(selectedSeat)) return;
      setHeroSeat(selectedSeat); setStack(Number(amount)); finish(`You’re in seat ${selectedSeat} with ${Number(amount).toLocaleString()} chips.`);
    } else if (!handOpen) {
      if (managed === 'you') setStack(Number(amount));
      else if (owner && bots[managed]) setBots(current => ({ ...current, [managed]: { ...current[managed]!, stack: Number(amount) } }));
      else return;
      finish(`${managed === 'you' ? '' : `${targetName}: `}${topUp ? 'Stack topped up' : 'Rebought'} to ${Number(amount).toLocaleString()} chips.`);
    }
  }
  const moneyField = (label: string) => <Field label={label} hint={minimum > 4000 ? 'Your stack is already at the maximum buy-in.' : `${minimum.toLocaleString()}–4,000 chips${topUp && valid ? ` · Adds ${(Number(amount) - targetStack).toLocaleString()} chips` : ''}`}><input name="chipAmount" aria-label={label} type="number" inputMode="numeric" step="1" min={minimum} max="4000" required value={amount} aria-invalid={!valid} disabled={minimum > 4000} onChange={e => setAmount(e.target.value)} /></Field>;
  const strategyField = <Field label="Playing Strategy"><select name="botStrategy" value={strategy} onChange={e => setStrategy(e.target.value)}><option>{defaultStrategy}</option><option>Always Fold · Probability Selector</option></select></Field>;
  const moneyForm = <form className="form-stack" onSubmit={e => { e.preventDefault(); submit(); }}>{moneyField(topUp ? 'Top up to · chips' : 'Rebuy to · chips')}{panel === 'rebuy' && <div className="amount-presets">{[1000, 2000, 4000].map(n => <button type="button" key={n} aria-pressed={Number(amount) === n} onClick={() => { count(); setAmount(String(n)); }}>{n.toLocaleString()}</button>)}</div>}{!valid && minimum <= 4000 && <p className="field-error">Enter a whole number from {minimum.toLocaleString()} to 4,000.</p>}{handOpen && <p>Available between hands.</p>}<button className="primary" disabled={!valid || handOpen}>{topUp ? 'Top up' : 'Rebuy'}<span>{valid ? `${Number(amount).toLocaleString()} chips` : ''}</span></button></form>;
  const trayAction = () => {
    if (!joined) { count(); setJoined(true); setMessage('You’re back at your table.'); return; }
    if (index === 6) { count(); setMessage('You’re back at your table.'); return; }
    if (!heroSeat || index === 1 || index === 2) { chooseSeats(); return; }
    count(); setMessage(''); setManaged('you'); setAmount(stack === 0 ? '2000' : '4000'); setPanel(stack === 0 ? 'rebuy' : 'top-up');
  };
  const participantName = participantMenu === 'you' ? 'You' : participantMenu !== null ? bots[participantMenu]?.name ?? 'Bot' : '';
  const isSelf = participantMenu === 'you';
  const participantStack = isSelf ? stack : participantMenu !== null ? bots[participantMenu]?.stack ?? 0 : 0;
  const participantOut = isSelf ? sittingOut : participantMenu !== null && !!bots[participantMenu]?.sittingOut;
  const participantPending = isSelf ? pending : participantMenu !== null ? bots[participantMenu]?.pending : '';
  const hasMenu = menuSeat !== null || participantMenu !== null;
  const panelTitle = panel === 'rebuy' ? 'Rebuy' : panel === 'top-up' ? `${topUp ? 'Top up' : 'Rebuy'}${managed === 'you' ? '' : ` ${targetName}`}` : panel === 'take-seat' ? `Take seat ${selectedSeat}` : panel === 'add-bot' ? `Add a Bot to seat ${selectedSeat}` : panel === 'strategy' ? `${targetName} · Playing Strategy` : panel === 'remove-bot' ? `Remove ${targetName}?` : 'Leave table?';
  return <>
    <div className={`simulation after-simulation ${choosing ? 'choosing-seats' : ''}`} ref={simulation}>
      <div inert={panel !== 'table'}>
        <div className="sim-toolbar flex items-center justify-between"><div><strong>6-player table</strong><span>10 / 20 · Online · {owner ? 'Table Owner' : 'Guest'}</span></div></div>
        <div className="table-area">
          <span className="hand-label">{handOpen ? 'Hand in progress' : 'Between hands'}</span>
          <div className="felt"><div className="felt-copy"><Icon name="spade" size={22} /><span>No-limit Hold’em</span><strong>{choosing ? movingBot !== null ? `Choose a seat for ${bots[movingBot]?.name}` : 'Choose an open seat' : handOpen ? 'Hand in progress' : 'Waiting for the next hand'}</strong></div></div>
          {[1, 2, 3, 4, 5, 6].map(s => <div key={s} className={`demo-seat seat-${s} ${heroSeat === s ? 'hero-seat' : ''}`}>
            {occupied(s) ? <button className="occupied-seat" data-participant={s === heroSeat ? 'you' : s} aria-label={`${s === heroSeat ? 'You' : bots[s]?.name} actions`} aria-haspopup="menu" aria-expanded={participantMenu === (s === heroSeat ? 'you' : s)} onClick={() => openParticipant(s === heroSeat ? 'you' : s)}><span className="avatar">{s === heroSeat ? 'Y' : 'B'}</span><span><strong>{s === heroSeat ? 'You' : bots[s]?.name}</strong><small>{(s === heroSeat ? stack : bots[s]?.stack ?? 0).toLocaleString()} chips</small>{(s === heroSeat ? pending || (sittingOut ? 'Sitting out' : '') : bots[s]?.pending || (bots[s]?.sittingOut ? 'Sitting out' : '')) && <small className="participant-state">{s === heroSeat ? pending || 'Sitting out' : bots[s]?.pending || 'Sitting out'}</small>}</span></button> : <button className="open-seat plus-seat" aria-label={`Seat ${s} actions`} title={`Seat ${s} actions`} aria-haspopup="menu" aria-expanded={menuSeat === s} aria-controls={menuSeat === s ? `${id}-seat-menu` : undefined} disabled={!joined} onClick={() => openMenu(s)} onKeyDown={e => { if (e.key === 'ArrowDown') { e.preventDefault(); openMenu(s); } }}><Icon name="plus" size={24} /></button>}
          </div>)}
        </div>
        <div className="action-tray"><div>{!heroSeat && joined ? <button className="watching-participant" data-participant="you" aria-label="You actions" aria-haspopup="menu" aria-expanded={participantMenu === 'you'} onClick={() => openParticipant('you')}><span className="avatar">Y</span><span><strong>You</strong><small>Watching</small></span></button> : <><strong>{!joined ? 'You left the table.' : index === 0 && stack === 0 ? 'You’re out of chips.' : 'Ready when the table is.'}</strong><span>{index === 0 && stack === 0 ? 'Rebuy to be dealt into the next hand.' : 'Click a participant or an open seat.'}</span></>}</div>{!(index === 5 && joined && !heroSeat) && <button className="primary" onClick={trayAction}>{!joined ? 'Return to table' : !heroSeat ? 'Choose a seat' : index === 0 ? 'Rebuy' : index === 1 || index === 2 ? 'Choose a seat' : index === 6 ? 'Open Join Link' : 'Top up'}<Icon name="arrow" size={15} /></button>}</div>
      </div>
      {menuSeat !== null && panel === 'table' && <ContextMenu simulation={simulation} anchor={`.seat-${menuSeat}`} title={`Seat ${menuSeat}`} id={`${id}-seat-menu`} autoFocus={focusMenu.current} close={closeMenus}>
        {movingBot !== null ? <button role="menuitem" disabled={handOpen} onClick={moveHere}>Move {bots[movingBot]?.name} here{handOpen && <small>Available between hands</small>}</button> : heroSeat ? <button role="menuitem" disabled={handOpen} onClick={moveHere}>Move here{handOpen && <small>Available between hands</small>}</button> : <button role="menuitem" onClick={() => chooseSeatAction('take-seat')}>Take this seat</button>}
        {owner && movingBot === null && <button role="menuitem" onClick={() => chooseSeatAction('add-bot')}>Add a Bot here</button>}
      </ContextMenu>}
      {participantMenu !== null && panel === 'table' && <ContextMenu simulation={simulation} anchor={participantAnchor(participantMenu)} title={participantName} id={`${id}-participant-menu`} autoFocus={focusMenu.current} close={closeMenus}>
        {isSelf && !heroSeat ? openSeats.length > 1 && <button role="menuitem" onClick={() => chooseSeats()}>Choose a seat</button> : (isSelf || owner) && <>
          <button role="menuitem" disabled={handOpen || participantStack >= 4000 || !!participantPending} onClick={() => participantTask('top-up')}>{participantStack ? 'Top up' : 'Rebuy'}{handOpen && <small>Available between hands</small>}</button>
          <button role="menuitem" disabled={!!participantPending || !!participantOut && handOpen} onClick={() => sitOut(participantMenu)}>{participantOut ? 'Return to play' : handOpen ? 'Sit out after this hand' : 'Sit out'}</button>
          <button role="menuitem" disabled={handOpen || !openSeats.length || !!participantPending} onClick={() => chooseSeats(isSelf ? null : participantMenu as number)}>Move seat{handOpen && <small>Available between hands</small>}</button>
          {isSelf ? <button role="menuitem" disabled={!!participantPending} onClick={standUp}>{handOpen ? 'Stand up after this hand' : 'Stand up'}</button> : <><button role="menuitem" onClick={() => participantTask('strategy')}>Playing Strategy</button><button role="menuitem" disabled={!!participantPending} onClick={() => participantTask('remove-bot')}>Remove Bot</button></>}
        </>}
        {isSelf && <button role="menuitem" onClick={() => participantTask('leave-table')}>{handOpen && heroSeat ? 'Leave after this hand' : 'Leave table'}</button>}
        {!isSelf && !owner && <div className="participant-summary">{participantStack.toLocaleString()} chips</div>}
      </ContextMenu>}
      {panel !== 'table' && <div className="panel-layer"><section className="demo-dialog" tabIndex={-1} ref={dialog} aria-labelledby={`${id}-heading`} onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); closePanel(); } }}>
        <div className="dialog-heading flex items-center justify-between"><h4 id={`${id}-heading`}>{panelTitle}</h4><button className="close-button" aria-label="Close panel" onClick={closePanel}><Icon name="close" /></button></div>
        <div className="dialog-content">
          {panel === 'rebuy' ? <><p>Get back in for the next hand.</p>{moneyForm}</> : panel === 'top-up' ? moneyForm : panel === 'strategy' ? <form className="form-stack" onSubmit={e => { e.preventDefault(); submit(); }}>{strategyField}<button className="primary">Apply strategy</button></form> : panel === 'remove-bot' || panel === 'leave-table' ? <><p>{panel === 'remove-bot' ? `${targetName} ${handOpen ? 'finishes this hand, then leaves' : 'stands up, cashes out and leaves'}.` : handOpen && heroSeat ? 'You finish this hand, then stand up and leave.' : `You stand up and cash out ${stack.toLocaleString()} chips.`}</p><div className="confirmation-actions"><button className="primary" onClick={submit}>{panel === 'remove-bot' ? 'Remove Bot' : 'Leave table'}</button><button className="secondary" onClick={closePanel}>Cancel</button></div></> : <form className="form-stack" onSubmit={e => { e.preventDefault(); submit(); }}>
            <div className="selected-seat"><strong>Seat {selectedSeat}</strong><button type="button" className="quiet" onClick={() => chooseSeats()}>Choose a different seat</button></div>
            {panel === 'add-bot' && <><Field label="Name"><input name="botName" value={botName} maxLength={20} required onChange={e => setBotName(e.target.value)} /></Field>{strategyField}</>}
            {moneyField('Buy-in · chips')}{!valid && <p className="field-error">Enter a whole number from 400 to 4,000.</p>}<p className="next-hand-note">{panel === 'add-bot' ? 'The Bot is' : 'You’re'} dealt in from the next hand.</p><button className="primary" disabled={!valid || panel === 'add-bot' && !botName.trim()}>{panel === 'add-bot' ? `Add Bot to seat ${selectedSeat}` : `Sit in seat ${selectedSeat}`}<span>{valid ? `${Number(amount).toLocaleString()} chips` : ''}</span></button>
          </form>}
        </div>
      </section></div>}
      {panel === 'table' && !hasMenu && message && <div className="success-message" role="status"><Icon name="check" />{message}</div>}
      {panel === 'table' && !hasMenu && choosing && <p className="seat-selection-hint" role="status">{movingBot !== null ? `Choose an open seat for ${bots[movingBot]?.name}.` : openSeats.length ? 'Choose an open seat on the table.' : 'Every seat is taken.'}</p>}
    </div>
    <div className="flow-status flex items-center justify-between"><span>{participantMenu !== null ? `${participantName} · Actions` : menuSeat !== null ? `Seat ${menuSeat} · Choose an action` : choosing ? 'Choose on the table' : panel === 'table' ? 'At the table' : 'Focused on your task'}</span><span>{actions} {actions === 1 ? 'interaction' : 'interactions'}</span></div>
  </>;
}

function ContextMenu({ simulation, anchor, title, id, autoFocus, close, children }: { simulation: RefObject<HTMLDivElement | null>; anchor: string; title: string; id: string; autoFocus: boolean; close: (restore?: boolean) => void; children: ReactNode }) {
  const menu = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: 16, top: 120 });
  useLayoutEffect(() => {
    const place = () => {
      const frame = simulation.current?.getBoundingClientRect(), target = simulation.current?.querySelector(anchor)?.getBoundingClientRect(), box = menu.current?.getBoundingClientRect();
      if (!frame || !target || !box) return;
      const below = target.bottom - frame.top + 8, above = target.top - frame.top - box.height - 8;
      setPosition({ left: Math.max(12, Math.min(target.left - frame.left, frame.width - box.width - 12)), top: below + box.height <= frame.height - 12 ? below : above >= 12 ? above : Math.max(12, frame.height - box.height - 12) });
    };
    place(); window.addEventListener('resize', place); return () => window.removeEventListener('resize', place);
  }, [simulation, anchor]);
  useEffect(() => { if (autoFocus) (menu.current?.querySelector<HTMLElement>('[role=menuitem]:not(:disabled)') ?? menu.current)?.focus({ preventScroll: true }); }, [autoFocus, anchor]);
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (!(event.target instanceof Node) || menu.current?.contains(event.target) || simulation.current?.querySelector(anchor)?.contains(event.target)) return;
      close(false);
    };
    document.addEventListener('pointerdown', outside); return () => document.removeEventListener('pointerdown', outside);
  }, [close, anchor, simulation]);
  return <div className="seat-menu-layer" onPointerDown={e => { if (e.target === e.currentTarget) close(); }}><div className="seat-action-menu" ref={menu} style={position} tabIndex={-1} onKeyDown={e => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
    if (e.key === 'Tab') { close(); return; }
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
      e.preventDefault(); const items = Array.from(menu.current?.querySelectorAll<HTMLButtonElement>('[role=menuitem]:not(:disabled)') ?? []);
      const current = items.indexOf(document.activeElement as HTMLButtonElement), next = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : (current + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      items[next]?.focus();
    }
  }}><div className="seat-menu-heading"><h4 id={`${id}-title`}>{title}</h4><button aria-label="Close action menu" className="close-button" onClick={() => close()}><Icon name="close" size={16} /></button></div><div id={id} role="menu" aria-labelledby={`${id}-title`}>{children}</div></div></div>;
}
