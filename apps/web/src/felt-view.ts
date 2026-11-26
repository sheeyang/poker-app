import type { ActionWindow, AfterHandRequestKind, ConcreteAction, ObservableCashGameState, ObservableTableSession, PresentationPhase, TableMode } from '@poker/contracts';
import { connectionOf } from './online-status.js';
import { decisionWindow } from './presentation.js';
import { afterHandRequestOf } from './self-service.js';

/**
 * What the table felt draws (`PokerTable`) and its motion plays: the seats, who sits in them by name and whether each
 * is a Bot, their stacks and cards, the board and the pots, and the schedule that presents them. The live table and a
 * replay both supply one. It holds no ownership, revisions or table options: the felt draws the table, it never manages
 * or changes it. Pure.
 */
export interface FeltView {
  readonly tableSessionId: string;
  readonly mode: TableMode;
  /** The Participant the felt is drawn for: their seat is at the bottom, and only their own cards are face up. */
  readonly viewerParticipantId: string;
  readonly seatCount: number;
  /** The table as the viewer sees it: seats, stacks, cards, board, pots and the decision being made. */
  readonly state: ObservableCashGameState;
  /** Everyone who may be at the table, by name. */
  readonly participants: readonly FeltParticipant[];
  /** The current Hand's decisions so far, oldest first: each seat shows its last action. */
  readonly decisions: readonly { readonly participantId: string; readonly action: ConcreteAction }[];
  /** The Presentation Phases that present the table, and the acting Participant's Action Window. */
  readonly phases: readonly PresentationPhase[];
  readonly actionWindow: ActionWindow | null;
  /** The server time this view shows: motion of changes since the last view is timed from it. */
  readonly serverTime: number;
}

/** A Participant as the felt names them. */
export interface FeltParticipant {
  readonly participantId: string;
  readonly name: string;
  readonly bot: boolean;
  /** A player at an Online Table with no live connection to it. Never a Bot, and never anyone in a replay. */
  readonly disconnected: boolean;
  /** The After-Hand Request waiting for them, public to everyone at the table. */
  readonly pending?: AfterHandRequestKind;
}

/** The live table's felt: its view, schedule and bindings, with who is connected and what waits for the Hand to end. */
export function liveFelt(table: ObservableTableSession): FeltView {
  const state = table.view.state;
  return {
    tableSessionId: table.tableSessionId, mode: table.mode, viewerParticipantId: table.viewerParticipantId,
    seatCount: table.view.configuration.seatCount, state,
    participants: table.bindings.map(binding => {
      const pending = afterHandRequestOf(table, binding.participantId);
      return {
        participantId: binding.participantId, name: binding.name, bot: binding.controller.kind === 'bot',
        disconnected: connectionOf(table, binding.participantId) === 'disconnected', ...(pending ? { pending } : {}),
      };
    }),
    decisions: (table.view.history.find(entry => entry.handId === state.handId)?.decisions ?? []).map(decision => decision.action),
    phases: table.schedule.phases, actionWindow: table.schedule.actionWindow, serverTime: table.serverTime,
  };
}

/** The felt's Participant `participantId`, if they have a place at the table. */
export const feltParticipant = (felt: FeltView, participantId: string | undefined): FeltParticipant | undefined =>
  felt.participants.find(participant => participant.participantId === participantId);

/** The Action Window of the felt's current decision, if its schedule has one. */
export const feltWindow = (felt: FeltView): ActionWindow | undefined => decisionWindow(felt.state, felt.actionWindow);
