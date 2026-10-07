import { useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ObservableTableSession } from '@poker/contracts';
import { api, RequestFailure } from './api.js';
import { usePlayground, type PendingSeating } from './store.js';

export function Seating({ table }: { table: ObservableTableSession }) {
  const pendingManagement = usePlayground(state => state.pendingManagement);
  const queryClient = useQueryClient();
  const pending = usePlayground(state => state.pendingSeating);
  const pendingHand = usePlayground(state => state.pendingHand);
  const setPending = usePlayground(state => state.setPendingSeating);
  const [participantId, setParticipantId] = useState('');
  const [seat, setSeat] = useState('');
  const [buyIn, setBuyIn] = useState('');
  const participants = table.view.state.participants;
  const unseated = table.bindings.filter(binding => !participants.some(p => p.participantId === binding.participantId && p.seat !== null));
  const emptySeats = Array.from({ length: table.view.configuration.seatCount }, (_, index) => index + 1).filter(number => !participants.some(p => p.seat === number));
  const chosenParticipant = unseated.some(p => p.participantId === participantId) ? participantId : unseated[0]?.participantId ?? '';
  const chosenSeat = emptySeats.includes(Number(seat)) ? seat : String(emptySeats[0] ?? '');
  const ownPending = pending?.tableSessionId === table.tableSessionId ? pending : null;
  const mutation = useMutation({
    mutationFn: (attempt: PendingSeating) => api.seatParticipant(attempt.tableSessionId, attempt.request),
    retry: false,
    onSuccess: async (_result, attempt) => {
      setPending(null);
      setParticipantId(''); setSeat(''); setBuyIn('');
      await queryClient.invalidateQueries({ queryKey: ['table-session', attempt.tableSessionId] });
    },
    onError: async (error, attempt) => {
      if (error instanceof RequestFailure && error.definitive) setPending(null);
      await queryClient.invalidateQueries({ queryKey: ['table-session', attempt.tableSessionId] });
    },
  });
  function submit(event: FormEvent) {
    event.preventDefault();
    const attempt = { tableSessionId: table.tableSessionId, request: {
      requestId: crypto.randomUUID(), expectedPokerRevision: table.pokerRevision,
      participantId: chosenParticipant, seat: Number(chosenSeat), ...(buyIn === '' ? {} : { buyIn: Number(buyIn) }),
    } };
    setPending(attempt);
    mutation.mutate(attempt);
  }
  const error = mutation.error;
  const awaitingConfirmation = !!ownPending && !mutation.isPending;
  const paused = error instanceof RequestFailure && ['commit-outcome-unknown', 'session-recovering'].includes(error.code);
  return <section className="seating-controls" aria-labelledby="seating-heading">
    <h3 id="seating-heading">Seat a Participant</h3>
    <p className="help">Choose an empty seat. Buy-in limits are {table.view.configuration.minimumBuyIn}–{table.view.configuration.maximumBuyIn} chips.</p>
    <form onSubmit={submit}>
      <fieldset disabled={mutation.isPending || !!pending || !!pendingHand || !!pendingManagement || table.view.state.status === 'active-hand' || unseated.length === 0 || emptySeats.length === 0}>
        <div className="seating-fields">
          <label>Participant<select name="participantId" required value={chosenParticipant} onChange={event => setParticipantId(event.target.value)}>
            {unseated.length === 0 && <option value="">All Participants seated</option>}
            {unseated.map(binding => <option key={binding.participantId} value={binding.participantId}>{binding.name} · {binding.controller.kind === 'human' ? 'Human' : 'Bot'}</option>)}
          </select></label>
          <label>Seat<select name="seat" required value={chosenSeat} onChange={event => setSeat(event.target.value)}>
            {emptySeats.map(number => <option key={number} value={number}>Seat {number}</option>)}
          </select></label>
          <label>Buy-in<input name="buyIn" type="number" min={table.view.configuration.minimumBuyIn} max={table.view.configuration.maximumBuyIn} step="1" value={buyIn} placeholder={String(table.view.configuration.defaultBuyIn)} onChange={event => setBuyIn(event.target.value)} aria-describedby="buy-in-help" /></label>
          <button type="submit">Seat Participant</button>
        </div>
        <p id="buy-in-help" className="help">Leave buy-in empty to use the default of {table.view.configuration.defaultBuyIn} chips.</p>
      </fieldset>
    </form>
    {mutation.isPending && <p role="status">Saving seat and buy-in…</p>}
    {mutation.isSuccess && <p role="status" className="success">Seat saved. The table shows the committed seat and stack.</p>}
    {error && <p role="alert" className="error"><strong>{error instanceof RequestFailure ? error.code === 'stale-poker-revision' ? 'Seating needs a refresh. ' : error.definitive ? 'Seating rejected. ' : 'Seating awaiting confirmation. ' : 'Seating awaiting confirmation. '}</strong>{error.message}</p>}
    {awaitingConfirmation && <div className="pending-attempt">
      <p>{paused ? 'This session is paused pending durable recovery. Refresh its view to check the committed table.' : 'The outcome has not been confirmed. Refresh the view or explicitly retry this same attempt.'}</p>
      {!paused && <button onClick={() => mutation.mutate(ownPending)}>Retry seating attempt</button>}
    </div>}
    {pending && !ownPending && <p className="help">Resolve the pending seating attempt in its Table Session before submitting another.</p>}
    {unseated.length === 0 && <p className="help">All configured Participants are seated.</p>}
  </section>;
}
