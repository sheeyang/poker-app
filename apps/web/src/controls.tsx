import { useId, useState } from 'react';
import type { ConcreteAction, ObservableTableSession } from '@poker/contracts';
import { RequestFailure } from '@poker/client';
import { Icon } from './icons.js';
import { actionLabel, chips, potTotal, presetTotal, type SizedAction } from './table-model.js';
import { useSession, type Command } from './session.js';

export function CommandFeedback({ command }: { command: Command }) {
  if (command.sending || !command.pending && !command.error) return null;
  const aborted = command.error instanceof RequestFailure && command.error.code === 'commit-not-applied';
  return <div className={`command-feedback ${command.error ? 'notice-error' : ''}`} role={command.error ? 'alert' : 'status'}>
    <div><strong>{command.sending ? 'Confirming your request…' : aborted ? 'This attempt was not applied.' : command.pending ? 'Waiting for confirmation.' : 'The request was not accepted.'}</strong><p>{command.error?.message ?? 'Your last confirmed table stays visible.'}</p></div>
    {command.pending && !command.sending && !aborted && <button onClick={command.check}>Check status</button>}
    {(!command.pending || aborted) && <button onClick={command.dismiss}>{aborted ? 'Start a new attempt' : 'Dismiss'}</button>}
  </div>;
}

export function ActionTray({ table, command, openSettings, review }: { table: ObservableTableSession; command: Command; openSettings: () => void; review?: (decisionId?: string) => void }) {
  const state = table.view.state;
  const human = table.bindings.find(b => b.controller.kind === 'human')!;
  const participant = state.participants.find(p => p.participantId === human.participantId);
  const busy = command.busy || table.runtimeStatus?.phase === 'recovering';
  const submit = (action: 'start' | ConcreteAction) => {
    const metadata = { requestId: crypto.randomUUID(), expectedPokerRevision: table.pokerRevision };
    command.submit(action === 'start' ? { tableId: table.tableSessionId, kind: 'start', body: metadata } : { tableId: table.tableSessionId, kind: 'act', body: { ...metadata, participantId: human.participantId, action } });
  };
  const sized = state.legalActions.find((a): a is SizedAction => 'minimum' in a);
  if (state.status !== 'active-hand') return <NextHand table={table} busy={busy} openSettings={openSettings} review={review} />;
  if (state.actorId !== human.participantId) return <div className="action-tray idle-tray" role="status"><div><strong>{participant?.folded ? 'You folded.' : participant?.allIn ? 'You’re all-in.' : participant?.sittingOut ? 'You’re sitting out.' : 'The hand is in play.'}</strong><p>{table.runtimeStatus?.phase === 'failed' ? 'Use Retry bot decision above the table to continue.' : `Waiting for ${table.bindings.find(b => b.participantId === state.actorId)?.name ?? 'the table'}.`}</p></div><span className="waiting-dots" aria-hidden="true"><i /><i /><i /></span></div>;
  return <div className="action-tray">
    <div className="action-context"><span>Stack {chips(participant?.stack ?? 0)} chips</span></div>
    <div className="quick-actions">{state.legalActions.filter(a => !('minimum' in a)).map(a => <button className={`action-button action-${a.type}`} key={a.type} disabled={busy} onClick={() => submit({ type: a.type } as ConcreteAction)}><span>{actionLabel({ type: a.type } as ConcreteAction)}</span>{a.type === 'call' && <strong>{chips(state.amountToCall ?? 0)}</strong>}</button>)}</div>
    {sized && <Sizing key={`${state.decisionId}-${sized.type}`} action={sized} table={table} disabled={busy} submit={submit} />}
  </div>;
}

