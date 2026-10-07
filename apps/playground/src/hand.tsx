import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ObservableTableSession } from '@poker/contracts';
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
  function submit(kind: 'start-hand' | 'act') {
    const metadata = { requestId: crypto.randomUUID(), expectedPokerRevision: table.pokerRevision };
    const attempt: PendingHand = kind === 'start-hand'
      ? { tableSessionId: table.tableSessionId, kind, request: metadata }
      : { tableSessionId: table.tableSessionId, kind, request: { ...metadata, participantId: human.participantId, action: { type: 'fold' } } };
    setPending(attempt); mutation.mutate(attempt);
  }
  const eligible = state.participants.filter(p => p.seat !== null && !p.sittingOut && p.stack > 0).length;
  const busy = mutation.isPending || !!pending || !!seating || !!management;
  const pot = state.status === 'active-hand' ? state.participants.reduce((sum, p) => sum + (p.contribution ?? 0), 0) : state.pots.reduce((sum, p) => sum + p.amount, 0);
  const paused = mutation.error instanceof RequestFailure && ['commit-outcome-unknown', 'session-recovering'].includes(mutation.error.code);
  return <section className="hand-controls" aria-labelledby="hand-heading">
    <h3 id="hand-heading">{state.handId ? `Hand ${state.handId.slice(5)}` : 'Start a Hand'}</h3>
    <dl className="table-facts">
      <div><dt>Status</dt><dd>{state.status === 'active-hand' ? 'Hand in progress' : state.status === 'completed-hand' ? 'Hand completed' : 'Between Hands'}</dd></div>
      <div><dt>Street</dt><dd>{state.street ?? '—'}</dd></div>
      <div><dt>Pot</dt><dd>{pot} chips</dd></div>
      <div><dt>Current actor</dt><dd>{state.actorId ? name(state.actorId) : '—'}</dd></div>
    </dl>
    {state.board.length > 0 && <p>Board: {state.board.join(' ')}</p>}
    {state.status !== 'active-hand' && <>
      <p className="help">{eligible < 2 ? 'Seat at least two Participants with chips to start a Hand.' : state.status === 'completed-hand' ? 'The Hand has settled. Start another Hand when ready.' : 'Start Hand posts forced bets and deals private cards.'}</p>
      <button className="primary" disabled={busy || eligible < 2} onClick={() => submit('start-hand')}>Start Hand</button>
    </>}
    {state.actorId === human.participantId && state.legalActions.some(a => a.type === 'fold') && <button disabled={busy} onClick={() => submit('act')}>Fold</button>}
    {state.actorId && state.actorId !== human.participantId && <p role="status">Waiting for {name(state.actorId)}.</p>}
    {state.payouts?.map((p, i) => <p key={i}>{name(p.participantId)} won {p.amount} chips.</p>)}
    {state.returns?.map((p, i) => <p key={i}>{p.amount} uncalled chips returned to {name(p.participantId)}.</p>)}
    {mutation.isPending && <p role="status">Saving the Hand command…</p>}
    {mutation.error && <p role="alert" className="error"><strong>{mutation.error instanceof RequestFailure && mutation.error.definitive ? 'Hand command rejected. ' : 'Hand command awaiting confirmation. '}</strong>{mutation.error.message}</p>}
    {ownPending && !mutation.isPending && <div className="pending-attempt">
      <p>{paused ? 'This session is paused pending durable recovery. Refresh its view to check the committed table.' : 'The outcome is unconfirmed. Refresh the view or retry this same attempt.'}</p>
      {!paused && <button onClick={() => mutation.mutate(ownPending)}>Retry Hand command</button>}
    </div>}
    {pending && !ownPending && <p className="help">Resolve the pending Hand command in its Table Session before submitting another.</p>}
  </section>;
}
