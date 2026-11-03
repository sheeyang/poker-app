import { afterHandRequestStrength, type ObservableTableSession, type ParticipantBinding, type AfterHandRequestKind, type TableOptionChanges } from '@poker/contracts';
import { afterHandRequestOf, type Availability } from './self-service.js';

/**
 * The Table Owner's controls, as pure functions of the committed table: the Trainer shows what the server will
 * do, and the server alone decides. None of these gives the owner a way to touch another human.
 */

/** Whether a Participant has left the table: a human who left or was removed, or a Bot the owner removed. */
export const hasDeparted = (table: ObservableTableSession, participantId: string) => !!table.departedParticipantIds?.includes(participantId);

/** The Participants still at the table, in binding order: the ones the Trainer lists, seats and manages. */
export const presentBindings = (table: ObservableTableSession): ParticipantBinding[] => table.bindings.filter(binding => !hasDeparted(table, binding.participantId));

/** The open Seats, lowest first. */
export function openSeats(table: ObservableTableSession): number[] {
  return Array.from({ length: table.view.configuration.seatCount }, (_, index) => index + 1).filter(seat => !table.view.state.participants.some(p => p.seat === seat));
}

/** The first "Bot N" that no Participant, departed ones included, already has, ignoring case. The server decides; this is a suggestion. */
export function nextBotName(table: ObservableTableSession): string {
  const taken = new Set(table.bindings.map(binding => binding.name.toLowerCase()));
  for (let n = 1; ; n++) if (!taken.has(`bot ${n}`)) return `Bot ${n}`;
}

/**
 * The owner's table option controls: shown to the owner of an Online Table (a Practice Table keeps the options it was
 * created with), and editable between Hands only. A Hand lasts until its payout phase ends (`handOpen`).
 */
export function optionControls(table: ObservableTableSession, handOpen: boolean): { shown: boolean; editable: boolean } {
  return { shown: table.mode === 'online' && table.viewerParticipantId === table.ownerParticipantId, editable: !handOpen };
}

/** What the owner's form changes: only the options whose value differs from the table's. `undefined`: nothing to send. */
export function optionChanges(table: ObservableTableSession, form: { actionTimeLimitSeconds: number; allowSeatChanges: boolean; allowLiveAnalysis: boolean }): TableOptionChanges | undefined {
  const changes = {
    ...(form.actionTimeLimitSeconds !== table.options.actionTimeLimitSeconds ? { actionTimeLimitSeconds: form.actionTimeLimitSeconds as 15 | 30 | 60 } : {}),
    ...(form.allowSeatChanges !== table.view.configuration.allowSeatChanges ? { allowSeatChanges: form.allowSeatChanges } : {}),
    ...(form.allowLiveAnalysis !== table.options.allowLiveAnalysis ? { allowLiveAnalysis: form.allowLiveAnalysis } : {}),
  };
  return Object.keys(changes).length ? changes : undefined;
}

export interface BotControls {
  readonly sitOut: Availability;
  readonly resume: Availability;
  readonly topUp: Availability;
  readonly standUp: Availability;
  /** Removing a Bot with a Seat during a Hand waits for it; a Bot without a Seat goes at once. */
  readonly remove: Availability;
}

/**
 * What the owner can ask of one Bot right now. Like a human's own, a Bot's sit-out is asked for during a Hand and
 * applies after it, and so is its Removal; stacks, Seats and resuming wait for the Hand to end.
 */
export function botControls(table: ObservableTableSession, participantId: string, handOpen: boolean): BotControls {
  const none: BotControls = { sitOut: 'unavailable', resume: 'unavailable', topUp: 'unavailable', standUp: 'unavailable', remove: 'unavailable' };
  if (hasDeparted(table, participantId)) return none;
  const bot = table.view.state.participants.find(p => p.participantId === participantId);
  const seated = bot?.seat != null;
  const pending = afterHandRequestOf(table, participantId);
  const asks = (change: AfterHandRequestKind) => !pending || afterHandRequestStrength[pending] < afterHandRequestStrength[change];
  const betweenHands = (available: boolean): Availability => available && !handOpen ? 'now' : 'unavailable';
  return {
    sitOut: !seated || bot.sittingOut || !asks('sit-out') ? 'unavailable' : handOpen ? 'after-hand' : 'now',
    resume: betweenHands(seated && bot.sittingOut),
    topUp: betweenHands(seated),
    standUp: betweenHands(seated),
    remove: !asks('remove') ? 'unavailable' : seated && handOpen ? 'after-hand' : 'now',
  };
}