function NextHand({ table, busy, openSettings, review }: { table: ObservableTableSession; busy: boolean; openSettings: () => void; review?: (decisionId?: string) => void }) {
  const state = table.view.state, setup = useSession(s => s.setup), setSetup = useSession(s => s.setSetup);
  const human = state.participants.find(p => p.participantId === table.bindings.find(b => b.controller.kind === 'human')?.participantId);
  const refills = state.participants.filter(p => p.seat !== null && p.stack === 0 && (!p.sittingOut || p === human));
  const needsSeat = human?.seat == null;
  const available = state.participants.filter(p => p.seat !== null && (!p.sittingOut || p === human)).length + (needsSeat ? 1 : 0);
  const preparing = setup?.tableId === table.tableSessionId;
  const decisions = table.view.history.find(h => h.handId === state.handId)?.decisions.filter(d => d.action.participantId === human?.participantId) ?? [];
  return <div className="action-tray idle-tray next-hand">
    {(preparing || refills.length > 0 || needsSeat || human?.sittingOut) && <p>{preparing ? 'Preparing your next hand…' : refills.length ? `${refills.map(p => p === human ? 'You' : table.bindings.find(b => b.participantId === p.participantId)?.name).join(', ')}: rebuy to ${chips(table.view.configuration.defaultBuyIn)} chips each.` : needsSeat ? 'We’ll return you to an open seat.' : 'You’ll return from sitting out.'}</p>}
    <div className="next-hand-actions">
    {state.status === 'completed-hand' && review && <button className="quiet-button" disabled={!decisions.length} onClick={() => review(decisions.at(-1)?.decisionId)}>Review hand <Icon name="chart" size={17} /></button>}
    {available < 2 ? <button className="primary" onClick={openSettings}>Add an opponent <Icon name="arrow" /></button> : <button className="primary deal-button" disabled={busy || preparing} onClick={() => setSetup({ requestId: crypto.randomUUID(), tableId: table.tableSessionId, afterHandId: state.handId ?? null })}><Icon name="cards" />{refills.length ? 'Rebuy & deal' : human?.sittingOut || needsSeat ? 'Return & deal' : state.handId ? 'Deal next hand' : 'Deal first hand'}</button>}
    </div>
  </div>;
}

function Sizing({ action, table, disabled, submit }: { action: SizedAction; table: ObservableTableSession; disabled: boolean; submit: (action: ConcreteAction) => void }) {
  const [amount, setAmount] = useState(String(action.minimum));
  const help = useId();
  const humanId = table.bindings.find(b => b.controller.kind === 'human')!.participantId;
  const wager = table.view.state.participants.find(p => p.participantId === humanId)?.wager ?? 0;
  const total = Number(amount);
  const valid = amount.trim() !== '' && Number.isSafeInteger(total) && total >= action.minimum && total <= action.maximum;
  const label = action.type === 'bet' ? 'Bet to' : 'Raise to';
  const presets = [0.5, 0.75, 1].map((fraction, i) => ({ label: ['½ pot', '¾ pot', 'Pot'][i]!, value: presetTotal(action, potTotal(table.view.state), table.view.state.amountToCall ?? 0, wager, fraction) }));
  return <form className="sizing" onSubmit={event => { event.preventDefault(); if (valid && !disabled) submit(action.type === 'bet' ? { type: 'bet', betTo: total } : { type: 'raise', raiseTo: total }); }}>
    <div className="sizing-tools"><div className="presets">{presets.filter((p, i) => presets.findIndex(q => q.value === p.value) === i).map(p => <button key={p.label} type="button" disabled={disabled} onClick={() => setAmount(String(p.value))}>{p.label}</button>)}<button type="button" disabled={disabled} onClick={() => setAmount(String(action.maximum))}>All-in</button></div>
      <label className="amount-field"><span>{label}</span><input name="actionTotal" aria-describedby={help} type="number" inputMode="numeric" step="1" required min={action.minimum} max={action.maximum} value={amount} disabled={disabled} onChange={e => setAmount(e.target.value)} /></label>
      <input aria-label={`${label} total slider`} type="range" min={action.minimum} max={action.maximum} step="1" value={valid ? total : action.minimum} disabled={disabled} onChange={e => setAmount(e.target.value)} />
    </div>
    <button type="submit" className="primary action-button" disabled={disabled || !valid}><span>{label}</span><strong>{valid ? chips(total) : '—'}</strong></button>
    <p id={help} className="sizing-hint">Total on this street · {chips(action.minimum)}–{chips(action.maximum)} chips</p>
  </form>;
}
