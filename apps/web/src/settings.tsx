import { actionTimeLimits, type ObservableTableSession } from '@poker/contracts';
import { useState } from 'react';
import { optionChanges, optionControls, tablePasswordControl } from './owner-controls.js';
import { tablePasswordProblem } from './online-setup.js';
import { PasswordField } from './password-input.js';
import { Dialog } from './dialog.js';
import { CommandFeedback } from './controls.js';
import { chips, modeLabel, playerName } from './table-model.js';
import type { Command } from './session.js';

/**
 * Table-wide configuration only. Participants and stacks are managed from the table. Everything here is applied
 * together by one Apply button; the changes are sent one after another, and the first one the server refuses stops the rest.
 */
export function TableSettings({ table, command, handOpen, close }: { table: ObservableTableSession; command: Command; handOpen: boolean; close: () => void }) {
  const busy = command.busy || table.runtimeStatus?.phase === 'recovering';
  return <Dialog title="Table options" close={close}>
    <div className="settings-summary"><span>{modeLabel(table.mode)} · No-limit Hold’em</span><strong>{chips(table.view.configuration.smallBlind)} / {chips(table.view.configuration.bigBlind)} chips</strong><span>{table.view.configuration.seatCount} seats · Ante {chips(table.view.configuration.ante)}</span></div>
    {table.mode === 'online' && !optionControls(table, handOpen).shown && <p className="table-rules muted">{table.options.actionTimeLimitSeconds ? `${table.options.actionTimeLimitSeconds} seconds to act` : 'No time limit'} · Live Analysis {table.options.allowLiveAnalysis ? 'allowed' : 'not allowed'} · Seat changes {table.view.configuration.allowSeatChanges ? 'allowed' : 'not allowed'} · {tablePasswordControl(table).summary}</p>}
    <CommandFeedback command={command} />
    {/* A change the server confirms re-reads the table, which resets the form to what the table now says. */}
    <SettingsForm key={`${table.options.actionTimeLimitSeconds}-${table.view.configuration.allowSeatChanges}-${table.options.allowLiveAnalysis}-${!!table.options.hasTablePassword}-${table.view.state.buttonSeat}`} table={table} command={command} handOpen={handOpen} busy={busy} />
  </Dialog>;
}

