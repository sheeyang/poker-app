import { useEffect, useLayoutEffect, useReducer, useRef, useState, type CSSProperties } from 'react';
import type { ObservableTableSession } from '@poker/contracts';
import { Card } from './cards.js';
import { chips, potTotal, seatPosition, actionLabel } from './table-model.js';
import { Icon } from './icons.js';
import { afterHandRequestOf, afterHandRequestLabel } from './self-service.js';
import { connectionOf, nextHandLabel, type NextHandStatus } from './online-status.js';
import { participantActions } from './participant-actions.js';
import { currentWindow } from './presentation.js';
import { bettingOver, heldStacks } from './table-motion.js';
import { useTableMotion, type StackRoll } from './table-choreography.js';

/**
 * `serverNow`: the estimated server time this render shows; motion is timed from it.
 * `actorWindowOpen`: the acting Participant's Action Window is open, so they are now deciding.
 * `countdown`: whole seconds left before their Action Deadline, shown to everyone; `undefined` without one.
 * `nextHand`: between Hands at an Online Table, the Next-Hand Countdown or why there is none.
 * Seat and Participant actions open beside the object the player points at.
 */
export function PokerTable({ table, serverNow, actorWindowOpen, countdown, nextHand, handOpen, choosing, openSeat, openParticipant }: { table: ObservableTableSession; serverNow: number; actorWindowOpen: boolean; countdown?: number; nextHand?: NextHandStatus; handOpen: boolean; choosing: boolean; openSeat: (seat: number, anchor: HTMLElement) => void; openParticipant: (participantId: string, anchor: HTMLElement) => void }) {
  const state = table.view.state;
  const humanId = table.viewerParticipantId;
  const viewerSeat = state.participants.find(p => p.participantId === humanId)?.seat ?? null;
  const heroSeat = viewerSeat ?? 1;
  const count = table.view.configuration.seatCount;
  const hasHand = !!state.handId;
  const currentHistory = table.view.history.find(h => h.handId === state.handId);
  const actions = currentHistory?.decisions ?? [];
  const payouts = state.payouts ?? [];
  const { stage, rolls } = useTableMotion(table, serverNow);
  // Client time minus server time, for parts that keep their own clock between renders.
  const offset = serverNow - Date.now();
  const held = heldStacks(table, serverNow);
  const actionWindow = currentWindow(table);
  // Once betting is over the last street's chips are in the pot; the line is swept.
  const lineSwept = bettingOver(table);
  return <section ref={stage} className={`table-stage ${count > 6 ? 'dense-table' : ''} ${choosing ? 'choosing-seats' : ''}`} aria-label="Poker table">
    <div className="table-felt" aria-hidden="true"><div className="felt-inset" /></div>
    <div className="table-center" data-motion="center">
      {hasHand ? <>
        <div className="pot-label">{state.status === 'completed-hand' ? 'Settled pot' : 'Total pot'} <strong data-motion="pot">{chips(potTotal(state))}</strong><span>chips</span></div>
        <div className="board" aria-label="Community cards">{Array.from({ length: 5 }, (_, i) => state.board[i] ? <Card key={`${state.handId}-${i}`} card={state.board[i]} faces attrs={{ 'data-board': String(i) }} /> : <span key={i} className="card-slot" aria-hidden="true" />)}</div>
        {state.pots.length > 1 && (state.status === 'completed-hand' || state.participants.some(p => p.allIn) && state.pots.reduce((sum, p) => sum + p.amount, 0) === potTotal(state)) && <div className="side-pots">{state.pots.map((p, i) => <span key={i}>{i === 0 ? 'Main' : `Side ${i}`} {chips(p.amount)}</span>)}</div>}
        <div className="deck-area" aria-label="Deck and face-down burn pile"><Card small attrs={{ 'data-motion': 'deck' }} /><span className="burn-pile">{state.board.length > 0 && <Card small attrs={{ 'data-motion': 'burn' }} />}</span></div>
      </> : table.mode === 'online'
        // Before the first Hand the felt is empty, so it says what the table is waiting for.
        ? <div className="table-ready"><strong>{viewerSeat === null && nextHand?.kind !== 'countdown' ? 'Take an open seat' : nextHandLabel(nextHand, true) ?? 'Waiting for players'}</strong><p>{viewerSeat === null ? 'Hands are dealt automatically once two players are seated.' : 'Hands are dealt automatically.'}</p></div>
        : <div className="table-ready"><strong>A place at the table.</strong><p>Seat your players, then deal the first hand.</p></div>}
    </div>
    {/* Travelling cards pass under the seats, as dealt cards sit; chips and labels travel over everything. */}
    <div className="motion-layer motion-layer-under" data-motion-layer="under" aria-hidden="true" />
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
      const label = hero ? 'You' : binding?.name;
      const payout = payouts.filter(p => p.participantId === participant?.participantId).reduce((total, p) => total + p.amount, 0);
      const pending = participant && afterHandRequestOf(table, participant.participantId);
      // At an Online Table everyone sees who is connected; a disconnected human stays in the Hand until they are sat out.
      const offline = participant && connectionOf(table, participant.participantId) === 'disconnected';
      const actionable = participant && participantActions(table, participant.participantId, handOpen).length > 0;
      // An opponent's folded hand is mucked; your own stays, dimmed.
      const cardsShown = !!participant?.cardCount && !(participant.folded && !hero);
      // The acting seat's brass edge is the clock while an Action Deadline runs.
      const timed = actor && actionWindow?.deadlineAt !== undefined && actionWindow.participantId === participant.participantId ? actionWindow : undefined;
      const hold = participant && held.get(participant.participantId);
      const SeatTarget = actionable ? 'button' : 'span';
      return <div data-table-seat={seat} key={seat} className={`table-seat ${hero ? 'hero-seat' : ''} ${actor ? 'acting-seat' : ''} ${timed ? 'timed-seat' : ''} ${participant?.folded ? 'folded-seat' : ''} ${offline ? 'offline-seat' : ''}`} style={seatPosition(index, count) as CSSProperties}>
        {participant ? <>
          {cardsShown && <div className="hole-cards">{Array.from({ length: participant.cardCount ?? 0 }, (_, i) => <Card key={`${state.handId}-${i}`} card={participant.holeCards?.[i]} small={!hero} faces attrs={{ 'data-card': `${participant.participantId}-${i}` }} />)}</div>}
          <div className="seat-body" data-seat-body={participant.participantId}><SeatTarget className="seat-target" data-table-participant={participant.participantId} aria-label={actionable ? `${label} actions` : undefined} aria-haspopup={actionable ? 'menu' : undefined} onClick={actionable ? event => openParticipant(participant.participantId, event.currentTarget) : undefined}><span className={`avatar avatar-${index % 4}`} aria-hidden="true">{hero ? 'Y' : binding?.name.replace('Bot ', '').slice(0, 2)}</span><span className="seat-copy"><strong>{label}</strong>{offline && <small className="connection-label">Disconnected</small>}<span data-stack={participant.participantId}><StackFigure value={participant.stack} hold={hold && { value: hold.value, until: hold.until - offset }} roll={rolls.get(participant.participantId)} /> <small>chips</small></span></span></SeatTarget>{state.buttonSeat === seat && <span className="dealer-marker" data-motion="button" title="Dealer button">D</span>}<span className="dealer-marker motion-anchor" data-button-anchor={seat} aria-hidden="true" />{timed && timed.deadlineAt !== undefined && <EdgeCountdown key={timed.decisionId} opensAt={timed.opensAt - offset} deadlineAt={timed.deadlineAt - offset} />}</div>
          <div className="seat-caption" data-caption={participant.participantId}>{state.status === 'completed-hand' && payout > 0 ? `Won ${chips(payout)}` : pending ? afterHandRequestLabel(pending) : state.status === 'completed-hand' && participant.stack === 0 ? 'Rebuy to play' : participant.sittingOut ? 'Sitting out' : turn ? turn : participant.allIn ? 'All-in' : participant.folded ? 'Folded' : recentAction ? actionLabel(recentAction) : ''}</div>
          {(participant.wager ?? 0) > 0 && !lineSwept && <span className={`seat-wager wager-${index}`} data-wager={participant.participantId}><i aria-hidden="true" data-wager-chip={participant.participantId} />{chips(participant.wager ?? 0)}{state.smallBlindParticipantId === participant.participantId ? <small>SB</small> : state.bigBlindParticipantId === participant.participantId ? <small>BB</small> : null}</span>}
        </> : <button className="empty-seat empty-seat-open" onClick={event => openSeat(seat, event.currentTarget)} aria-label={`Seat ${seat} actions`} title={`Seat ${seat} actions`} aria-haspopup="menu"><Icon name="plus" size={24} /></button>}
      </div>;
    })}
    <div className="motion-layer" data-motion-layer="over" aria-hidden="true" />
  </section>;
}

