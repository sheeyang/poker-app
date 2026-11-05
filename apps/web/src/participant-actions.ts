import type { ObservableTableSession } from '@poker/contracts';
import { botControls, hasDeparted, openSeats } from './owner-controls.js';
import { selfService, type Availability } from './self-service.js';
import { canManage } from './table-model.js';
import { canRemove, removalTiming } from './removal.js';

export type ParticipantAction = 'choose-seat' | 'stack' | 'sit-out' | 'resume' | 'move' | 'stand-up' | 'leave' | 'strategy' | 'remove-bot' | 'remove-participant';
export type SeatAction = 'take-seat' | 'move' | 'add-bot';
export interface ContextAction<T extends string> { id: T; label: string; timing: Availability; reason?: string }

export function participantActions(table: ObservableTableSession, participantId: string, handOpen: boolean): ContextAction<ParticipantAction>[] {
  const binding = table.bindings.find(b => b.participantId === participantId);
  if (!binding || hasDeparted(table, participantId)) return [];
  const participant = table.view.state.participants.find(p => p.participantId === participantId);
  const own = participantId === table.viewerParticipantId;
  if (!canManage(table, binding)) return canRemove(table, binding) ? [{ id: 'remove-participant', label: 'Remove from table', timing: removalTiming(handOpen) }] : [];
  const service = own ? selfService(table, handOpen) : botControls(table, participantId, handOpen);
  const actions: ContextAction<ParticipantAction>[] = [];
  const available = (id: ParticipantAction, label: string, timing: Availability) => { if (timing !== 'unavailable') actions.push({ id, label: timing === 'after-hand' ? `${label} after this hand` : label, timing }); };
  const empty = openSeats(table);
  if (participant?.seat != null) {
    const maxed = participant.stack >= table.view.configuration.maximumBuyIn;
    actions.push({ id: 'stack', label: participant.stack === 0 ? 'Rebuy' : 'Top up', timing: maxed ? 'unavailable' : service.topUp, reason: maxed ? 'At the maximum buy-in' : handOpen ? 'Available between hands' : undefined });
    if (participant.sittingOut) actions.push({ id: 'resume', label: 'Return to play', timing: service.resume, reason: handOpen ? 'Available between hands' : undefined });
    else available('sit-out', 'Sit out', service.sitOut);
    if (empty.length) actions.push({ id: 'move', label: 'Move seat', timing: !handOpen && table.view.configuration.allowSeatChanges ? 'now' : 'unavailable', reason: !table.view.configuration.allowSeatChanges ? 'Seat changes aren’t allowed' : handOpen ? 'Available between hands' : undefined });
    available('stand-up', 'Stand up', service.standUp);
  } else if (empty.length && (!own || empty.length > 1)) {
    actions.push({ id: 'choose-seat', label: own ? 'Choose a seat' : 'Seat Bot', timing: table.mode === 'online' || !handOpen ? 'now' : 'unavailable', reason: table.mode === 'practice' && handOpen ? 'Available between hands' : undefined });
  }
  if (own) available('leave', 'Leave table', selfService(table, handOpen).leaveTable);
  if (binding.controller.kind === 'bot') {
    actions.push({ id: 'strategy', label: 'Playing Strategy', timing: 'now' });
    available('remove-bot', 'Remove Bot', botControls(table, participantId, handOpen).remove);
  }
  return actions;
}

export function seatActions(table: ObservableTableSession, seat: number, handOpen: boolean, movingParticipantId = table.viewerParticipantId): ContextAction<SeatAction>[] {
  if (!openSeats(table).includes(seat)) return [];
  const binding = table.bindings.find(b => b.participantId === movingParticipantId);
  const actions: ContextAction<SeatAction>[] = [];
  if (binding && canManage(table, binding) && !hasDeparted(table, movingParticipantId)) {
    const participant = table.view.state.participants.find(p => p.participantId === movingParticipantId);
    const own = movingParticipantId === table.viewerParticipantId;
    if (participant?.seat != null) actions.push({ id: 'move', label: own ? 'Move here' : `Move ${binding.name} here`, timing: !handOpen && table.view.configuration.allowSeatChanges ? 'now' : 'unavailable', reason: !table.view.configuration.allowSeatChanges ? 'Seat changes aren’t allowed' : handOpen ? 'Available between hands' : undefined });
    else actions.push({ id: 'take-seat', label: own ? 'Take this seat' : `Seat ${binding.name} here`, timing: table.mode === 'online' || !handOpen ? 'now' : 'unavailable', reason: table.mode === 'practice' && handOpen ? 'Available between hands' : undefined });
  }
  if (table.viewerParticipantId === table.ownerParticipantId) actions.push({ id: 'add-bot', label: 'Add a Bot here', timing: 'now' });
  return actions;
}

export function stackBounds(table: ObservableTableSession, stack: number) {
  const { minimumBuyIn, maximumBuyIn, defaultBuyIn } = table.view.configuration;
  return { minimum: Math.max(stack + 1, minimumBuyIn), maximum: maximumBuyIn, initial: stack === 0 ? defaultBuyIn : maximumBuyIn };
}
