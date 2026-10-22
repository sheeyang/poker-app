import { useState } from 'react';
import { api } from '@poker/client';
import { baselinePlayingStrategy, highestProbabilityPlayingStrategy, type ObservableTableSession, type ParticipantBinding } from '@poker/contracts';
import { Dialog } from './dialog.js';
import { CommandFeedback } from './controls.js';
import { chips } from './table-model.js';
import { useSession, type Command } from './session.js';

export function TableSettings({ table, command, close }: { table: ObservableTableSession; command: Command; close: () => void }) {
  const [seatingAll, setSeatingAll] = useState(false);
  const animations = useSession(s => s.animations), setAnimations = useSession(s => s.setAnimations);
  const active = table.view.state.status === 'active-hand';
  const disabled = active || command.busy || table.runtimeStatus?.phase === 'recovering';
  const unseated = table.bindings.filter(b => !table.view.state.participants.some(p => p.participantId === b.participantId && p.seat !== null));
  async function seatAll() {
    setSeatingAll(true);
    try {
      for (const binding of unseated) {
        const latest = await api.readSession(table.tableSessionId);
        if (latest.view.state.participants.some(p => p.participantId === binding.participantId && p.seat !== null)) continue;
        const seat = Array.from({ length: latest.view.configuration.seatCount }, (_, i) => i + 1).find(s => !latest.view.state.participants.some(p => p.seat === s));
        if (!seat) break;
        await command.run({ tableId: latest.tableSessionId, kind: 'seat', body: { requestId: crypto.randomUUID(), expectedPokerRevision: latest.pokerRevision, participantId: binding.participantId, seat, buyIn: latest.view.configuration.defaultBuyIn } });
      }
    } catch { /* The persisted command and its specific recovery are displayed below. */ }
    finally { setSeatingAll(false); }
  }
  const metadata = () => ({ requestId: crypto.randomUUID(), expectedPokerRevision: table.pokerRevision });
  return <Dialog title="Table options" close={close} wide>
    <div className="settings-summary"><span>No-limit Hold’em</span><strong>{chips(table.view.configuration.smallBlind)} / {chips(table.view.configuration.bigBlind)} chips</strong><span>{table.view.configuration.seatCount} seats · Ante {chips(table.view.configuration.ante)}</span></div>
    <CommandFeedback command={command} />
    <div className="section-heading"><h3>Players & stacks</h3>{unseated.length > 0 && <button className="primary small-button" disabled={disabled || seatingAll} onClick={() => void seatAll()}>{seatingAll ? 'Seating players…' : 'Seat all players'}</button>}</div>
    <p className="muted">{active ? 'Finish this hand to change seats, stacks or sitting-out status.' : `Buy-in ${chips(table.view.configuration.minimumBuyIn)}–${chips(table.view.configuration.maximumBuyIn)} chips. Changes apply to the next hand.`}</p>
    <div className="player-settings">{table.bindings.map(binding => <PlayerSettings key={binding.participantId} table={table} binding={binding} command={command} disabled={disabled || seatingAll} />)}</div>
    <details className="settings-section"><summary>Next dealer button</summary><form className="inline-form" onSubmit={e => { e.preventDefault(); const data = new FormData(e.currentTarget); command.submit({ kind: 'manage', operation: 'set-button', tableId: table.tableSessionId, body: { ...metadata(), seat: Number(data.get('buttonSeat')) } }); }}><label>Seat<select name="buttonSeat" defaultValue={table.view.state.buttonSeat} disabled={disabled}>{table.view.state.participants.filter(p => p.seat !== null && !p.sittingOut && p.stack > 0).map(p => <option key={p.seat} value={p.seat!}>{p.seat} · {table.bindings.find(b => b.participantId === p.participantId)?.controller.kind === 'human' ? 'You' : table.bindings.find(b => b.participantId === p.participantId)?.name}</option>)}</select></label><button disabled={disabled}>Set button</button></form></details>
    <section className="settings-section"><h3>Presentation</h3><label className="check-label"><input type="checkbox" checked={animations} onChange={e => setAnimations(e.target.checked)} />Animate dealing & face-down burns</label><p className="muted">Reduced-motion preferences are respected. Table state updates immediately.</p></section>
    <details className="settings-section"><summary>Session details</summary><label>Table Session ID<input readOnly value={table.tableSessionId} onFocus={e => e.target.select()} /></label><p className="muted">Your table is also available from Practice.</p></details>
    <button className="primary full-width" onClick={close}>Back to the table</button>
  </Dialog>;
}

