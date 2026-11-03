import { useId, useState } from 'react';
import { defaultPlayingStrategy, type ObservableTableSession, type StrategyDescriptor } from '@poker/contracts';
import { Dialog } from './dialog.js';
import { CommandFeedback } from './controls.js';
import { useCommandDialog } from './command-dialog.js';
import { nextBotName, openSeats } from './owner-controls.js';
import { participantActions, stackBounds } from './participant-actions.js';
import { StrategySelect } from './strategy-select.js';
import type { Command } from './session.js';
import { chips, playerName } from './table-model.js';

export type ParticipantTask = 'stack' | 'strategy' | 'remove-bot' | 'remove-participant' | 'leave';
interface Props { table: ObservableTableSession; command: Command; handOpen: boolean; close: () => void }

export function ParticipantDialog({ table, command, handOpen, close, participantId, task }: Props & { participantId: string; task: ParticipantTask }) {
  const binding = table.bindings.find(b => b.participantId === participantId);
  const participant = table.view.state.participants.find(p => p.participantId === participantId);
  const bounds = stackBounds(table, participant?.stack ?? 0);
  const [amount, setAmount] = useState(String(bounds.initial));
  const [strategy, setStrategy] = useState<StrategyDescriptor>(binding?.controller.kind === 'bot' ? binding.controller.playingStrategy : defaultPlayingStrategy);
  const submit = useCommandDialog(command, close), hint = useId();
  const own = participantId === table.viewerParticipantId;
  const name = binding ? playerName(table, binding) : 'Participant';
  const rebuy = participant?.stack === 0;
  const busy = command.busy || table.runtimeStatus?.phase === 'recovering';
  const action = participantActions(table, participantId, handOpen).find(action => action.id === task);
  const allowed = !!action && action.timing !== 'unavailable';
  const target = Number(amount);
  const valid = amount.trim() !== '' && Number.isSafeInteger(target) && target >= bounds.minimum && target <= bounds.maximum;
  const title = task === 'stack' ? `${rebuy ? 'Rebuy' : 'Top up'}${own ? '' : ` ${name}`}` : task === 'strategy' ? `${name} · Playing Strategy` : task === 'leave' ? 'Leave table?' : `Remove ${name}?`;
  const metadata = () => ({ requestId: crypto.randomUUID(), expectedPokerRevision: table.pokerRevision, participantId });
  const send = () => {
    if (busy || !allowed) return;
    if (task === 'stack') { if (valid) submit({ tableId: table.tableSessionId, kind: 'manage', operation: 'top-up-to', body: { ...metadata(), targetStack: target } }); }
    else if (task === 'strategy') submit({ tableId: table.tableSessionId, kind: 'strategy', body: { requestId: crypto.randomUUID(), expectedSessionRevision: table.sessionRevision, participantId, playingStrategy: strategy } });
    else submit({ tableId: table.tableSessionId, kind: 'manage', operation: task === 'leave' ? 'leave-table' : task, body: metadata() });
  };
  return <Dialog title={title} close={close}><div className="dialog-stack"><CommandFeedback command={command} />
    {!allowed && <p className="notice-error" role="status">{action?.reason ?? 'This action is no longer available for this participant.'}</p>}
    {task === 'stack' ? <form className="seat-form" onSubmit={event => { event.preventDefault(); send(); }}>
      <label>{rebuy ? 'Rebuy to · chips' : 'Top up to · chips'}<input name="targetStack" data-autofocus type="number" inputMode="numeric" step="1" min={bounds.minimum} max={bounds.maximum} required value={amount} aria-invalid={!valid} aria-describedby={hint} onChange={event => setAmount(event.target.value)} /><small id={hint}>{chips(bounds.minimum)}–{chips(bounds.maximum)} chips{!rebuy && valid ? ` · Adds ${chips(target - (participant?.stack ?? 0))} chips` : ''}</small></label>
      <button className="primary" disabled={busy || !allowed || !valid}>{command.sending ? 'Confirming…' : rebuy ? 'Rebuy' : 'Top up'}<span>{valid ? `${chips(target)} chips` : ''}</span></button>
    </form> : task === 'strategy' ? <form className="seat-form" onSubmit={event => { event.preventDefault(); send(); }}><label>Playing Strategy<StrategySelect value={strategy} disabled={busy || !allowed} onChange={setStrategy} /></label><button className="primary" data-autofocus disabled={busy || !allowed}>Apply strategy</button></form> : <>
      <p className="muted">{task === 'leave'
        ? `${action?.timing === 'after-hand' ? 'You finish this hand, then stand up and leave.' : `You stand up and cash out ${chips(participant?.stack ?? 0)} chips.`} You can return from your saved tables or the Join Link.`
        : task === 'remove-participant'
          ? `${name} can’t join this table again, even with a new Join Link. ${action?.timing === 'after-hand' ? 'They finish this hand, then leave.' : 'They stand up, cash out and leave now.'}`
          : `${name} ${action?.timing === 'after-hand' ? 'finishes this hand, then leaves' : 'stands up, cashes out and leaves'}. Its name stays taken.`}</p>
      <div className="button-row"><button className="leave-button" disabled={busy || !allowed} onClick={send}>{command.sending ? 'Confirming…' : task === 'leave' ? 'Leave table' : `Remove ${name}`}</button><button data-autofocus disabled={busy} onClick={close}>Cancel</button></div>
    </>}
  </div></Dialog>;
}

