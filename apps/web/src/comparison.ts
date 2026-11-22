import { maximumComparedStrategies, strategyToken, supportedStrategies, type StrategyDescriptor, type TableHandReplay } from '@poker/contracts';
import { replayAnalysisTarget, type ReplayAnalysisTarget } from './replay.js';

/**
 * Counterfactual Comparison of one decision (ADR-0041), as pure model. The Strategies live in the address, never in the
 * Guest's Trainer Configuration. Each Strategy is its own analysis request and its own result, on the same frozen inputs
 * and seeds the server gives them, so the comparison is only the list of Strategies and one target for each.
 */

/** The Strategies shown at a decision: the Reference Strategy always first, then the chosen ones in order. Never repeats one, and never exceeds the Reference plus 3. */
export function comparisonOrder(reference: StrategyDescriptor, compared: readonly StrategyDescriptor[]): StrategyDescriptor[] {
  const others = compared.filter((strategy, index) => strategyToken(strategy) !== strategyToken(reference) && compared.findIndex(other => strategyToken(other) === strategyToken(strategy)) === index);
  return [reference, ...others.slice(0, maximumComparedStrategies)];
}

/** The supported Strategies the reader can still add: not the Reference Strategy, not already compared, and none once 3 are. */
export function addableStrategies(reference: StrategyDescriptor, compared: readonly StrategyDescriptor[]): StrategyDescriptor[] {
  const shown = comparisonOrder(reference, compared);
  return shown.length > maximumComparedStrategies ? [] : supportedStrategies.filter(strategy => !shown.some(other => strategyToken(other) === strategyToken(strategy)));
}

/** The analysis of one Strategy at a Replay Step: the decision's target under that Strategy. */
export interface ComparisonTarget extends ReplayAnalysisTarget { readonly strategy: StrategyDescriptor }

/**
 * One analysis target per compared Strategy at the Replay Step at `index`, the Reference Strategy first. It is only at the
 * reader's own decisions: none at anyone else's, in a Hand they only watched, or between decisions. A Strategy's target
 * is the same whichever others are shown, so adding or removing one leaves the rest where they were.
 */
export function comparisonTargets(replay: TableHandReplay, index: number, reference: StrategyDescriptor, compared: readonly StrategyDescriptor[]): ComparisonTarget[] {
  return comparisonOrder(reference, compared).flatMap(strategy => {
    const target = replayAnalysisTarget(replay, index, strategy);
    return target ? [{ ...target, strategy }] : [];
  });
}
