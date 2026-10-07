import { useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ObservableTableSession, ParticipantManagementKind, ParticipantManagementRequest, PokerMutationMetadata } from '@poker/contracts';
import { api, RequestFailure } from './api.js';
import { usePlayground, type PendingManagement } from './store.js';

type Contents<T> = T extends PokerMutationMetadata ? Omit<T, keyof PokerMutationMetadata> : never;
export function Management({ table }: { table: ObservableTableSession }) {
  const queryClient = useQueryClient();
  const pending = usePlayground(state => state.pendingManagement);
  const seating = usePlayground(state => state.pendingSeating);
  const hand = usePlayground(state => state.pendingHand);
  const setPending = usePlayground(state => state.setPendingManagement);
  const [participantId, setParticipantId] = useState('');
  const [seat, setSeat] = useState('');
  const [target, setTarget] = useState('');
  const [buttonSeat, setButtonSeat] = useState('');
  const [feedback, setFeedback] = useState<{ text: string; pokerRevision: number } | null>(null);
  const seated = table.view.state.participants.filter(p => p.seat !== null);
  const participant = seated.find(p => p.participantId === participantId) ?? seated[0];
  const name = (id: string) => table.bindings.find(b => b.participantId === id)?.name ?? id;
  const emptySeats = Array.from({ length: table.view.configuration.seatCount }, (_, index) => index + 1).filter(number => !seated.some(p => p.seat === number));
  const chosenSeat = emptySeats.includes(Number(seat)) ? seat : String(emptySeats[0] ?? '');
  const eligible = seated.filter(p => !p.sittingOut && p.stack > 0);
  const chosenButton = eligible.some(p => p.seat === Number(buttonSeat)) ? buttonSeat : String(eligible[0]?.seat ?? '');
  const ownPending = pending?.tableSessionId === table.tableSessionId ? pending : null;
  const mutation = useMutation({
    mutationFn: (attempt: PendingManagement) => api.manageParticipant(attempt.tableSessionId, attempt.kind, attempt.request),
    retry: false,
    onSuccess: async (result, attempt) => {
      setPending(null); setFeedback({ text: attempt.feedback, pokerRevision: result.pokerRevision }); setTarget('');
      await queryClient.invalidateQueries({ queryKey: ['table-session', attempt.tableSessionId] });
    },
    onError: async (error, attempt) => {
      if (error instanceof RequestFailure && error.definitive) setPending(null);
      await queryClient.invalidateQueries({ queryKey: ['table-session', attempt.tableSessionId] });
    },
  });
  function submit(kind: ParticipantManagementKind, contents: Contents<ParticipantManagementRequest>, message: string) {
    const request = { ...contents, requestId: crypto.randomUUID(), expectedPokerRevision: table.pokerRevision } as ParticipantManagementRequest;
    const attempt = { tableSessionId: table.tableSessionId, kind, request, feedback: message };
    setFeedback(null); setPending(attempt); mutation.mutate(attempt);
  }
  function move(event: FormEvent) {
    event.preventDefault();
    if (participant) submit('move-participant', { participantId: participant.participantId, seat: Number(chosenSeat) }, `${name(participant.participantId)} moved to Seat ${chosenSeat}.`);
  }
  function topUp(event: FormEvent) {
    event.preventDefault();
    if (participant) submit('top-up-to', { participantId: participant.participantId, targetStack: Number(target) }, `Stack set to ${target} chips. Added ${Number(target) - participant.stack} chips for ${name(participant.participantId)}.`);
  }
  function button(event: FormEvent) {
    event.preventDefault();
    submit('set-button', { seat: Number(chosenButton) }, `Seat ${chosenButton} is the button for the next Hand.`);
  }
  const busy = mutation.isPending || !!pending || !!seating || !!hand;
  const active = table.view.state.status === 'active-hand';
  const paused = mutation.error instanceof RequestFailure && ['commit-outcome-unknown', 'session-recovering'].includes(mutation.error.code);
  return <section className="management-controls" aria-labelledby="management-heading">
    <h3 id="management-heading">Manage between Hands</h3>
    <p className="help">{active ? 'Complete the current Hand to change seats, stacks, sitting-out status, or the next button.' : 'Changes apply to the next Hand. Participant identity and prior observations continue across moves and rejoining.'}</p>
    <fieldset disabled={busy || active || !participant}>
      <label>Manage Participant<select name="managedParticipantId" value={participant?.participantId ?? ''} onChange={event => { setParticipantId(event.target.value); setTarget(''); }}>
        {!participant && <option value="">Seat a Participant first</option>}
        {seated.map(p => <option key={p.participantId} value={p.participantId}>{name(p.participantId)} · Seat {p.seat} · {p.stack} chips{p.sittingOut ? ' · Sitting out' : ''}</option>)}
      </select></label>
      <div className="management-actions">
        <button type="button" onClick={() => participant && submit('set-sitting-out', { participantId: participant.participantId, sittingOut: !participant.sittingOut }, `${name(participant.participantId)} ${participant.sittingOut ? 'returned to play' : 'will sit out until returned to play'}.`)}>{participant?.sittingOut ? 'Return to play' : 'Sit out'}</button>
        <button type="button" onClick={() => participant && submit('leave-participant', { participantId: participant.participantId }, `${name(participant.participantId)} left and cashed out ${participant.stack} chips. Reseat this Participant to rejoin.`)}>Leave and cash out {participant?.stack ?? 0} chips</button>
      </div>
      <div className="management-fields">
        <form onSubmit={move}>
          <label>Move to seat<select name="moveSeat" disabled={!table.view.configuration.allowSeatChanges || emptySeats.length === 0} value={chosenSeat} onChange={event => setSeat(event.target.value)}>
            {emptySeats.map(number => <option key={number} value={number}>Seat {number}</option>)}
          </select></label>
          <button type="submit" disabled={!table.view.configuration.allowSeatChanges || emptySeats.length === 0}>Move Participant</button>
          {!table.view.configuration.allowSeatChanges && <p className="help">Seat changes are disabled for this Table Session.</p>}
          {table.view.configuration.allowSeatChanges && emptySeats.length === 0 && <p className="help">No empty seats are available.</p>}
        </form>
        <form onSubmit={topUp}>
          <label>Target resulting stack<input name="targetStack" type="number" required disabled={!participant || participant.stack >= table.view.configuration.maximumBuyIn} min={participant?.stack === 0 ? Math.max(1, table.view.configuration.minimumBuyIn) : Math.min((participant?.stack ?? 0) + 1, table.view.configuration.maximumBuyIn)} max={table.view.configuration.maximumBuyIn} step="1" value={target} onChange={event => setTarget(event.target.value)} aria-describedby="target-stack-help" /></label>
          <button type="submit" disabled={!participant || participant.stack >= table.view.configuration.maximumBuyIn}>{participant?.stack === 0 ? 'Rebuy to target' : 'Top up to target'}</button>
          <p className="help" id="target-stack-help">{participant && participant.stack >= table.view.configuration.maximumBuyIn ? 'This stack is at or above the maximum buy-in. No top-up is available. ' : participant?.stack === 0 ? `Rebuy to at least ${table.view.configuration.minimumBuyIn} chips. ` : 'Enter the stack you want after adding chips. '}Maximum {table.view.configuration.maximumBuyIn} chips.{participant && target !== '' && Number(target) > participant.stack ? ` Adds ${Number(target) - participant.stack} chips.` : ''}</p>
        </form>
      </div>
    </fieldset>
    <form onSubmit={button}>
      <fieldset disabled={busy || active || eligible.length === 0}>
        <div className="button-fields">
          <label>Next Hand button<select name="buttonSeat" value={chosenButton} onChange={event => setButtonSeat(event.target.value)}>
            {eligible.length === 0 && <option value="">No eligible Participants</option>}
            {eligible.map(p => <option key={p.participantId} value={p.seat!}>Seat {p.seat} · {name(p.participantId)}</option>)}
          </select></label>
          <button type="submit">Set next button</button>
        </div>
        <p className="help">An explicit choice overrides clockwise rotation for the next Hand.</p>
      </fieldset>
    </form>
    {mutation.isPending && <p role="status">Saving the table change…</p>}
    {feedback?.pokerRevision === table.pokerRevision && <p role="status" className="success">{feedback.text}</p>}
    {mutation.error && <p role="alert" className="error"><strong>{mutation.error instanceof RequestFailure && mutation.error.definitive ? 'Table change rejected. ' : 'Table change awaiting confirmation. '}</strong>{mutation.error.message}</p>}
    {ownPending && !mutation.isPending && <div className="pending-attempt">
      <p>{paused ? 'This session is paused pending durable recovery. Refresh its view to check the committed table.' : 'The outcome is unconfirmed. Refresh the view or retry this same attempt.'}</p>
      {!paused && <button onClick={() => mutation.mutate(ownPending)}>Retry table change</button>}
    </div>}
    {pending && !ownPending && <p className="help">Resolve the pending table change in its Table Session before submitting another.</p>}
  </section>;
}