/**
 * A stack's figure. A winner's shows their old stack until the payout's chips land on it (`hold`, until a client
 * time), then the new total at once; chips added between Hands roll it up to the new total (`roll`).
 */
function StackFigure({ value, hold, roll }: { value: number; hold?: { value: number; until: number }; roll?: StackRoll }) {
  const [, refresh] = useReducer((n: number) => n + 1, 0);
  const holding = hold !== undefined && Date.now() < hold.until;
  const until = hold?.until;
  useEffect(() => {
    if (!holding || until === undefined) return;
    const timer = setTimeout(refresh, until - Date.now() + 1);
    return () => clearTimeout(timer);
  }, [holding, until]);
  const [rolling, setRolling] = useState<{ from: number; to: number; id: string; done?: boolean }>();
  if (roll && roll.id !== rolling?.id) setRolling({ from: roll.from, to: value, id: roll.id });
  if (holding) return <>{chips(hold.value)}</>;
  // Once it has rolled, the plain figure again.
  if (rolling && !rolling.done && rolling.to === value && rolling.from !== value) return <RollingFigure key={rolling.id} from={rolling.from} to={value} rolled={() => setRolling(r => r && { ...r, done: true })} />;
  return <>{chips(value)}</>;
}

/** The whole figure as one reel: the old total rolls up out of view as the new one rolls into its place. */
function RollingFigure({ from, to, rolled }: { from: number; to: number; rolled: () => void }) {
  const ref = useRef<HTMLSpanElement>(null), done = useRef(rolled);
  done.current = rolled;
  useLayoutEffect(() => {
    const root = ref.current, strip = root?.firstElementChild, [a, b] = Array.from(strip?.children ?? []) as HTMLElement[];
    if (!root || !strip || !a || !b) return;
    const timing = { duration: 700, easing: 'cubic-bezier(.2,.8,.25,1)', fill: 'both' as const };
    const animations = [
      strip.animate([{ translate: '0 0' }, { translate: '0 -1.2em' }], timing),
      // The figure's width follows the number in view, so "chips" after it never jumps.
      root.animate([{ width: `${a.offsetWidth}px` }, { width: `${b.offsetWidth}px` }], timing),
    ];
    animations[0]!.onfinish = () => done.current();
    return () => { for (const animation of animations) animation.cancel(); };
  }, []);
  return <span ref={ref} className="stack-roll" role="img" aria-label={chips(to)}><span aria-hidden="true"><i>{chips(from)}</i><i>{chips(to)}</i></span></span>;
}

