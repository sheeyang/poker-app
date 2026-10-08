import { AttemptRecovery } from './recovery.js';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import type { ConcreteAction, LegalAction, ObservableTableSession } from '@poker/contracts';
import { api, RequestFailure } from './api.js';
import { usePlayground, type PendingHand } from './store.js';

export function Hand({ table }: { table: ObservableTableSession }) {
  const queryClient = useQueryClient();
  const pending = usePlayground(state => state.pendingHand);
  const seating = usePlayground(state => state.pendingSeating);
  const management = usePlayground(state => state.pendingManagement);
  const setPending = usePlayground(state => state.setPendingHand);
  const ownPending = pending?.tableSessionId === table.tableSessionId ? pending : null;
  const state = table.view.state;
  const human = table.bindings.find(b => b.controller.kind === 'human')!;
  const name = (id: string) => table.bindings.find(b => b.participantId === id)?.name ?? id;
  const mutation = useMutation({
    mutationFn: (attempt: PendingHand) => attempt.kind === 'start-hand' ? api.startHand(attempt.tableSessionId, attempt.request) : api.act(attempt.tableSessionId, attempt.request),
    retry: false,
    onSuccess: async (_result, attempt) => { setPending(null); await queryClient.invalidateQueries({ queryKey: ['table-session', attempt.tableSessionId] }); },
    onError: async (error, attempt) => {
      if (error instanceof RequestFailure && error.definitive) setPending(null);
      await queryClient.invalidateQueries({ queryKey: ['table-session', attempt.tableSessionId] });
    },
  });
  function submit(choice: 'start-hand' | ConcreteAction) {
    const metadata = { requestId: crypto.randomUUID(), expectedPokerRevision: table.pokerRevision };
    const attempt: PendingHand = choice === 'start-hand'
      ? { tableSessionId: table.tableSessionId, kind: 'start-hand', request: metadata }
      : { tableSessionId: table.tableSessionId, kind: 'act', request: { ...metadata, participantId: human.participantId, action: choice } };
    setPending(attempt); mutation.mutate(attempt);
  }
  const eligible = state.participants.filter(p => p.seat !== null && !p.sittingOut && p.stack > 0).length;
  const busy = table.runtimeStatus?.phase === 'recovering' || mutation.isPending || !!pending || !!seating || !!management;
  const pot = state.status === 'active-hand' ? state.participants.reduce((sum, p) => sum + (p.contribution ?? 0), 0) : state.pots.reduce((sum, p) => sum + p.amount, 0);
  const callAmount = state.amountToCall ?? 0;
  const showdown = state.status === 'completed-hand' && state.board.length === 5 && state.participants.filter(p => p.inHand && !p.folded).length > 1;
  return <section className="hand-controls" aria-labelledby="hand-heading">
    <h3 id="hand-heading">{state.handId ? `Hand ${state.handId.slice(5)}` : 'Start a Hand'}</h3>
    <dl className="table-facts">
      <div><dt>Status</dt><dd>{state.status === 'active-hand' ? 'Hand in progress' : state.status === 'completed-hand' ? 'Hand completed' : 'Between Hands'}</dd></div>
      <div><dt>Street</dt><dd>{state.street ?? '—'}</dd></div>
      <div><dt>Pot</dt><dd>{pot} chips</dd></div>
      <div><dt>Current actor</dt><dd>{state.actorId ? name(state.actorId) : '—'}</dd></div>
    </dl>
    {state.board.length > 0 && <p aria-label="Community cards">Board: <span className="community-cards">{state.board.join(' ')}</span></p>}
    {state.pots.length > 0 && <ol className="pot-layers" aria-label="Pot layers">{state.pots.map((layer, index) => <li key={index}>
      <strong>{index === 0 ? 'Main pot' : `Side pot ${index}`} · {layer.amount} chips</strong>
      <span>Eligible: {layer.eligibleParticipantIds.map(name).join(', ')}</span>
    </li>)}</ol>}
    {showdown && <p className="help">Showdown: all live hole cards are public.</p>}
    {state.status !== 'active-hand' && <>
      <p className="help">{eligible < 2 ? state.participants.some(p => p.seat !== null && p.stack === 0) ? 'At least two Participants need chips to start. Rebuy a zero stack in Manage between Hands.' : 'Seat at least two Participants with chips to start a Hand.' : state.status === 'completed-hand' ? 'The Hand has settled. Start another Hand when ready.' : 'Start Hand posts forced bets and deals private cards.'}</p>
      <button className="primary" disabled={busy || eligible < 2} onClick={() => submit('start-hand')}>Start Hand</button>
    </>}
    {state.actorId === human.participantId && <>
      <div className="hand-actions">
        {(['check', 'call', 'fold'] as const).filter(type => state.legalActions.some(a => a.type === type)).map(type => <button key={type} disabled={busy} onClick={() => submit({ type })}>{type === 'call' ? `Call ${callAmount} chips` : type === 'check' ? 'Check' : 'Fold'}</button>)}
      </div>
      {state.legalActions.filter((action): action is Extract<LegalAction, { minimum: number }> => 'minimum' in action).map(action => <SizedAction key={`${table.tableSessionId}/${state.decisionId}/${action.type}`} action={action} disabled={busy} submit={submit} />)}
    </>}
    {state.actorId && state.actorId !== human.participantId && <p role="status">Waiting for {name(state.actorId)}.</p>}
    {state.payouts?.map((p, i) => <p key={i}>{name(p.participantId)} won {p.amount} chips.</p>)}
    {state.returns?.map((p, i) => <p key={i}>{p.amount} uncalled chips returned to {name(p.participantId)}.</p>)}
    {mutation.isPending && <p role="status">Saving the Hand command…</p>}
    {mutation.error && <p role="alert" className="error"><strong>{mutation.error instanceof RequestFailure && mutation.error.code === 'commit-not-applied' ? 'Attempt did not commit. ' : mutation.error instanceof RequestFailure && mutation.error.definitive ? 'Hand command rejected. ' : 'Hand command awaiting confirmation. '}</strong>{mutation.error.message}</p>}
    {ownPending && !mutation.isPending && <AttemptRecovery error={mutation.error} check={() => mutation.mutate(ownPending)} dismiss={() => { setPending(null); mutation.reset(); }} />}
    {pending && !ownPending && <p className="help">Resolve the pending Hand command in its Table Session before submitting another.</p>}
  </section>;
}

