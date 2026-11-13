import type { BoardStreet, ObservableTableSession } from '@poker/contracts';

/**
 * Presentation of the server's schedule. Pure: the Trainer shows already-received facts at their server
 * timestamps, judged on its estimate of the server clock. Nothing here sends or delays a request.
 */

const boardBefore: Readonly<Record<BoardStreet, number>> = { flop: 0, turn: 3, river: 4 };
const phasesOf = (table: ObservableTableSession) => table.schedule.phases.filter(phase => phase.handId === table.view.state.handId);

/**
 * The table as shown at server time `serverNow`. Each Presentation Phase reveals its step from its start:
 * the deal shows hole cards, a street reveal shows that street's board cards, the showdown turns the
 * opponents' hands up, and the payout shows a completed Hand's result (pot awards, returned chips and
 * final stacks). A Hand the server settled at once is therefore presented step by step, whatever order its
 * events arrived in. Elapsed phases change nothing.
 */
export function presentTable(table: ObservableTableSession, serverNow: number): ObservableTableSession {
  const state = table.view.state;
  const phases = phasesOf(table);
  const upcoming = phases.filter(phase => phase.startsAt > serverNow);
  const undealt = upcoming.some(phase => phase.kind === 'deal');
  const unrevealed = upcoming.some(phase => phase.kind === 'showdown');
  const boardCount = Math.min(state.board.length, ...upcoming.flatMap(phase => phase.kind === 'street' && phase.street !== 'preflop' ? [boardBefore[phase.street]] : []));
  const settling = state.status === 'completed-hand' && upcoming.some(phase => phase.kind === 'payout');
  if (!undealt && !unrevealed && boardCount === state.board.length && !settling) return table;
  const received = (participantId: string, transfers: typeof state.payouts) => (transfers ?? []).filter(t => t.participantId === participantId).reduce((total, t) => total + t.amount, 0);
  return { ...table, view: { ...table.view, state: {
    ...state,
    board: state.board.slice(0, boardCount),
    participants: state.participants.map(p => {
      const shown = settling ? { ...p, stack: p.stack - received(p.participantId, state.payouts) - received(p.participantId, state.returns) } : p;
      if (undealt && p.inHand) {
        const { holeCards: _hidden, ...rest } = shown;
        return { ...rest, cardCount: 0 };
      }
      // Hands turned up at showdown stay face down until its phase starts; your own cards were dealt to you.
      if (unrevealed && p.participantId !== table.viewerParticipantId) {
        const { holeCards: _unrevealed, ...rest } = shown;
        return rest;
      }
      return shown;
    }),
    ...(settling ? { status: 'active-hand' as const, payouts: [], returns: [] } : {}),
  } } };
}

/**
 * Whether the latest Hand has ended at server time `serverNow`: its payout phase is over, or no Hand has been paid
 * out under a schedule. Until then the Hand is still in progress for management.
 */
export function payoutEnded(table: ObservableTableSession, serverNow: number): boolean {
  const payout = phasesOf(table).findLast(phase => phase.kind === 'payout');
  return !payout || serverNow >= payout.endsAt;
}

/**
 * Whether a Hand is in progress at server time `serverNow`: it is being played, or its payout phase has not ended. The
 * table, the Current Table banner and the saved-tables ledger all say "Hand in progress" or "Between hands" by this.
 */
export function handInProgress(table: ObservableTableSession, serverNow: number): boolean {
  return table.view.state.status === 'active-hand' || !payoutEnded(table, serverNow);
}

/**
 * Whether Deal is available at server time `serverNow`: the latest Hand has ended (`payoutEnded`) and no After-Hand
 * Request is still waiting. The server applies those in their own commit before it accepts a Deal, so a Deal sent
 * before the view without them arrives would name a stale revision. Mirrors the server's rule; the server alone decides.
 */
export function dealOpen(table: ObservableTableSession, serverNow: number): boolean {
  return payoutEnded(table, serverNow) && table.pendingChanges.length === 0;
}

