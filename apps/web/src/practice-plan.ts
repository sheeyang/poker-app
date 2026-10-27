import type { ObservableTableSession } from '@poker/contracts';
import type { Attempt } from './session.js';

/** Plan one mutation from a fresh authoritative view, never from optimistic seats. */
export function practiceStep(table: ObservableTableSession, afterHandId: string | null | undefined, requestId: string): Attempt | null {
  const state = table.view.state, tableId = table.tableSessionId;
  const started = afterHandId === undefined ? state.handId || table.view.history.length : (state.handId ?? null) !== afterHandId || state.status === 'active-hand';
  if (started) return null;
  const metadata = { requestId, expectedPokerRevision: table.pokerRevision };
  const unseated = table.bindings.find(b => (afterHandId === undefined || b.controller.kind === 'human') && !state.participants.some(p => p.participantId === b.participantId && p.seat !== null));
  if (unseated) {
    const seat = Array.from({ length: table.view.configuration.seatCount }, (_, i) => i + 1).find(s => !state.participants.some(p => p.seat === s));
    if (!seat) throw new Error('There is no open seat. Adjust the players in table options.');
    return { kind: 'seat', tableId, body: { ...metadata, participantId: unseated.participantId, seat, buyIn: table.view.configuration.defaultBuyIn } };
  }
  const human = state.participants.find(p => p.participantId === table.bindings.find(b => b.controller.kind === 'human')?.participantId);
  if (human?.sittingOut) return { kind: 'manage', operation: 'set-sitting-out', tableId, body: { ...metadata, participantId: human.participantId, sittingOut: false } };
  const emptyStack = state.participants.find(p => p.seat !== null && !p.sittingOut && p.stack === 0);
  if (emptyStack) return { kind: 'manage', operation: 'top-up-to', tableId, body: { ...metadata, participantId: emptyStack.participantId, targetStack: table.view.configuration.defaultBuyIn } };
  if (state.participants.filter(p => p.seat !== null && !p.sittingOut && p.stack > 0).length < 2) throw new Error('Add an opponent in table options before dealing.');
  return { kind: 'start', tableId, body: metadata };
}
