import { useState } from 'react';
import { api } from '@poker/client';
import type { ObservableTableSession, ParticipantBinding } from '@poker/contracts';
import { StrategySelect } from './strategy-select.js';
import { Icon } from './icons.js';
import { Dialog } from './dialog.js';
import { CommandFeedback } from './controls.js';
import { DisplayNameForm, useDisplayName } from './display-name.js';
import { canManage, chips, modeLabel, playerName } from './table-model.js';
import { useSession, type Command } from './session.js';
import { pendingChangeOf, pendingLabel, selfService } from './self-service.js';
import { connectionOf } from './online-status.js';
import { canRemove, removalTiming } from './removal.js';

/** `handOpen`: a Hand is in progress for management, being played or still paying out, so changes to a Seat wait for it. */
export function TableSettings({ table, command, handOpen, close }: { table: ObservableTableSession; command: Command; handOpen: boolean; close: () => void }) {
  const [seatingAll, setSeatingAll] = useState(false);
  const { displayName } = useDisplayName();
  const animations = useSession(s => s.animations), setAnimations = useSession(s => s.setAnimations);
  const online = table.mode === 'online', owner = table.viewerParticipantId === table.ownerParticipantId;
  const active = handOpen;
  const busy = command.busy || table.runtimeStatus?.phase === 'recovering';
  // Management waits for the Hand to end, though a human's own sit-out, Stand Up and Leave Table are asked for now and
  // applied after it. Taking a seat does not wait at an Online Table: the newcomer is dealt in next Hand.
  const disabled = active || busy;
  const unseated = table.bindings.filter(b => canManage(table, b) && !table.view.state.participants.some(p => p.participantId === b.participantId && p.seat !== null));
  const options = table.options;
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
    <div className="settings-summary"><span>{modeLabel(table.mode)} · No-limit Hold’em</span><strong>{chips(table.view.configuration.smallBlind)} / {chips(table.view.configuration.bigBlind)} chips</strong><span>{table.view.configuration.seatCount} seats · Ante {chips(table.view.configuration.ante)}</span></div>
    {online && <p className="table-rules muted">{options.actionTimeLimitSeconds ? `${options.actionTimeLimitSeconds} seconds to act` : 'No time limit'} · Live Analysis {options.allowLiveAnalysis ? 'allowed' : 'not allowed'} · Seat changes {table.view.configuration.allowSeatChanges ? 'allowed' : 'not allowed'}</p>}
    <CommandFeedback command={command} />
    <div className="section-heading"><h3>{online ? 'Players' : 'Players & stacks'}</h3>{!online && unseated.length > 0 && <button className="primary small-button" disabled={disabled || seatingAll} onClick={() => void seatAll()}>{seatingAll ? 'Seating players…' : 'Seat all players'}</button>}</div>
    <p className="muted">{active ? online ? 'Take a seat now and you’re dealt in from the next hand. You can ask to sit out, stand up or leave now; it happens when the hand ends. Other changes wait.' : 'You can ask to sit out, stand up or leave now; it happens when the hand ends. Finish this hand to change seats or stacks.' : `Buy-in ${chips(table.view.configuration.minimumBuyIn)}–${chips(table.view.configuration.maximumBuyIn)} chips. Changes apply to the next hand.`}</p>
    <div className="player-settings">{table.bindings.map(binding => canManage(table, binding)
      ? <PlayerSettings key={binding.participantId} table={table} binding={binding} command={command} handOpen={active} busy={busy || seatingAll} seating={busy || seatingAll || active && !online} />
      : <PlayerRow key={binding.participantId} table={table} binding={binding} command={command} handOpen={active} busy={busy} />)}</div>
    {owner && <details className="settings-section"><summary>Next dealer button</summary><form className="inline-form" onSubmit={e => { e.preventDefault(); const data = new FormData(e.currentTarget); command.submit({ kind: 'manage', operation: 'set-button', tableId: table.tableSessionId, body: { ...metadata(), seat: Number(data.get('buttonSeat')) } }); }}><label>Seat<select name="buttonSeat" defaultValue={table.view.state.buttonSeat} disabled={disabled}>{table.view.state.participants.filter(p => p.seat !== null && !p.sittingOut && p.stack > 0).map(p => <option key={p.seat} value={p.seat!}>{p.seat} · {playerName(table, table.bindings.find(b => b.participantId === p.participantId)!)}</option>)}</select></label><button disabled={disabled}>Set button</button></form></details>}
    <section className="settings-section"><h3>Presentation</h3><label className="check-label"><input type="checkbox" checked={animations} onChange={e => setAnimations(e.target.checked)} />Card animations</label></section>
    <details className="settings-section"><summary>Your name{displayName ? ` · ${displayName}` : ''}</summary><p className="muted">Applies to tables you create or join from now on, not this one.</p><DisplayNameForm current={displayName} /></details>
    <details className="settings-section"><summary>Session details</summary><label>Table Session ID<input readOnly value={table.tableSessionId} onFocus={e => e.target.select()} /></label><p className="muted">Your table is also in your saved tables.</p></details>
    <button className="primary full-width" onClick={close}>Back to the table</button>
  </Dialog>;
}