/** The Action Window of the current decision, if the schedule has one. */
export function currentWindow(table: ObservableTableSession) {
  const state = table.view.state, window = table.schedule.actionWindow;
  return state.status === 'active-hand' && window && window.participantId === state.actorId && window.decisionId === state.decisionId ? window : undefined;
}

/**
 * Whether `participantId` may act at server time `serverNow`: their decision is current, its window has
 * opened, and its Action Deadline, if any, has not been reached.
 */
export function actionWindowOpen(table: ObservableTableSession, participantId: string | undefined, serverNow: number): boolean {
  const window = currentWindow(table);
  return !!participantId && window?.participantId === participantId && serverNow >= window.opensAt && (window.deadlineAt === undefined || serverNow < window.deadlineAt);
}

/**
 * Whole seconds left before the current decision's Action Deadline at server time `serverNow`, counted from
 * when its window opens and never below zero; `undefined` when the decision has no deadline (a Bot's, or a
 * table without an Action Time Limit).
 */
export function deadlineCountdown(table: ObservableTableSession, serverNow: number): number | undefined {
  const window = currentWindow(table);
  if (window?.deadlineAt === undefined) return undefined;
  return Math.max(0, Math.ceil((window.deadlineAt - Math.max(serverNow, window.opensAt)) / 1000));
}

/**
 * Whole seconds left before an Online Table's Next-Hand Countdown expires at server time `serverNow`, counted from
 * its announcement and never below zero; `undefined` when none is announced, or once its Hand is dealt.
 */
export function nextHandCountdown(table: ObservableTableSession, serverNow: number): number | undefined {
  const countdown = table.schedule.nextHandCountdown;
  if (!countdown || table.view.state.status === 'active-hand') return undefined;
  return Math.max(0, Math.ceil((countdown.endsAt - Math.max(serverNow, countdown.startsAt)) / 1000));
}

/** When a countdown to `end`, shown in whole seconds from `start`, next changes; nothing before it starts or after it ends. */
function nextSecond(start: number, end: number, serverNow: number): number[] {
  // The countdown shows ceil(remaining / 1 s), so it changes when the remaining time reaches a whole second.
  return serverNow >= start && serverNow < end ? [end - (Math.ceil((end - serverNow) / 1000) - 1) * 1000] : [];
}

/**
 * The next server time at which the presentation changes, if any: a phase starting or ending, the window
 * opening, each second of its deadline countdown or of the Next-Hand Countdown, or either one's end.
 */
export function nextPresentationChange(table: ObservableTableSession, serverNow: number): number | undefined {
  const window = currentWindow(table), deadline = window?.deadlineAt;
  const countdown = table.view.state.status === 'active-hand' ? undefined : table.schedule.nextHandCountdown;
  const ticks = [...(window && deadline !== undefined ? nextSecond(window.opensAt, deadline, serverNow) : []), ...(countdown ? [countdown.startsAt, countdown.endsAt, ...nextSecond(countdown.startsAt, countdown.endsAt, serverNow)] : [])];
  const instants = [...phasesOf(table).flatMap(phase => [phase.startsAt, phase.endsAt]), ...(table.schedule.actionWindow ? [table.schedule.actionWindow.opensAt] : []), ...(deadline !== undefined ? [deadline] : []), ...ticks].filter(at => at > serverNow);
  return instants.length ? Math.min(...instants) : undefined;
}

/** A view's server time and the client time it arrived. */
export interface ClockSample { readonly serverTime: number; readonly receivedAt: number }

/**
 * The estimated server-minus-client clock offset, in ms. A view left the server no later than it
 * arrived, so each sample bounds the offset from below; the least-delayed sample bounds it most tightly.
 */
export function estimateClockOffset(samples: readonly ClockSample[]): number {
  return samples.length ? Math.max(...samples.map(sample => sample.serverTime - sample.receivedAt)) : 0;
}

/** Adds a sample, keeping the newest `limit`. */
export function recordClockSample(samples: readonly ClockSample[], sample: ClockSample, limit = 16): readonly ClockSample[] {
  return [...samples, sample].slice(-limit);
}
