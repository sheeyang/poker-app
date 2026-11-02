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
 * Whether Deal is available at server time `serverNow`: the latest Hand's payout phase has ended, or no
 * Hand has been paid out under a schedule. Mirrors the server's rule; the server alone decides.
 */
export function dealOpen(table: ObservableTableSession, serverNow: number): boolean {
  const payout = phasesOf(table).findLast(phase => phase.kind === 'payout');
  return !payout || serverNow >= payout.endsAt;
}

/** Whether `participantId` may act at server time `serverNow`: their decision is current and its window has opened. */
export function actionWindowOpen(table: ObservableTableSession, participantId: string | undefined, serverNow: number): boolean {
  const state = table.view.state, window = table.schedule.actionWindow;
  return state.status === 'active-hand' && !!participantId && state.actorId === participantId && !!window
    && window.participantId === participantId && window.decisionId === state.decisionId && serverNow >= window.opensAt;
}

/** The next server time at which the presentation changes, if any: a phase starting or ending, or the window opening. */
export function nextPresentationChange(table: ObservableTableSession, serverNow: number): number | undefined {
  const instants = [...phasesOf(table).flatMap(phase => [phase.startsAt, phase.endsAt]), ...(table.schedule.actionWindow ? [table.schedule.actionWindow.opensAt] : [])].filter(at => at > serverNow);
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