function SettingsForm({ table, command, handOpen, busy }: { table: ObservableTableSession; command: Command; handOpen: boolean; busy: boolean }) {
  const owner = table.viewerParticipantId === table.ownerParticipantId;
  const rules = optionControls(table, handOpen), password = tablePasswordControl(table);
  const rulesLocked = !rules.editable || busy;
  const [timeLimit, setTimeLimit] = useState<number>(table.options.actionTimeLimitSeconds ?? 30);
  const [seatChanges, setSeatChanges] = useState(table.view.configuration.allowSeatChanges);
  const [liveAnalysis, setLiveAnalysis] = useState(table.options.allowLiveAnalysis);
  const [typed, setTyped] = useState(''), [removePassword, setRemovePassword] = useState(false);
  const [buttonSeat, setButtonSeat] = useState(table.view.state.buttonSeat);
  const buttonShown = owner && table.mode === 'practice', buttonLocked = handOpen || busy;

  const ruleChanges = rules.shown && !rulesLocked ? optionChanges(table, { actionTimeLimitSeconds: timeLimit, allowSeatChanges: seatChanges, allowLiveAnalysis: liveAnalysis }) : undefined;
  const problem = typed ? tablePasswordProblem(typed) : undefined;
  const passwordChange = password.shown && password.editable && (removePassword || (typed !== '' && !problem));
  const buttonChange = buttonShown && !buttonLocked && buttonSeat !== table.view.state.buttonSeat;
  const canApply = !busy && !problem && (!!ruleChanges || passwordChange || buttonChange);

  async function apply() {
    if (!canApply) return;
    try {
      // The rules go first: they name the table's revision, which a password change would move on.
      if (ruleChanges) await command.run({ kind: 'options', tableId: table.tableSessionId, body: { requestId: crypto.randomUUID(), expectedSessionRevision: table.sessionRevision, options: ruleChanges } });
      if (passwordChange) await command.run({ kind: 'password', tableId: table.tableSessionId, body: { requestId: crypto.randomUUID(), tablePassword: removePassword ? null : typed } });
      if (buttonChange) await command.run({ kind: 'manage', operation: 'set-button', tableId: table.tableSessionId, body: { requestId: crypto.randomUUID(), expectedPokerRevision: table.pokerRevision, seat: buttonSeat } });
    } catch {
      // The refusal is shown above; what was not sent stays in the form to try again.
    }
  }

  const nothingToEdit = !rules.shown && !(password.shown && password.editable) && !buttonShown;
  return <form className="settings-form" onSubmit={event => { event.preventDefault(); void apply(); }}>
    {rules.shown && <section className="settings-section"><h3>Rules</h3>
      <div className="rules-form">
        <label>Time to act<select value={timeLimit} disabled={rulesLocked} onChange={event => setTimeLimit(Number(event.target.value))}>{actionTimeLimits.map(seconds => <option key={seconds} value={seconds}>{seconds} seconds</option>)}</select></label>
        <label className="live-toggle"><span><strong>Seat changes</strong><small>Players can move seats between hands</small></span><input type="checkbox" role="switch" checked={seatChanges} disabled={rulesLocked} onChange={event => setSeatChanges(event.target.checked)} /></label>
        <label className="live-toggle"><span><strong>Live Analysis</strong><small>Show the reference before you act</small></span><input type="checkbox" role="switch" checked={liveAnalysis} disabled={rulesLocked} onChange={event => setLiveAnalysis(event.target.checked)} /></label>
      </div>
      <p className="muted">{rules.editable ? 'Everyone at the table sees the change, and it applies from the next hand.' : 'Rules change between hands, once the payout has been shown.'}</p>
    </section>}
    {password.shown && password.editable && <section className="settings-section"><h3>Table Password</h3>
      <div className="rules-form">
        <PasswordField id="table-password-field" label={password.set ? 'New password' : 'Password'} name="tablePassword" value={typed} autoComplete="new-password" disabled={busy || removePassword} aria-describedby="table-password-hint" onChange={event => setTyped(event.target.value)}
          note={<small id="table-password-hint" className={typed && problem ? 'field-hint is-short' : 'field-hint'}>{typed && problem ? '4 to 64 characters. Capitals count.' : 'Capitals count.'}</small>} />
        {password.set && <label className="live-toggle"><span><strong>Remove password</strong><small>Anyone with the link can join</small></span><input type="checkbox" role="switch" checked={removePassword} disabled={busy} onChange={event => { setRemovePassword(event.target.checked); if (event.target.checked) setTyped(''); }} /></label>}
      </div>
      <p className="muted">{password.set ? 'Newcomers need it to join, and so does anyone who leaves and comes back.' : 'Without one, anyone with the link can join.'} Changing it never affects anyone already at the table, even during a hand.</p>
    </section>}
    {buttonShown && <section className="settings-section"><h3>Next dealer button</h3>
      <label>Seat<select value={buttonSeat} disabled={buttonLocked} onChange={event => setButtonSeat(Number(event.target.value))}>{table.view.state.participants.filter(p => p.seat !== null && !p.sittingOut && p.stack > 0).map(p => <option key={p.seat} value={p.seat!}>{p.seat} · {playerName(table, table.bindings.find(b => b.participantId === p.participantId)!)}</option>)}</select></label>
    </section>}
    {!nothingToEdit && <button type="submit" className="primary full-width settings-apply" disabled={!canApply}>{busy ? 'Applying…' : 'Apply'}</button>}
  </form>;
}