/**
 * The acting seat's border as its Action Deadline clock: a brass stroke round the seat that clears clockwise from the
 * top, like a clock hand, warming in the last five seconds. `opensAt` and `deadlineAt` are client times. Presentation
 * only: the server alone closes the window.
 */
function EdgeCountdown({ opensAt, deadlineAt }: { opensAt: number; deadlineAt: number }) {
  const svg = useRef<SVGSVGElement>(null), path = useRef<SVGPathElement>(null);
  const [size, setSize] = useState<{ w: number; h: number }>();
  useLayoutEffect(() => {
    const body = svg.current?.parentElement;
    if (!body) return;
    const measure = () => setSize({ w: body.offsetWidth, h: body.offsetHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(body);
    return () => observer.disconnect();
  }, []);
  const measured = size !== undefined;
  useLayoutEffect(() => {
    const node = path.current;
    if (!node || !measured) return;
    const length = Math.max(1, deadlineAt - opensAt), warm = Math.max(0, (length - 5000) / length);
    // pathLength 1 makes the dash offset the elapsed fraction; negative offsets clear the stroke from its start.
    const animation = node.animate([{ strokeDashoffset: 0, stroke: '#edd7a9' }, { strokeDashoffset: -warm, stroke: '#edd7a9', offset: warm }, { strokeDashoffset: -1, stroke: '#eba98f' }], { duration: length, easing: 'linear', fill: 'forwards' });
    animation.currentTime = Math.max(0, Date.now() - opensAt);
    return () => animation.cancel();
  }, [opensAt, deadlineAt, measured]);
  let d = '';
  if (size) {
    // From top centre, clockwise round the seat body's 12px corners, on its 1px border.
    const r = 11, x0 = 1, y0 = 1, x1 = size.w - 1, y1 = size.h - 1;
    d = `M${size.w / 2} ${y0}H${x1 - r}A${r} ${r} 0 0 1 ${x1} ${y0 + r}V${y1 - r}A${r} ${r} 0 0 1 ${x1 - r} ${y1}H${x0 + r}A${r} ${r} 0 0 1 ${x0} ${y1 - r}V${y0 + r}A${r} ${r} 0 0 1 ${x0 + r} ${y0}Z`;
  }
  return <svg ref={svg} className="edge-countdown" width={size?.w} height={size?.h} aria-hidden="true">{size && <path ref={path} d={d} pathLength={1} />}</svg>;
}
