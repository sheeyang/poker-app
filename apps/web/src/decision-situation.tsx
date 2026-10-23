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
export function DecisionSituation({ state, humanId, bindings, earlierActions = [], seatCount }: {
  state: ObservableCashGameState;
  humanId: string;
  bindings: readonly ParticipantBinding[];
  earlierActions?: ObservableHistoryEntry['decisions'];
  seatCount?: number;
}) {
  const human = state.participants.find(p => p.participantId === humanId);
  if (!human || state.actorId !== humanId) return null;
  const players = state.participants.filter(p => p.inHand).toSorted((a, b) => (a.handSeat ?? a.seat ?? 0) - (b.handSeat ?? b.seat ?? 0));
  const count = seatCount ?? Math.max(2, ...players.map(p => p.handSeat ?? p.seat ?? 0));
  const humanSeat = human.handSeat ?? human.seat ?? 1;
  const name = (id: string) => id === humanId ? 'You' : bindings.find(b => b.participantId === id)?.name ?? 'Participant';
  return <div className="decision-situation">
    <section className={`decision-mini-table ${count > 6 ? 'decision-mini-dense' : ''}`} aria-label={`Poker table before your ${state.street} decision`}>
      <div className="decision-mini-felt" aria-hidden="true" />
      <div className="decision-mini-center"><div className="decision-mini-pot">Pot <strong>{chips(potTotal(state))}</strong></div><div className="decision-mini-board" aria-label="Community cards before your action">{Array.from({ length: 5 }, (_, i) => state.board[i] ? <Card key={i} card={state.board[i]} small /> : <span key={i} className="decision-mini-slot" aria-hidden="true" />)}</div></div>
      {players.map(player => {
        const seat = player.handSeat ?? player.seat ?? 1;
        const hero = player.participantId === humanId;
        const latest = earlierActions.findLast(action => action.action.participantId === player.participantId);
        const action = hero ? 'Your decision' : player.folded ? 'Folded' : latest ? actionLabel(latest.action.action) : player.participantId === state.smallBlindParticipantId ? 'Small blind' : player.participantId === state.bigBlindParticipantId ? 'Big blind' : 'Yet to act';
        const previousStreet = !hero && latest?.state.street !== state.street ? latest?.state.street : undefined;
        return <div key={player.participantId} className={`decision-mini-seat ${hero ? 'decision-mini-hero' : ''} ${player.folded ? 'decision-mini-folded' : ''}`} style={seatPosition((seat - humanSeat + count) % count, count) as CSSProperties} aria-label={`${name(player.participantId)}, seat ${seat}, ${chips(player.stack)} chips`}>
          {hero && <div className="decision-mini-hole" aria-label="Your cards at the decision">{human.holeCards?.map((card, i) => <Card key={i} card={card} small />)}</div>}
          <div className="decision-mini-seat-body"><strong>{name(player.participantId)}</strong><span>{chips(player.stack)} behind</span>{state.buttonSeat === seat && <span className="decision-mini-dealer" title="Dealer button">D</span>}</div>
          <p className="decision-mini-action">{action}{player.allIn && <small>All-in</small>}{previousStreet && <small>{previousStreet}</small>}</p>
        </div>;
      })}
    </section>
    <p className="decision-mini-caption">Each seat shows the latest action before your decision. Earlier streets are labeled.</p>
    <p className="situation-note">Before your action · amounts in chips</p>
    <dl className="situation-facts" aria-label="Situation before your action">
      <div><dt>Total pot</dt><dd>{chips(potTotal(state))}</dd></div>
      <div><dt>To call</dt><dd>{(state.amountToCall ?? 0) > 0 ? chips(state.amountToCall!) : 'No bet to call'}</dd></div>
      <div><dt>Your stack</dt><dd>{chips(human.stack)}</dd></div>
      <div><dt>Your position</dt><dd>Seat {human.handSeat ?? human.seat}<small>{position(state, human)}</small></dd></div>
    </dl>
    <details className="situation-players"><summary>Earlier actions</summary>
      {earlierActions.length ? <ol>{earlierActions.map(action => <li key={action.decisionId}><span>{action.state.street}</span><strong>{name(action.action.participantId)}</strong><span>{actionLabel(action.action.action)}</span></li>)}</ol> : <p className="muted">No earlier player actions are available for this decision.</p>}
    </details>
  </div>;
}
