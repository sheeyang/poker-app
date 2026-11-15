/**
 * The motion lab's scenario presets (ADR-0040): each is a scripted Hand, as data. A scenario names its seats, what each
 * seat does street by street, and what the Hand shows. The model plays the script; it never checks poker rules, but it
 * ends the Hand when one Participant is left, and runs the board out when no one left can bet.
 */

export type ScenarioId = 'heads-up' | '6-handed' | '9-handed' | 'folds' | 'runout' | 'split' | 'rebuy';

/** What a seat does: fold, check, call, or bet or raise to an amount. */
export type Move = 'fold' | 'check' | 'call' | number;
/** One scripted action by the Participant at `seat`. The last action of a street's list ends its betting. */
export interface Step { readonly seat: number; readonly move: Move }

export interface Scenario {
  readonly id: ScenarioId;
  readonly label: string;
  readonly seats: number;
  /** Each street's actions, preflop first; fewer streets than four when the Hand ends early. */
  readonly streets: readonly (readonly Step[])[];
  /** The seats that win the pot, in seat order; two or more split it. */
  readonly winners: readonly number[];
  readonly board: readonly string[];
  /** The seat refilled from an empty stack with the deal (Practice's Rebuy & deal). */
  readonly refill?: number;
}

const BOARD = ['2c', '7d', 'Ts', 'Kc', '3h'];
const act = (seat: number, move: Move): Step => ({ seat, move });

const headsUp: Scenario['streets'] = [
  [act(1, 'call'), act(2, 'check')],
  [act(2, 'check'), act(1, 40), act(2, 'call')],
  [act(2, 'check'), act(1, 'check')],
  [act(2, 60), act(1, 'call')],
];

/** Everyone folds to the seat after the button's raise, then three see a flop where one folds and two see it through. */
const multiway = (seats: number): Scenario['streets'] => {
  const folds = Array.from({ length: seats - 3 }, (_, i) => act(4 + i, 'fold'));
  return [
    [act(3, 60), ...folds, act(1, 'call'), act(2, 'call')],
    [act(1, 'check'), act(2, 'check'), act(3, 100), act(1, 'call'), act(2, 'fold')],
    [act(1, 'check'), act(3, 'check')],
    [act(1, 200), act(3, 'call')],
  ];
};

export const scenarioDefs: readonly Scenario[] = [
  { id: 'heads-up', label: 'Heads-up', seats: 2, streets: headsUp, winners: [1], board: BOARD },
  { id: '6-handed', label: '6-handed', seats: 6, streets: multiway(6), winners: [1], board: BOARD },
  { id: '9-handed', label: '9-handed', seats: 9, streets: multiway(9), winners: [1], board: BOARD },
  { id: 'folds', label: 'Won by folds', seats: 6, winners: [1], board: BOARD, streets: [
    [act(3, 'fold'), act(4, 'fold'), act(5, 'fold'), act(6, 'fold'), act(1, 60), act(2, 'call')],
    [act(1, 'check'), act(2, 'check')],
    [act(1, 80), act(2, 'fold')],
  ] },
  { id: 'runout', label: 'All-in runout', seats: 2, winners: [1], board: BOARD, streets: [[act(1, 1000), act(2, 'call')]] },
  { id: 'split', label: 'Split pot', seats: 2, streets: headsUp, winners: [1, 2], board: ['2c', '7d', 'Ts', '9h', '3d'] },
  { id: 'rebuy', label: 'Rebuy & deal', seats: 2, streets: headsUp, winners: [1], board: BOARD, refill: 2 },
];
