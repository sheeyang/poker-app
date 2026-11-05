import { useId, useState } from 'react';
import type { ObservableTableSession } from '@poker/contracts';
import { CommandFeedback } from './controls.js';
import { Dialog } from './dialog.js';
import { seatActions } from './participant-actions.js';
import { useCommandDialog } from './command-dialog.js';
import type { Command } from './session.js';
import { chips } from './table-model.js';

const bigBlinds = new Intl.NumberFormat('en', { maximumFractionDigits: 1 });

/** The clicked Seat is retained. A concurrently occupied Seat never silently changes the player's choice. */
export function TakeSeatDialog({ table, seat, participantId = table.viewerParticipantId, command, handOpen, close, chooseAgain }: { table: ObservableTableSession; seat: number; participantId?: string; command: Command; handOpen: boolean; close: () => void; chooseAgain: () => void }) {
  const { minimumBuyIn, maximumBuyIn, defaultBuyIn, bigBlind } = table.view.configuration;
  const [buyIn, setBuyIn] = useState(String(defaultBuyIn));
  const hint = useId(), submit = useCommandDialog(command, close);
  const amount = Number(buyIn);
  const valid = buyIn.trim() !== '' && Number.isSafeInteger(amount) && amount >= minimumBuyIn && amount <= maximumBuyIn;
  const allowed = seatActions(table, seat, handOpen, participantId).some(action => action.id === 'take-seat' && action.timing === 'now');
  const occupied = table.view.state.participants.some(p => p.seat === seat);
  const busy = command.busy || table.runtimeStatus?.phase === 'recovering';
  const own = participantId === table.viewerParticipantId;
  const name = table.bindings.find(b => b.participantId === participantId)?.name ?? 'Bot';
  return <Dialog title={own ? `Take seat ${seat}` : `Seat ${name} in seat ${seat}`} close={close}>
    <div className="dialog-stack"><CommandFeedback command={command} />
      <form className="seat-form" onSubmit={event => {
        event.preventDefault();
        if (valid && allowed && !busy) submit({ tableId: table.tableSessionId, kind: 'seat', body: { requestId: crypto.randomUUID(), expectedPokerRevision: table.pokerRevision, participantId, seat, buyIn: amount } });
      }}>
        {occupied && <p className="notice-error" role="status">Seat {seat} was just taken. Choose another open seat.</p>}
        {!allowed && !occupied && <p className="muted">{handOpen && table.mode === 'practice' ? 'Available between hands.' : 'This participant can no longer take this seat.'}</p>}
        <label>Buy-in · chips<input name="buyIn" data-autofocus type="number" inputMode="numeric" step="1" min={minimumBuyIn} max={maximumBuyIn} required value={buyIn} aria-describedby={hint} aria-invalid={!valid} onChange={event => setBuyIn(event.target.value)} /><small id={hint}>{chips(minimumBuyIn)}–{chips(maximumBuyIn)} chips{valid ? ` · ${bigBlinds.format(amount / bigBlind)} big blinds` : ''}</small></label>
        <p className="muted">{own ? 'You’re' : `${name} is`} dealt in from the next hand.</p>
        <button className="primary" disabled={busy || !valid || !allowed}>{command.sending ? 'Taking the seat…' : `Sit in seat ${seat}`}<span>{valid ? `${chips(amount)} chips` : ''}</span></button>
        <button type="button" className="text-button" disabled={busy} onClick={chooseAgain}>Choose a different seat</button>
      </form>
    </div>
  </Dialog>;
}