export function AddBotDialog({ table, command, handOpen, close, seat, chooseAgain }: Props & { seat: number; chooseAgain: () => void }) {
  const [name, setName] = useState(() => nextBotName(table));
  const [strategy, setStrategy] = useState<StrategyDescriptor>(defaultPlayingStrategy);
  const [amount, setAmount] = useState(String(table.view.configuration.defaultBuyIn));
  const submit = useCommandDialog(command, close);
  const { minimumBuyIn, maximumBuyIn } = table.view.configuration;
  const valid = name.trim() !== '' && name.trim().length <= 20 && amount.trim() !== '' && Number.isSafeInteger(Number(amount)) && Number(amount) >= minimumBuyIn && Number(amount) <= maximumBuyIn;
  const allowed = table.viewerParticipantId === table.ownerParticipantId && openSeats(table).includes(seat);
  const busy = command.busy || table.runtimeStatus?.phase === 'recovering';
  return <Dialog title={`Add a Bot to seat ${seat}`} close={close}><div className="dialog-stack"><CommandFeedback command={command} />
    {!allowed && <p className="notice-error" role="status">This seat is no longer available. Choose another open seat.</p>}
    <form className="seat-form" onSubmit={event => { event.preventDefault(); if (valid && allowed && !busy) submit({ tableId: table.tableSessionId, kind: 'add-bot', body: { requestId: crypto.randomUUID(), expectedPokerRevision: table.pokerRevision, seat, name: name.trim(), buyIn: Number(amount), playingStrategy: strategy } }); }}>
      <label>Name<input name="botName" data-autofocus value={name} maxLength={20} required onChange={event => setName(event.target.value)} /></label>
      <label>Playing Strategy<StrategySelect value={strategy} disabled={busy} onChange={setStrategy} /></label>
      <label>Buy-in · chips<input name="buyIn" type="number" inputMode="numeric" step="1" min={minimumBuyIn} max={maximumBuyIn} required value={amount} onChange={event => setAmount(event.target.value)} /><small>{chips(minimumBuyIn)}–{chips(maximumBuyIn)} chips</small></label>
      <p className="muted">The Bot is dealt in from the next hand.</p>
      <button className="primary" disabled={busy || !valid || !allowed}>{command.sending ? 'Adding Bot…' : `Add Bot to seat ${seat}`}</button>
      <button className="text-button" type="button" disabled={busy} onClick={chooseAgain}>Choose a different seat</button>
    </form>
  </div></Dialog>;
}
