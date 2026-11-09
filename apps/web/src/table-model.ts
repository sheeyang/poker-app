import type { ConcreteAction, LegalAction, ObservableCashGameState, ObservableTableSession, ParticipantBinding, TableMode } from '@poker/contracts';

export const chips = (value: number) => new Intl.NumberFormat('en').format(value);
export const actionLabel = (action: ConcreteAction) => action.type === 'bet' ? 'Bet-to ' + chips(action.betTo) : action.type === 'raise' ? 'Raise-to ' + chips(action.raiseTo) : action.type[0]!.toUpperCase() + action.type.slice(1);
export const potTotal = (state: ObservableCashGameState) => state.status === 'active-hand' ? state.participants.reduce((total, p) => total + (p.contribution ?? 0), 0) : state.pots.reduce((total, p) => total + p.amount, 0);
/** A table's format by its seat count, as players name it. */
export const tableFormat = (seatCount: number) => seatCount === 2 ? 'Heads-up' : seatCount === 6 ? '6-max' : seatCount === 9 ? 'Full ring' : `${seatCount}-player`;
export const modeLabel = (mode: TableMode) => mode === 'online' ? 'Online' : 'Practice';
/** The viewer is "You"; everyone else appears under the name they joined with. */
export const playerName = (table: ObservableTableSession, binding: ParticipantBinding) => binding.participantId === table.viewerParticipantId ? 'You' : binding.name;
/** Whether the viewer may manage this Participant: themselves, and at a table they own, its Bots. Never another human. */
export const canManage = (table: ObservableTableSession, binding: ParticipantBinding) =>
  binding.participantId === table.viewerParticipantId || table.viewerParticipantId === table.ownerParticipantId && binding.controller.kind === 'bot';
export type SizedAction = Extract<LegalAction, { minimum: number }>;
/** Presets are total street commitments and are always bounded by authoritative legality. */
export function presetTotal(action: SizedAction, pot: number, call: number, wager: number, fraction: number) {
  return Math.min(action.maximum, Math.max(action.minimum, Math.round(wager + call + (pot + call) * fraction)));
}
export function seatPosition(index: number, count: number) {
  const angle = Math.PI / 2 + index * Math.PI * 2 / count;
  return { left: `${50 + 39 * Math.cos(angle)}%`, top: `${50 + 39 * Math.sin(angle)}%` };
}
