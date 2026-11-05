import type { CSSProperties } from 'react';
import type { ObservablePresentationEvent, ObservableTableSession } from '@poker/contracts';
import { Card } from './cards.js';
import { chips, potTotal, seatPosition, actionLabel } from './table-model.js';
import { Icon } from './icons.js';
import { afterHandRequestOf, afterHandRequestLabel } from './self-service.js';
import { connectionOf, nextHandLabel, type NextHandStatus } from './online-status.js';
import { DeadlineBar } from './controls.js';
import { participantActions } from './participant-actions.js';

/**
 * `actorWindowOpen`: the acting Participant's Action Window is open, so they are now deciding.
 * `countdown`: whole seconds left before their Action Deadline, shown to everyone; `undefined` without one.
 * `countdownLength`: the whole seconds that Action Window lasts.
 * `nextHand`: between Hands at an Online Table, the Next-Hand Countdown or why there is none.
 * Seat and Participant actions open beside the object the player points at.
 */
export function PokerTable({ table, actorWindowOpen, countdown, countdownLength, nextHand, events, animate, eventCount, handOpen, choosing, openSeat, openParticipant }: { table: ObservableTableSession; actorWindowOpen: boolean; countdown?: number; countdownLength?: number; nextHand?: NextHandStatus; events: readonly ObservablePresentationEvent[]; animate: boolean; eventCount: number; handOpen: boolean; choosing: boolean; openSeat: (seat: number, anchor: HTMLElement) => void; openParticipant: (participantId: string, anchor: HTMLElement) => void }) {
  const state = table.view.state;
  const humanId = table.viewerParticipantId;
  const viewerSeat = state.participants.find(p => p.participantId === humanId)?.seat ?? null;
  const heroSeat = viewerSeat ?? 1;
  const count = table.view.configuration.seatCount;
  const hasHand = !!state.handId;
  const currentHistory = table.view.history.find(h => h.handId === state.handId);
  const actions = currentHistory?.decisions ?? [];
  const burn = animate && events.some(e => e.type === 'card-burned');
  const boardDeal = animate && events.some(e => e.type === 'board-dealt');
  const payouts = state.payouts ?? [];
  return <section className={`table-stage ${count > 6 ? 'dense-table' : ''} ${choosing ? 'choosing-seats' : ''}`} aria-label="Poker table">
    <div className="table-felt" aria-hidden="true"><div className="felt-inset" /></div>
    <div className="table-center">
      {hasHand ? <>
        <div className="pot-label">{state.status === 'completed-hand' ? 'Settled pot' : 'Total pot'} <strong>{chips(potTotal(state))}</strong><span>chips</span></div>
        <div className="board" aria-label="Community cards">{Array.from({ length: 5 }, (_, i) => state.board[i] ? <Card key={`${state.handId}-${i}-${boardDeal ? eventCount : 0}`} card={state.board[i]} dealing={boardDeal} /> : <span key={i} className="card-slot" aria-hidden="true" />)}</div>
        {state.pots.length > 1 && (state.status === 'completed-hand' || state.participants.some(p => p.allIn) && state.pots.reduce((sum, p) => sum + p.amount, 0) === potTotal(state)) && <div className="side-pots">{state.pots.map((p, i) => <span key={i}>{i === 0 ? 'Main' : `Side ${i}`} {chips(p.amount)}</span>)}</div>}
        <div className="deck-area" aria-label="Deck and face-down burn pile"><Card small /><span className="burn-pile">{state.board.length > 0 && <Card small />}</span>{burn && <span key={eventCount} className="burn-moving"><Card small /></span>}</div>
      </> : table.mode === 'online'
        // Before the first Hand the felt is empty, so it says what the table is waiting for.
        ? <div className="table-ready"><strong>{viewerSeat === null && nextHand?.kind !== 'countdown' ? 'Take an open seat' : nextHandLabel(nextHand, true) ?? 'Waiting for players'}</strong><p>{viewerSeat === null ? 'Hands are dealt automatically once two players are seated.' : 'Hands are dealt automatically.'}</p></div>
        : <div className="table-ready"><strong>A place at the table.</strong><p>Seat your players, then deal the first hand.</p></div>}
    </div>
    {Array.from({ length: count }, (_, index) => {
      const seat = ((heroSeat - 1 + index) % count) + 1;
      const participant = state.participants.find(p => p.seat === seat);
      const binding = table.bindings.find(b => b.participantId === participant?.participantId);
      const hero = participant?.participantId === humanId;
      const actor = participant && state.actorId === participant.participantId && actorWindowOpen;
      // Past the deadline the window has closed, and the Timeout Action is on its way.
      const timedOut = participant && state.actorId === participant.participantId && countdown === 0;
      const turn = actor ? (hero ? 'Your turn' : 'Thinking…') + (countdown !== undefined ? ` · ${countdown}s` : '') : timedOut ? 'Time’s up' : undefined;
      const recentAction = participant && actions.findLast(d => d.action.participantId === participant.participantId)?.action.action;
      const dealing = animate && events.some(e => e.type === 'hole-cards-dealt' && e.participantId === participant?.participantId);
      const label = hero ? 'You' : binding?.name;
      const payout = payouts.filter(p => p.participantId === participant?.participantId).reduce((total, p) => total + p.amount, 0);
      const pending = participant && afterHandRequestOf(table, participant.participantId);
      // At an Online Table everyone sees who is connected; a disconnected human stays in the Hand until they are sat out.
      const offline = participant && connectionOf(table, participant.participantId) === 'disconnected';
      const actionable = participant && participantActions(table, participant.participantId, handOpen).length > 0;
      const SeatTarget = actionable ? 'button' : 'span';
      return <div data-table-seat={seat} key={seat} className={`table-seat ${hero ? 'hero-seat' : ''} ${actor ? 'acting-seat' : ''} ${participant?.folded ? 'folded-seat' : ''} ${offline ? 'offline-seat' : ''}`} style={seatPosition(index, count) as CSSProperties}>
        {participant ? <>
          {!!participant.cardCount && <div className="hole-cards">{Array.from({ length: participant.cardCount }, (_, i) => <Card key={`${state.handId}-${i}-${dealing ? eventCount : 0}`} card={participant.holeCards?.[i]} small={!hero} dealing={dealing} />)}</div>}
          <div className="seat-body"><SeatTarget className="seat-target" data-table-participant={participant.participantId} aria-label={actionable ? `${label} actions` : undefined} aria-haspopup={actionable ? 'menu' : undefined} onClick={actionable ? event => openParticipant(participant.participantId, event.currentTarget) : undefined}><span className={`avatar avatar-${index % 4}`} aria-hidden="true">{hero ? 'Y' : binding?.name.replace('Bot ', '').slice(0, 2)}</span><span className="seat-copy"><strong>{label}</strong>{offline && <small className="connection-label">Disconnected</small>}<span>{chips(participant.stack)} <small>chips</small></span></span></SeatTarget>{state.buttonSeat === seat && <span className="dealer-marker" title="Dealer button">D</span>}{actor && countdown !== undefined && countdownLength !== undefined && <DeadlineBar seconds={countdown} length={countdownLength} />}</div>
          <div className="seat-caption">{state.status === 'completed-hand' && payout > 0 ? `Won ${chips(payout)}` : pending ? afterHandRequestLabel(pending) : state.status === 'completed-hand' && participant.stack === 0 ? 'Rebuy to play' : participant.sittingOut ? 'Sitting out' : turn ? turn : participant.allIn ? 'All-in' : participant.folded ? 'Folded' : recentAction ? actionLabel(recentAction) : ''}</div>
          {(participant.wager ?? 0) > 0 && <span className={`seat-wager wager-${index}`}><i aria-hidden="true" />{chips(participant.wager!)}{state.smallBlindParticipantId === participant.participantId ? <small>SB</small> : state.bigBlindParticipantId === participant.participantId ? <small>BB</small> : null}</span>}
        </> : <button className="empty-seat empty-seat-open" onClick={event => openSeat(seat, event.currentTarget)} aria-label={`Seat ${seat} actions`} title={`Seat ${seat} actions`} aria-haspopup="menu"><Icon name="plus" size={24} /></button>}
      </div>;
    })}
  </section>;
}
