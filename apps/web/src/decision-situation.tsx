import type { CSSProperties } from 'react';
import type { ObservableCashGameState, ObservableHistoryEntry, ObservableParticipant, ParticipantBinding } from '@poker/contracts';
import { actionLabel, chips, potTotal, seatPosition } from './table-model.js';
import { Card } from './cards.js';

function position(state: ObservableCashGameState, participant: ObservableParticipant) {
  const roles = [
    (participant.handSeat ?? participant.seat) === state.buttonSeat ? 'Dealer' : '',
    participant.participantId === state.smallBlindParticipantId ? 'Small blind' : '',
    participant.participantId === state.bigBlindParticipantId ? 'Big blind' : '',
  ].filter(Boolean);
  return roles.length ? roles.join(' · ') : `Dealer at seat ${state.buttonSeat}`;
}

/** Uses the decision's participant-safe state, never the advancing live table. */
export function DecisionSituation({ state, viewerId, bindings, earlierActions = [], seatCount }: {
  state: ObservableCashGameState;
  viewerId: string;
  bindings: readonly ParticipantBinding[];
  earlierActions?: ObservableHistoryEntry['decisions'];
  seatCount?: number;
}) {
  const viewer = state.participants.find(p => p.participantId === viewerId);
  if (!viewer || state.actorId !== viewerId) return null;
  const dealtIn = state.participants.filter(p => p.inHand).toSorted((a, b) => (a.handSeat ?? a.seat ?? 0) - (b.handSeat ?? b.seat ?? 0));
  const count = seatCount ?? Math.max(2, ...dealtIn.map(p => p.handSeat ?? p.seat ?? 0));
  const viewerSeat = viewer.handSeat ?? viewer.seat ?? 1;
  const name = (id: string) => id === viewerId ? 'You' : bindings.find(b => b.participantId === id)?.name ?? 'Participant';
  return <div className="decision-situation">
    <section className={`decision-mini-table ${count > 6 ? 'decision-mini-dense' : ''}`} aria-label={`Poker table before your ${state.street} decision`}>
      <div className="decision-mini-felt" aria-hidden="true" />
      <div className="decision-mini-center"><div className="decision-mini-pot">Pot <strong>{chips(potTotal(state))}</strong></div><div className="decision-mini-board" aria-label="Community cards before your action">{Array.from({ length: 5 }, (_, i) => state.board[i] ? <Card key={i} card={state.board[i]} small /> : <span key={i} className="decision-mini-slot" aria-hidden="true" />)}</div></div>
      {dealtIn.map(participant => {
        const seat = participant.handSeat ?? participant.seat ?? 1;
        const isViewer = participant.participantId === viewerId;
        const latest = earlierActions.findLast(action => action.action.participantId === participant.participantId);
        const action = isViewer ? 'Your decision' : participant.folded ? 'Folded' : latest ? actionLabel(latest.action.action) : participant.participantId === state.smallBlindParticipantId ? 'Small blind' : participant.participantId === state.bigBlindParticipantId ? 'Big blind' : 'Yet to act';
        const previousStreet = !isViewer && latest?.state.street !== state.street ? latest?.state.street : undefined;
        return <div key={participant.participantId} className={`decision-mini-seat ${isViewer ? 'decision-mini-viewer' : ''} ${participant.folded ? 'decision-mini-folded' : ''}`} style={seatPosition((seat - viewerSeat + count) % count, count) as CSSProperties} aria-label={`${name(participant.participantId)}, seat ${seat}, ${chips(participant.stack)} chips`}>
          {isViewer && <div className="decision-mini-hole" aria-label="Your cards at the decision">{viewer.holeCards?.map((card, i) => <Card key={i} card={card} small />)}</div>}
          <div className="decision-mini-seat-body"><strong>{name(participant.participantId)}</strong><span>{chips(participant.stack)} behind</span>{state.buttonSeat === seat && <span className="decision-mini-dealer" title="Dealer button">D</span>}</div>
          <p className="decision-mini-action">{action}{participant.allIn && <small>All-in</small>}{previousStreet && <small>{previousStreet}</small>}</p>
        </div>;
      })}
    </section>
    <dl className="situation-facts" aria-label="Situation before your action">
      <div><dt>To call</dt><dd>{(state.amountToCall ?? 0) > 0 ? chips(state.amountToCall!) : 'No bet to call'}</dd></div>
      <div><dt>Your position</dt><dd>Seat {viewer.handSeat ?? viewer.seat}<small>{position(state, viewer)}</small></dd></div>
    </dl>
  </div>;
}

export function EarlierActions({ actions, viewerId, bindings }: { actions: ObservableHistoryEntry['decisions']; viewerId: string; bindings: readonly ParticipantBinding[] }) {
  return <details className="situation-earlier-actions"><summary>Earlier actions</summary>
    {actions.length ? <ol>{actions.map(action => <li key={action.decisionId}><span>{action.state.street}</span><strong>{action.action.participantId === viewerId ? 'You' : bindings.find(binding => binding.participantId === action.action.participantId)?.name ?? 'Participant'}</strong><span>{actionLabel(action.action.action)}</span></li>)}</ol> : <p className="muted">No earlier participant actions are available for this decision.</p>}
  </details>;
}
