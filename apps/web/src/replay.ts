import { defaultTrainerConfiguration, type ObservableHistoryEntry, type ObservableTableSession, type ReplayStep, type Street, type TableHandReplay } from '@poker/contracts';
import { chips } from './table-model.js';

/**
 * Replay of one completed Hand of Table History (ADR-0041), as pure model: where each Replay Step lives in the address,
 * what the controls go to, and the table each step draws on the felt. The server projects every step; nothing here
 * reconstructs or reveals anything, it only arranges what the steps already show.
 */

/**
 * A step's name in the address: `decision-N` before that decision of the Hand, the street (`flop`, `turn`, `river`)
 * after its reveal, or `result`. Each names one step of its Hand, so an address reopens the same step after a reload.
 */
export function stepKey(step: ReplayStep, handId: string): string {
  if (step.kind === 'result') return 'result';
  if (step.kind === 'street') return step.state.street ?? 'flop';
  const decisionId = step.state.decisionId ?? '';
  return decisionId.startsWith(handId + '/') ? decisionId.slice(handId.length + 1) : decisionId;
}

/** The index of the step `key` names, or the Hand's first step when it names none of them. */
export function openStep(replay: TableHandReplay, key: string | undefined): number {
  const index = key === undefined ? -1 : replay.steps.findIndex(step => stepKey(step, replay.handId) === key);
  return Math.max(0, index);
}

/** Where each replay control goes from the step at `index`, as step keys; absent where there is nowhere to go. */
export interface ReplayControls {
  readonly previous: string | undefined;
  readonly next: string | undefined;
  /** Every street the Hand reached, at the step that opens it: preflop at the Hand's first step, the others at their reveal. */
  readonly streets: readonly { readonly street: Street; readonly step: string; readonly current: boolean }[];
  /** The viewer's next decision after this step. */
  readonly nextDecision: string | undefined;
}

export function replayControls(replay: TableHandReplay, index: number): ReplayControls {
  const { steps, handId } = replay;
  const key = (i: number) => (steps[i] ? stepKey(steps[i], handId) : undefined);
  const streetOf = (step: ReplayStep): Street => step.state.street ?? 'preflop';
  const opens = steps.flatMap((step, i) => i === 0 || step.kind === 'street' ? [{ street: streetOf(step), step: key(i)! }] : []);
  const on = steps[index] ? streetOf(steps[index]) : undefined;
  const ahead = steps.findIndex((step, i) => i > index && step.viewerDecisionId !== undefined);
  return {
    previous: index > 0 ? key(index - 1) : undefined,
    next: key(index + 1),
    streets: opens.map(open => ({ ...open, current: open.street === on })),
    nextDecision: ahead >= 0 ? key(ahead) : undefined,
  };
}

/**
 * The step at `index` as a table the felt draws (`PokerTable`): the step's own state, seen by the reader, with the
 * decisions taken before it in the Hand's history so each seat shows its last action. It has no schedule, no Action
 * Window and nobody disconnected: a replay plays no live timing.
 */
export function replayTable(replay: TableHandReplay, index: number): ObservableTableSession {
  const step = replay.steps[index]!;
  const decisions: ObservableHistoryEntry['decisions'][number][] = [];
  for (let i = 1; i <= index; i++) {
    const acted = replay.steps[i]!.transition.acted, before = replay.steps[i - 1]!;
    if (acted && before.state.decisionId) decisions.push({ decisionId: before.state.decisionId, state: before.state, action: acted });
  }
  const players = replay.players.map(player => player.participantId);
  return {
    tableSessionId: replay.tableSessionId, mode: replay.mode, options: { actionTimeLimitSeconds: null, allowLiveAnalysis: false },
    viewerParticipantId: replay.viewerParticipantId, ownerParticipantId: '', pokerRevision: 0, sessionRevision: 0,
    bindings: replay.players.map(player => ({ participantId: player.participantId, name: player.name, controller: { kind: 'human' } })),
    trainerConfiguration: defaultTrainerConfiguration,
    view: { configuration: replay.configuration, state: step.state, history: [{ handId: replay.handId, description: `Hand ${replay.hand.handNumber}`, decisions }] },
    schedule: { phases: [], actionWindow: null }, serverTime: 0, pendingChanges: [], connectedParticipantIds: players,
    inspection: { adminMode: false, completedHands: [] },
  };
}

const streetNames: Readonly<Record<Street, string>> = { preflop: 'Preflop', flop: 'Flop', turn: 'Turn', river: 'River' };
/** A step in a few words: whose decision comes next ("Your decision", "Rex to act"), the street just dealt, or the result. */
export function stepLabel(replay: TableHandReplay, step: ReplayStep): string {
  if (step.kind === 'result') return 'Result';
  if (step.kind === 'street') return streetNames[step.state.street ?? 'flop'];
  const actor = step.state.actorId;
  if (actor === replay.viewerParticipantId) return 'Your decision';
  return `${replay.players.find(player => player.participantId === actor)?.name ?? 'Next player'} to act`;
}

/** The decision taken just before `step`, in the past tense ("Rex bet 40", "You folded"); none when the step follows no decision. */
export function actedLabel(replay: TableHandReplay, step: ReplayStep): string | undefined {
  const acted = step.transition.acted;
  if (!acted) return undefined;
  const who = acted.participantId === replay.viewerParticipantId ? 'You' : replay.players.find(player => player.participantId === acted.participantId)?.name ?? 'A player';
  const { action } = acted;
  const what = action.type === 'bet' ? `bet ${chips(action.betTo)}` : action.type === 'raise' ? `raised to ${chips(action.raiseTo)}` : { fold: 'folded', check: 'checked', call: 'called' }[action.type];
  return `${who} ${what}`;
}

/** A street's name as the controls show it. */
export const streetName = (street: Street) => streetNames[street];