/** Another human Participant: visible to everyone, controllable only by their own Guest. The Table Owner can remove them. */
function PlayerRow({ table, binding, command, handOpen, busy }: { table: ObservableTableSession; binding: ParticipantBinding; command: Command; handOpen: boolean; busy: boolean }) {
  const [confirming, setConfirming] = useState(false);
  const p = table.view.state.participants.find(p => p.participantId === binding.participantId);
  const pending = pendingChangeOf(table, binding.participantId);
  const connection = connectionOf(table, binding.participantId);
  const timing = removalTiming(handOpen);
  return <div className="player-setting player-row"><span><strong>{binding.name}</strong>{binding.participantId === table.ownerParticipantId && <small> · Table Owner</small>}<small>{p?.seat != null ? `Seat ${p.seat} · ${chips(p.stack)} chips${p.sittingOut ? ' · Sitting out' : ''}` : 'Not seated'}{connection ? ` · ${connection === 'connected' ? 'Connected' : 'Disconnected'}` : ''}{pending ? ` · ${pendingLabel(pending)}` : ''}</small></span>
    {canRemove(table, binding) && (confirming
      ? <div className="remove-confirm" role="group" aria-label={`Remove ${binding.name}`}>
        <p className="muted">{binding.name} can’t join this table again, even with a new Join Link. {timing === 'after-hand' ? 'They stay until this hand ends, then stand up and leave.' : 'They stand up and leave at once.'}</p>
        <div className="button-row"><button className="leave-button" disabled={busy} onClick={() => { setConfirming(false); command.submit({ kind: 'manage', operation: 'remove-participant', tableId: table.tableSessionId, body: { requestId: crypto.randomUUID(), expectedPokerRevision: table.pokerRevision, participantId: binding.participantId } }); }}>Remove {binding.name}</button><button onClick={() => setConfirming(false)}>Keep {binding.name}</button></div>
      </div>
      : <button className="leave-button" disabled={busy} onClick={() => setConfirming(true)}>Remove from table</button>)}
  </div>;
}

