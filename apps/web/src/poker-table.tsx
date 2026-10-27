import type { CSSProperties } from 'react';
import type { ObservablePresentationEvent, ObservableTableSession } from '@poker/contracts';
import { Card } from './cards.js';
import { chips, potTotal, seatPosition, actionLabel } from './table-model.js';
import { Icon } from './icons.js';

export function PokerTable({ table, events, animate, eventCount, openSettings }: { table: ObservableTableSession; events: readonly ObservablePresentationEvent[]; animate: boolean; eventCount: number; openSettings: () => void }) {
  const state = table.view.state;
  const humanId = table.bindings.find(b => b.controller.kind === 'human')!.participantId;
  const heroSeat = state.participants.find(p => p.participantId === humanId)?.seat ?? 1;
  const count = table.view.configuration.seatCount;
  const hasHand = !!state.handId;
  const currentHistory = table.view.history.find(h => h.handId === state.handId);
  const actions = currentHistory?.decisions ?? [];
  const burn = animate && events.some(e => e.type === 'card-burned');
  const boardDeal = animate && events.some(e => e.type === 'board-dealt');
  const payouts = state.payouts ?? [];
  return <section className={`table-stage ${count > 6 ? 'dense-table' : ''}`} aria-label="Poker table">
    <div className="table-felt" aria-hidden="true"><div className="felt-inset" /></div>
    <div className="table-center">
      {hasHand ? <>
        <div className="pot-label">{state.status === 'completed-hand' ? 'Settled pot' : 'Total pot'} <strong>{chips(potTotal(state))}</strong><span>chips</span></div>
        <div className="board" aria-label="Community cards">{Array.from({ length: 5 }, (_, i) => state.board[i] ? <Card key={`${state.handId}-${i}-${boardDeal ? eventCount : 0}`} card={state.board[i]} dealing={boardDeal} /> : <span key={i} className="card-slot" aria-hidden="true" />)}</div>
        {state.pots.length > 1 && (state.status === 'completed-hand' || state.participants.some(p => p.allIn) && state.pots.reduce((sum, p) => sum + p.amount, 0) === potTotal(state)) && <div className="side-pots">{state.pots.map((p, i) => <span key={i}>{i === 0 ? 'Main' : `Side ${i}`} {chips(p.amount)}</span>)}</div>}
        <div className="deck-area" aria-label="Deck and face-down burn pile"><Card small /><span className="burn-pile">{state.board.length > 0 && <Card small />}</span>{burn && <span key={eventCount} className="burn-moving"><Card small /></span>}</div>
      </> : <div className="table-ready"><strong>A place at the table.</strong><p>Seat your players, then deal the first hand.</p></div>}
    </div>
    {Array.from({ length: count }, (_, index) => {
      const seat = ((heroSeat - 1 + index) % count) + 1;
      const participant = state.participants.find(p => p.seat === seat);
      const binding = table.bindings.find(b => b.participantId === participant?.participantId);
      const hero = participant?.participantId === humanId;
      const actor = participant && state.actorId === participant.participantId;
      const recentAction = participant && actions.findLast(d => d.action.participantId === participant.participantId)?.action.action;
      const dealing = animate && events.some(e => e.type === 'hole-cards-dealt' && e.participantId === participant?.participantId);
      const label = hero ? 'You' : binding?.name;
      const payout = payouts.filter(p => p.participantId === participant?.participantId).reduce((total, p) => total + p.amount, 0);
      return <div key={seat} className={`table-seat ${hero ? 'hero-seat' : ''} ${actor ? 'acting-seat' : ''} ${participant?.folded ? 'folded-seat' : ''}`} style={seatPosition(index, count) as CSSProperties}>
        {participant ? <>
          {!!participant.cardCount && <div className="hole-cards">{Array.from({ length: participant.cardCount }, (_, i) => <Card key={`${state.handId}-${i}-${dealing ? eventCount : 0}`} card={participant.holeCards?.[i]} small={!hero} dealing={dealing} />)}</div>}
          <div className="seat-body"><span className={`avatar avatar-${index % 4}`} aria-hidden="true">{hero ? 'Y' : binding?.name.replace('Bot ', '').slice(0, 2)}</span><span className="seat-copy"><strong>{label}</strong><span>{chips(participant.stack)} <small>chips</small></span></span>{state.buttonSeat === seat && <span className="dealer-marker" title="Dealer button">D</span>}</div>
          <div className="seat-caption">{state.status === 'completed-hand' && payout > 0 ? `Won ${chips(payout)}` : state.status === 'completed-hand' && participant.stack === 0 ? 'Rebuy to play' : participant.sittingOut ? 'Sitting out' : actor ? hero ? 'Your turn' : 'Thinking…' : participant.allIn ? 'All-in' : participant.folded ? 'Folded' : recentAction ? actionLabel(recentAction) : ''}</div>
          {(participant.wager ?? 0) > 0 && <span className={`seat-wager wager-${index}`}><i aria-hidden="true" />{chips(participant.wager!)}{state.smallBlindParticipantId === participant.participantId ? <small>SB</small> : state.bigBlindParticipantId === participant.participantId ? <small>BB</small> : null}</span>}
        </> : <button className="empty-seat" onClick={openSettings} aria-label={`Manage empty seat ${seat}`}><span>Seat {seat}</span><small>Open</small></button>}
      </div>;
    })}
  </section>;
}
