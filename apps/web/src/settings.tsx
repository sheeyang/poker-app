import { actionTimeLimits, type ObservableTableSession } from '@poker/contracts';
import { useState } from 'react';
import { optionChanges, optionControls, tablePasswordControl } from './owner-controls.js';
import { tablePasswordProblem } from './online-setup.js';
import { PasswordField } from './password-input.js';
import { Dialog } from './dialog.js';
import { CommandFeedback } from './controls.js';
import { DisplayNameForm, useDisplayName } from './display-name.js';
import { chips, modeLabel, playerName } from './table-model.js';
import { useSession, type Command } from './session.js';

/** Table-wide configuration only. Participants and stacks are managed from the table. */
export function TableSettings({ table, command, handOpen, close }: { table: ObservableTableSession; command: Command; handOpen: boolean; close: () => void }) {
  const { displayName } = useDisplayName();
  const animations = useSession(s => s.animations), setAnimations = useSession(s => s.setAnimations);
  const owner = table.viewerParticipantId === table.ownerParticipantId;
  const busy = command.busy || table.runtimeStatus?.phase === 'recovering';
  const disabled = handOpen || busy;
  return <Dialog title="Table options" close={close} wide>
    <div className="settings-summary"><span>{modeLabel(table.mode)} · No-limit Hold’em</span><strong>{chips(table.view.configuration.smallBlind)} / {chips(table.view.configuration.bigBlind)} chips</strong><span>{table.view.configuration.seatCount} seats · Ante {chips(table.view.configuration.ante)}</span></div>
    {table.mode === 'online' && <p className="table-rules muted">{table.options.actionTimeLimitSeconds ? `${table.options.actionTimeLimitSeconds} seconds to act` : 'No time limit'} · Live Analysis {table.options.allowLiveAnalysis ? 'allowed' : 'not allowed'} · Seat changes {table.view.configuration.allowSeatChanges ? 'allowed' : 'not allowed'} · {tablePasswordControl(table).summary}</p>}
    <CommandFeedback command={command} />
    {optionControls(table, handOpen).shown && <TableRules table={table} command={command} editable={!handOpen} busy={busy} />}
    <TablePassword table={table} command={command} busy={busy} />
    {owner && table.mode === 'practice' && <details className="settings-section"><summary>Next dealer button</summary><form className="inline-form" onSubmit={event => { event.preventDefault(); if (!disabled) command.submit({ kind: 'manage', operation: 'set-button', tableId: table.tableSessionId, body: { requestId: crypto.randomUUID(), expectedPokerRevision: table.pokerRevision, seat: Number(new FormData(event.currentTarget).get('buttonSeat')) } }); }}><label>Seat<select name="buttonSeat" defaultValue={table.view.state.buttonSeat} disabled={disabled}>{table.view.state.participants.filter(p => p.seat !== null && !p.sittingOut && p.stack > 0).map(p => <option key={p.seat} value={p.seat!}>{p.seat} · {playerName(table, table.bindings.find(b => b.participantId === p.participantId)!)}</option>)}</select></label><button disabled={disabled}>Set button</button></form></details>}
    <section className="settings-section"><h3>Presentation</h3><label className="check-label"><input type="checkbox" checked={animations} onChange={event => setAnimations(event.target.checked)} />Card animations</label></section>
    <details className="settings-section"><summary>Your name{displayName ? ` · ${displayName}` : ''}</summary><p className="muted">Applies to tables you create or join from now on, not this one.</p><DisplayNameForm current={displayName} /></details>
    <details className="settings-section"><summary>Session details</summary><label>Table Session ID<input readOnly value={table.tableSessionId} onFocus={event => event.target.select()} /></label><p className="muted">Your table is also in your saved tables.</p></details>
    <button className="primary full-width" onClick={close}>Back to the table</button>
  </Dialog>;
}

/**
 * The Table Password: everyone at an Online Table sees whether it is set. The owner sets, changes or removes it at any
 * time, even during a Hand; nobody at the table is affected. What they type stays in this form's memory.
 */
function TablePassword({ table, command, busy }: { table: ObservableTableSession; command: Command; busy: boolean }) {
  const control = tablePasswordControl(table);
  const [typed, setTyped] = useState('');
  // Everyone else reads whether it is set in the rules line above.
  if (!control.shown || !control.editable) return null;
  const problem = tablePasswordProblem(typed);
  const send = (tablePassword: string | null) => {
    if (busy) return;
    command.submit({ kind: 'password', tableId: table.tableSessionId, body: { requestId: crypto.randomUUID(), tablePassword } });
    setTyped('');
  };
  return <details className="settings-section"><summary>Table password · {control.set ? 'Set' : 'None'}</summary>
    <form className="rules-form" onSubmit={event => { event.preventDefault(); if (typed && !problem) send(typed); }}>
      <PasswordField id="table-password-field" label={control.set ? 'New password' : 'Password'} name="tablePassword" value={typed} autoComplete="new-password" disabled={busy} aria-describedby="table-password-hint" onChange={event => setTyped(event.target.value)}
        note={<small id="table-password-hint" className={typed && problem ? 'field-hint is-short' : 'field-hint'}>{typed && problem ? '4 to 64 characters. Capitals count.' : 'Capitals count.'}</small>} />
      <div className="table-password-actions">
        <button type="submit" disabled={busy || !typed || !!problem}>{control.set ? 'Change password' : 'Set password'}</button>
        {control.set && <button type="button" className="quiet-button" disabled={busy} onClick={() => send(null)}>Remove password</button>}
      </div>
    </form>
    <p className="muted">{control.set ? 'Newcomers need it to join, and so does anyone who leaves and comes back.' : 'Without one, anyone with the link can join.'} Changing it never affects anyone already at the table, even during a hand.</p>
  </details>;
}

function TableRules({ table, command, editable, busy }: { table: ObservableTableSession; command: Command; editable: boolean; busy: boolean }) {
  const { options } = table, allowSeatChanges = table.view.configuration.allowSeatChanges;
  const locked = !editable || busy;
  return <details className="settings-section"><summary>Table rules</summary>
    <form key={`${options.actionTimeLimitSeconds}-${allowSeatChanges}-${options.allowLiveAnalysis}`} className="rules-form" onSubmit={event => {
      event.preventDefault();
      const data = new FormData(event.currentTarget);
      const changes = optionChanges(table, { actionTimeLimitSeconds: Number(data.get('timeLimit')), allowSeatChanges: data.get('seatChanges') === 'on', allowLiveAnalysis: data.get('liveAnalysis') === 'on' });
      if (changes && !locked) command.submit({ kind: 'options', tableId: table.tableSessionId, body: { requestId: crypto.randomUUID(), expectedSessionRevision: table.sessionRevision, options: changes } });
    }}>
      <label>Time to act<select name="timeLimit" defaultValue={options.actionTimeLimitSeconds ?? 30} disabled={locked}>{actionTimeLimits.map(seconds => <option key={seconds} value={seconds}>{seconds} seconds</option>)}</select></label>
      <label className="check-label"><input type="checkbox" name="seatChanges" defaultChecked={allowSeatChanges} disabled={locked} />Allow seat changes</label>
      <label className="check-label"><input type="checkbox" name="liveAnalysis" defaultChecked={options.allowLiveAnalysis} disabled={locked} />Allow Live Analysis</label>
      <button disabled={locked}>Apply rules</button>
    </form>
    <p className="muted">{editable ? 'Everyone at the table sees the change, and it applies from the next hand.' : 'Rules change between hands, once the payout has been shown.'}</p>
  </details>;
}