function PlayerSettings({ table, binding, command, handOpen, busy, seating }: { table: ObservableTableSession; binding: ParticipantBinding; command: Command; handOpen: boolean; busy: boolean; seating: boolean }) {
  const p = table.view.state.participants.find(p => p.participantId === binding.participantId);
  const [target, setTarget] = useState(String(table.view.configuration.defaultBuyIn));
  const [seat, setSeat] = useState('');
  const emptySeats = Array.from({ length: table.view.configuration.seatCount }, (_, i) => i + 1).filter(s => !table.view.state.participants.some(p => p.seat === s));
  const chosenSeat = emptySeats.includes(Number(seat)) ? Number(seat) : emptySeats[0];
  const metadata = () => ({ requestId: crypto.randomUUID(), expectedPokerRevision: table.pokerRevision, participantId: binding.participantId });
  const topUp = Number(target), max = table.view.configuration.maximumBuyIn;
  const isSeated = p?.seat != null;
  const own = binding.participantId === table.viewerParticipantId;
  // A human's own sit-out, Stand Up and Leave Table are asked for now and apply after the Hand; everything else waits for it.
  const service = own ? selfService(table, handOpen) : undefined;
  const disabled = handOpen || busy;
  const pending = pendingChangeOf(table, binding.participantId);
  const asking = (availability: 'now' | 'after-hand' | 'unavailable' | undefined) => busy || availability === undefined || availability === 'unavailable';
  const manage = (operation: 'set-sitting-out' | 'stand-up-participant' | 'leave-table', sittingOut?: boolean) => command.submit({ tableId: table.tableSessionId, kind: 'manage', operation, body: operation === 'set-sitting-out' ? { ...metadata(), sittingOut: !!sittingOut } : metadata() });
  return <details className="player-setting" open={binding.participantId === table.viewerParticipantId && !isSeated && table.mode === 'online'}><summary><span><strong>{playerName(table, binding)}</strong><small>{isSeated ? `Seat ${p.seat} · ${chips(p.stack)} chips${p.sittingOut ? ' · Sitting out' : ''}` : 'Not seated'}{pending ? ` · ${pendingLabel(pending)}` : ''}</small></span><Icon name="chevron" size={17} /></summary><div className="details-content">
    {pending && <p className="pending-note" role="status">{pendingLabel(pending)}. It happens when this hand ends.</p>}
    {!isSeated ? <form className="inline-form" onSubmit={e => { e.preventDefault(); if (chosenSeat) command.submit({ tableId: table.tableSessionId, kind: 'seat', body: { ...metadata(), seat: chosenSeat, buyIn: topUp } }); }}><label>Seat<select value={chosenSeat ?? ''} onChange={e => setSeat(e.target.value)} disabled={seating}>{emptySeats.map(s => <option key={s}>{s}</option>)}</select></label><label>Buy-in<input type="number" step="1" min={table.view.configuration.minimumBuyIn} max={max} required value={target} onChange={e => setTarget(e.target.value)} disabled={seating} /></label><button disabled={seating || !chosenSeat}>Take seat</button></form> : <>
      <div className="button-row">{p.sittingOut
        ? <button disabled={own ? asking(service?.resume) : disabled} onClick={() => manage('set-sitting-out', false)}>Return to play</button>
        : <button disabled={own ? asking(service?.sitOut) : disabled} onClick={() => manage('set-sitting-out', true)}>{service?.sitOut === 'after-hand' ? 'Sit out after this hand' : 'Sit out'}</button>}
        <button disabled={own ? asking(service?.standUp) : disabled} onClick={() => manage('stand-up-participant')}>{service?.standUp === 'after-hand' ? 'Stand up after this hand' : <>Stand up · cash out {chips(p.stack)}</>}</button></div>
      <form className="inline-form" onSubmit={e => { e.preventDefault(); command.submit({ tableId: table.tableSessionId, kind: 'manage', operation: 'top-up-to', body: { ...metadata(), targetStack: topUp } }); }}><label>{p.stack === 0 ? 'Rebuy to · chips' : 'Top up to · chips'}<input type="number" step="1" min={Math.max(p.stack + 1, table.view.configuration.minimumBuyIn)} max={max} value={target} required disabled={disabled || p.stack >= max} onChange={e => setTarget(e.target.value)} /></label><button disabled={disabled || p.stack >= max || topUp <= p.stack || topUp > max}>{p.stack === 0 ? 'Rebuy' : 'Top up'}</button></form>
      {table.view.configuration.allowSeatChanges && emptySeats.length > 0 && <form className="inline-form" onSubmit={e => { e.preventDefault(); if (chosenSeat) command.submit({ tableId: table.tableSessionId, kind: 'manage', operation: 'move-participant', body: { ...metadata(), seat: chosenSeat } }); }}><label>Move to seat<select value={chosenSeat ?? ''} disabled={disabled} onChange={e => setSeat(e.target.value)}>{emptySeats.map(s => <option key={s}>{s}</option>)}</select></label><button disabled={disabled}>Move seat</button></form>}
    </>}
    {own && <div className="button-row"><button className="leave-button" disabled={asking(service?.leaveTable)} onClick={() => manage('leave-table')}>{service?.leaveTable === 'after-hand' ? 'Leave table after this hand' : 'Leave table'}</button></div>}
    {own && <p className="muted">{isSeated ? 'Leaving stands you up and cashes you out. ' : ''}{table.mode === 'online' && table.viewerParticipantId !== table.ownerParticipantId ? 'Rejoin any time from the Join Link, as the same player with your history.' : table.viewerParticipantId === table.ownerParticipantId ? 'Your table stays in your saved tables, and you can come back to it.' : ''}</p>}
    {binding.controller.kind === 'bot' && <label>Playing Strategy<StrategySelect disabled={disabled} value={binding.controller.playingStrategy} onChange={playingStrategy => command.submit({ tableId: table.tableSessionId, kind: 'strategy', body: { requestId: crypto.randomUUID(), expectedSessionRevision: table.sessionRevision, participantId: binding.participantId, playingStrategy } })} /></label>}
  </div></details>;
}
