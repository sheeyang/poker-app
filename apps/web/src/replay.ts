import { decisionStep, type ConcreteAction, type DecisionAnalysis, type ReplayStep, type StrategyDescriptor, type Street, type TableHandReplay, type TableReplayStep } from '@poker/contracts';
import type { FeltView } from './felt-view.js';
import { chips } from './table-model.js';
import { resultLabel } from './table-history.js';
import { identity } from './analysis-identity.js';

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
  return decisionStep(step.state.decisionId ?? '');
}

/** The index of the step `key` names, or the Hand's first step when it names none of them. */
export function openStep(replay: TableHandReplay, key: string | undefined): number {
  const index = key === undefined ? -1 : replay.steps.findIndex(step => stepKey(step, replay.handId) === key);
  return Math.max(0, index);
}

/**
 * The Hand whose list row hides its board and result while it is replayed (Story 21): `handId`, the Hand open on the
 * screen, until the replay has loaded and stands at its result step; nothing when no Hand is open. Until the replay is
 * known the row stays hidden, so the list never gives the Hand away while the felt is still at the deal.
 */
export function concealedHand(handId: string | undefined, replay: TableHandReplay | undefined, step: string | undefined): string | undefined {
  if (!handId) return undefined;
  return replay && replay.steps[openStep(replay, step)]?.kind === 'result' ? undefined : handId;
}

/** Who won what at the result step ("You won 70 · Rex won 70"); nothing at any other step, which does not carry it. */
export function replayResult(replay: TableHandReplay, step: TableReplayStep): string | undefined {
  return step.result && resultLabel(step.result.payouts, participantId => participantId === replay.viewerParticipantId ? 'You' : nameOf(replay, participantId));
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
 * The step at `index` as the felt draws it (`PokerTable`): the step's own state, seen by the reader, everyone seated in
 * the Hand by name and as a Bot or not, and the decisions taken before the step so each seat shows its last action. It
 * has no schedule, no Action Window and nobody disconnected: a replay plays no live timing.
 */
export function stepFelt(replay: TableHandReplay, index: number): FeltView {
  const step = replay.steps[index]!;
  const decisions: FeltView['decisions'][number][] = [];
  for (let i = 1; i <= index; i++) {
    const acted = replay.steps[i]!.transition.acted;
    if (acted && replay.steps[i - 1]!.state.decisionId) decisions.push(acted);
  }
  return {
    tableSessionId: replay.tableSessionId, mode: replay.mode, viewerParticipantId: replay.viewerParticipantId,
    seatCount: replay.configuration.seatCount, state: step.state,
    participants: replay.participants.map(({ participantId, name, bot }) => ({ participantId, name, bot, disconnected: false })),
    decisions, phases: [], actionWindow: null, serverTime: 0,
  };
}

/** The name of a Participant seated in the replayed Hand: the server names every one of them, every actor included. */
const nameOf = (replay: TableHandReplay, participantId: string | null) => replay.participants.find(participant => participant.participantId === participantId)?.name ?? '';

const streetNames: Readonly<Record<Street, string>> = { preflop: 'Preflop', flop: 'Flop', turn: 'Turn', river: 'River' };
/** A step in a few words: whose decision comes next ("Your decision", "Rex to act"), the street just dealt, or the result. */
export function stepLabel(replay: TableHandReplay, step: ReplayStep): string {
  if (step.kind === 'result') return 'Result';
  if (step.kind === 'street') return streetNames[step.state.street ?? 'flop'];
  const actor = step.state.actorId;
  if (actor === replay.viewerParticipantId) return 'Your decision';
  return `${nameOf(replay, actor)} to act`;
}

/** The decision taken just before `step`, in the past tense ("Rex bet 40", "You folded"); none when the step follows no decision. */
export function actedLabel(replay: TableHandReplay, step: ReplayStep): string | undefined {
  const acted = step.transition.acted;
  if (!acted) return undefined;
  const who = acted.participantId === replay.viewerParticipantId ? 'You' : nameOf(replay, acted.participantId);
  const { action } = acted;
  const what = action.type === 'bet' ? `bet ${chips(action.betTo)}` : action.type === 'raise' ? `raised to ${chips(action.raiseTo)}` : { fold: 'folded', check: 'checked', call: 'called' }[action.type];
  return `${who} ${what}`;
}

/** A street's name as the controls show it. */
export const streetName = (street: Street) => streetNames[street];

/** The analysis a Replay Step offers: the reader's own decision there, the action they took, under one Reference Strategy. */
export interface ReplayAnalysisTarget {
  readonly decisionId: string;
  readonly action: ConcreteAction;
  /** Names the decision, the action and the Strategy together: a new Reference Strategy is a new target. */
  readonly key: string;
  /** Whether `data` is the analysis of exactly this target. */
  accepts(data: DecisionAnalysis): boolean;
}

/**
 * The analysis to show at the step at `index` under `referenceStrategy`: only at one of the reader's own decisions,
 * which the server marks, and never at anyone else's or in a Hand they only watched. The action they took there is the
 * one the next step's transition records.
 */
export function replayAnalysisTarget(replay: TableHandReplay, index: number, referenceStrategy: StrategyDescriptor): ReplayAnalysisTarget | undefined {
  const decisionId = replay.steps[index]?.viewerDecisionId;
  const acted = replay.steps[index + 1]?.transition.acted;
  if (!decisionId || acted?.participantId !== replay.viewerParticipantId) return undefined;
  const key = identity([replay.tableSessionId, decisionId, referenceStrategy, acted.action]);
  return {
    decisionId, action: acted.action, key,
    accepts: data => identity([data.tableSessionId, data.decisionId, data.referenceStrategy, data.scoredDecision?.acceptedAction ?? null]) === key,
  };
}
