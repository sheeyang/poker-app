import { useState, type FormEvent } from 'react';
import { useMutation } from '@tanstack/react-query';
import type { InspectionCapabilities, ObservableTableSession } from '@poker/contracts';
import { api } from './api.js';

export function Inspection({ table, capabilities }: { table: ObservableTableSession; capabilities: InspectionCapabilities }) {
  const [selection, setSelection] = useState('');
  const selected = capabilities.completedHands.some(hand => hand.handId === selection) ? selection : capabilities.completedHands[0]?.handId ?? '';
  const reveal = useMutation({ mutationFn: (handId: string) => api.inspectHand(table.tableSessionId, handId) });
  const hand = reveal.data?.hand.handId === selected ? reveal.data.hand : undefined;
  const name = (id: string) => table.bindings.find(binding => binding.participantId === id)?.name ?? id;
  function submit(event: FormEvent) { event.preventDefault(); if (selected) reveal.mutate(selected); }
  return <section className="inspection-controls" aria-label="Completed-Hand inspection">
    <h3>Completed-Hand inspection · Admin Mode</h3>
    <p className="help">Choose a completed Hand to reveal its cards, deal and payout facts.</p>
    {capabilities.completedHands.length === 0 ? <p className="help">Complete a Hand to make it available for inspection.</p> : <form onSubmit={submit}>
      <div className="inspection-fields">
        <label>Completed Hand<select name="completedHand" value={selected} disabled={reveal.isPending} onChange={event => { setSelection(event.target.value); reveal.reset(); }}>
          {capabilities.completedHands.map(hand => <option key={hand.handId} value={hand.handId}>Hand {hand.sequence}</option>)}
        </select></label>
        <button type="submit" disabled={reveal.isPending || !selected}>Reveal Hidden Information</button>
      </div>
    </form>}
    {reveal.isPending && <p role="status">Reconstructing the completed Hand…</p>}
    {reveal.error && <p role="alert" className="error">{reveal.error.message}</p>}
    {hand && <div className="inspection-result">
      <h3>Revealed Hand {hand.sequence}</h3>
      <p className="help">These facts belong only to Hand {hand.sequence}. Current play continues independently.</p>
      <ul className="inspection-holdings">{hand.participants.map(p => <li key={p.participantId}><strong>{name(p.participantId)} · Seat {p.seat}</strong><span className="community-cards">{p.holeCards.join(' ')}</span><span>Committed {p.contribution} chips{p.folded ? ' · Folded' : ''}</span></li>)}</ul>
      <dl className="inspection-facts">
        <div><dt>Button</dt><dd>Seat {hand.buttonSeat}</dd></div>
        <div><dt>Board</dt><dd>{hand.board.join(' ') || 'No community cards dealt'}</dd></div>
        <div><dt>Burn cards</dt><dd>{hand.burns.join(' ') || 'No cards burned'}</dd></div>
        <div><dt>Cards drawn</dt><dd>{hand.drawnCardCount} of 52</dd></div>
        <div><dt>Uncalled returns</dt><dd>{hand.returns.map(p => `${name(p.participantId)}: ${p.amount} chips`).join('; ') || 'None'}</dd></div>
        <div><dt>Payouts</dt><dd>{hand.payouts.map(p => `${name(p.participantId)}: ${p.amount} chips`).join('; ') || 'None'}</dd></div>
      </dl>
      <ul className="pot-layers">{hand.pots.map((pot, index) => <li key={index}><strong>{index === 0 ? 'Main pot' : `Side pot ${index}`} · {pot.amount} chips</strong><span>Eligible: {pot.eligibleParticipantIds.map(name).join(', ')}</span></li>)}</ul>
      <details><summary>Reconstructed shuffled deck · draw order</summary><p className="inspection-deck">{hand.deck.join(' ')}</p></details>
    </div>}
  </section>;
}
