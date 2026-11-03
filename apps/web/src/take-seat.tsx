import { useEffect, useState } from 'react';
import type { ObservableTableSession } from '@poker/contracts';
import { CommandFeedback } from './controls.js';
import { Dialog } from './dialog.js';
import { openSeats } from './owner-controls.js';
import type { Command } from './session.js';
import { chips } from './table-model.js';

const bigBlinds = new Intl.NumberFormat('en', { maximumFractionDigits: 1 });

/**
 * A watching Guest at an Online Table sits down: in the Seat they pointed at, or the first open one, with a buy-in.
 * Taking a Seat there never waits for a Hand; they are dealt in from the next one. The dialog closes once the
 * server has seated them, and keeps a rejected attempt's explanation in view.
 */
export function TakeSeatDialog({ table, seat, command, handOpen, close }: { table: ObservableTableSession; seat?: number; command: Command; handOpen: boolean; close: () => void }) {
  const open = openSeats(table);
  const { minimumBuyIn, maximumBuyIn, defaultBuyIn, bigBlind } = table.view.configuration;
  const [chosen, setChosen] = useState(seat);
  const [buyIn, setBuyIn] = useState(String(defaultBuyIn));
  // Someone else may take the chosen Seat first; the next open one stands in.
  const target = chosen !== undefined && open.includes(chosen) ? chosen : open[0];
  const amount = Number(buyIn);
  const valid = buyIn.trim() !== '' && Number.isSafeInteger(amount) && amount >= minimumBuyIn && amount <= maximumBuyIn;
  const busy = command.busy || table.runtimeStatus?.phase === 'recovering';
  const seated = table.view.state.participants.some(p => p.participantId === table.viewerParticipantId && p.seat !== null);
  useEffect(() => { if (seated) close(); }, [seated, close]);
  return <Dialog title="Take a seat" close={close}>
    <div className="dialog-stack">
      <CommandFeedback command={command} />
      {target === undefined ? <>
        <p className="muted">Every seat is taken. Keep watching; you can sit down when a seat opens.</p>
        <button className="primary" data-autofocus onClick={close}>Keep watching</button>
      </> : <form className="seat-form" onSubmit={e => { e.preventDefault(); if (valid && !busy) command.submit({ tableId: table.tableSessionId, kind: 'seat', body: { requestId: crypto.randomUUID(), expectedPokerRevision: table.pokerRevision, participantId: table.viewerParticipantId, seat: target, buyIn: amount } }); }}>
        <fieldset className="seat-picker"><legend>Open seats</legend><div className="seat-options">{open.map(s => <button type="button" key={s} aria-pressed={s === target} aria-label={`Seat ${s}`} onClick={() => setChosen(s)}>{s}</button>)}</div></fieldset>
        <label>Buy-in · chips<input type="number" inputMode="numeric" step="1" min={minimumBuyIn} max={maximumBuyIn} required value={buyIn} aria-describedby="seat-buy-in-hint" aria-invalid={!valid} onChange={e => setBuyIn(e.target.value)} /><small id="seat-buy-in-hint">{chips(minimumBuyIn)}–{chips(maximumBuyIn)} chips{valid ? ` · ${bigBlinds.format(amount / bigBlind)} big blinds` : ''}</small></label>
        <p className="muted">{handOpen ? 'A hand is in progress. You sit down now and are dealt in from the next one.' : 'You’re dealt in from the next hand.'}</p>
        <button className="primary" data-autofocus disabled={busy || !valid}>{command.sending ? 'Taking your seat…' : `Sit in seat ${target}`}<span>{valid ? `${chips(amount)} chips` : ''}</span></button>
      </form>}
    </div>
  </Dialog>;
}