function PlayerSettings({ table, binding, command, disabled }: { table: ObservableTableSession; binding: ParticipantBinding; command: Command; disabled: boolean }) {
  const p = table.view.state.participants.find(p => p.participantId === binding.participantId);
  const [target, setTarget] = useState(String(table.view.configuration.defaultBuyIn));
  const [seat, setSeat] = useState('');
  const emptySeats = Array.from({ length: table.view.configuration.seatCount }, (_, i) => i + 1).filter(s => !table.view.state.participants.some(p => p.seat === s));
  const chosenSeat = emptySeats.includes(Number(seat)) ? Number(seat) : emptySeats[0];
  const metadata = () => ({ requestId: crypto.randomUUID(), expectedPokerRevision: table.pokerRevision, participantId: binding.participantId });
  const topUp = Number(target), max = table.view.configuration.maximumBuyIn;
  const isSeated = p?.seat != null;
  return <details className="player-setting"><summary><span><strong>{binding.controller.kind === 'human' ? 'You' : binding.name}</strong><small>{isSeated ? `Seat ${p.seat} · ${chips(p.stack)} chips${p.sittingOut ? ' · Sitting out' : ''}` : 'Not seated'}</small></span><span className="text-button">Manage</span></summary><div className="details-content">
    {!isSeated ? <form className="inline-form" onSubmit={e => { e.preventDefault(); if (chosenSeat) command.submit({ tableId: table.tableSessionId, kind: 'seat', body: { ...metadata(), seat: chosenSeat, buyIn: topUp } }); }}><label>Seat<select value={chosenSeat ?? ''} onChange={e => setSeat(e.target.value)} disabled={disabled}>{emptySeats.map(s => <option key={s}>{s}</option>)}</select></label><label>Buy-in<input type="number" step="1" min={table.view.configuration.minimumBuyIn} max={max} required value={target} onChange={e => setTarget(e.target.value)} disabled={disabled} /></label><button disabled={disabled || !chosenSeat}>Take seat</button></form> : <>
      <div className="button-row"><button disabled={disabled} onClick={() => command.submit({ tableId: table.tableSessionId, kind: 'manage', operation: 'set-sitting-out', body: { ...metadata(), sittingOut: !p.sittingOut } })}>{p.sittingOut ? 'Return to play' : 'Sit out'}</button><button disabled={disabled} onClick={() => command.submit({ tableId: table.tableSessionId, kind: 'manage', operation: 'leave-participant', body: metadata() })}>Leave seat · cash out {chips(p.stack)}</button></div>
      <form className="inline-form" onSubmit={e => { e.preventDefault(); command.submit({ tableId: table.tableSessionId, kind: 'manage', operation: 'top-up-to', body: { ...metadata(), targetStack: topUp } }); }}><label>{p.stack === 0 ? 'Rebuy to · chips' : 'Top up to · chips'}<input type="number" step="1" min={Math.max(p.stack + 1, table.view.configuration.minimumBuyIn)} max={max} value={target} required disabled={disabled || p.stack >= max} onChange={e => setTarget(e.target.value)} /></label><button disabled={disabled || p.stack >= max || topUp <= p.stack || topUp > max}>{p.stack === 0 ? 'Rebuy' : 'Top up'}</button></form>
      {table.view.configuration.allowSeatChanges && emptySeats.length > 0 && <form className="inline-form" onSubmit={e => { e.preventDefault(); if (chosenSeat) command.submit({ tableId: table.tableSessionId, kind: 'manage', operation: 'move-participant', body: { ...metadata(), seat: chosenSeat } }); }}><label>Move to seat<select value={chosenSeat ?? ''} disabled={disabled} onChange={e => setSeat(e.target.value)}>{emptySeats.map(s => <option key={s}>{s}</option>)}</select></label><button disabled={disabled}>Move seat</button></form>}
    </>}
    {binding.controller.kind === 'bot' && <label>Playing Strategy<select disabled={disabled} value={binding.controller.playingStrategy.selector.id} onChange={e => command.submit({ tableId: table.tableSessionId, kind: 'strategy', body: { requestId: crypto.randomUUID(), expectedSessionRevision: table.sessionRevision, participantId: binding.participantId, playingStrategy: e.target.value === 'highest-probability' ? highestProbabilityPlayingStrategy : baselinePlayingStrategy } })}><option value="seeded-sampling">Uniform Choice · Probability Selector</option><option value="highest-probability">Uniform Choice · Highest Probability</option></select></label>}
  </div></details>;
}