function SizedAction({ action, disabled, submit }: { action: Extract<LegalAction, { minimum: number }>; disabled: boolean; submit: (action: ConcreteAction) => void }) {
  const [amount, setAmount] = useState(String(action.minimum));
  const helpId = useId();
  const label = action.type === 'bet' ? 'Bet-to' : 'Raise-to';
  return <form className="sized-action" onSubmit={event => {
    event.preventDefault();
    const total = Number(amount);
    submit(action.type === 'bet' ? { type: 'bet', betTo: total } : { type: 'raise', raiseTo: total });
  }}>
    <div className="sized-action-fields">
      <label>{label} total (chips)
        <input name={action.type === 'bet' ? 'betTo' : 'raiseTo'} type="number" inputMode="numeric" required step="1" min={action.minimum} max={action.maximum} value={amount} onChange={event => setAmount(event.target.value)} disabled={disabled} aria-describedby={helpId} />
      </label>
      <button type="submit" disabled={disabled}>{label}</button>
    </div>
    <p className="help" id={helpId}>Your total commitment on this street after acting, including chips already wagered. {action.minimum === action.maximum ? `Only legal total: ${action.minimum} chips (all-in).` : `Legal total: ${action.minimum}–${action.maximum} chips, inclusive.`}</p>
  </form>;
}
