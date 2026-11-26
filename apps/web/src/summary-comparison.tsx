import { strategyToken, type StrategyDescriptor } from '@poker/contracts';
import { useShell } from './app-shell.js';
import { addableStrategies, comparisonOrder } from './comparison.js';
import { strategyName } from './strategy-select.js';
import { useTrainerConfiguration } from './trainer-configuration.js';

/**
 * Side-by-side Score Summaries (ADR-0041): the User's Reference Strategy and up to 3 others, each its own column. The
 * Reference Strategy is the User's Trainer Configuration, read outside any table; the others live in the address.
 */
export function useSummaryStrategies(compared: readonly StrategyDescriptor[]) {
  const { identity } = useShell();
  const configuration = useTrainerConfiguration(identity.isSuccess);
  const reference = configuration.data?.trainerConfiguration.referenceStrategy;
  return {
    reference,
    /** The compared Strategies beside the Reference Strategy, deduplicated against it; none until it is read. */
    shown: reference ? comparisonOrder(reference, compared).slice(1) : [],
  };
}

/** "Compare with": add one more supported Strategy, or remove them in their columns. Changes only the address. */
export function CompareBar({ id, reference, shown, onCompare }: { id: string; reference: StrategyDescriptor | undefined; shown: readonly StrategyDescriptor[]; onCompare: (strategies: readonly StrategyDescriptor[]) => void }) {
  if (!reference) return null;
  const addable = addableStrategies(reference, shown);
  return <div className="compare-bar summary-compare">
    <label htmlFor={id}>Compare with</label>
    {addable.length > 0
      ? <select id={id} value="" onChange={event => { const added = addable.find(strategy => strategyToken(strategy) === event.target.value); if (added) onCompare([...shown, added]); }}>
        <option value="">Add a Strategy…</option>
        {addable.map(strategy => <option key={strategyToken(strategy)} value={strategyToken(strategy)}>{strategyName(strategy)}</option>)}
      </select>
      : <span className="compare-full" id={id}>Every other Strategy is shown.</span>}
    <p>The same decisions under each. This doesn’t change your Trainer Configuration.</p>
  </div>;
}

/** A column's heading: the Strategy's name, at heading `level` (3 unless given), and its Reference tag or Remove button. */
export function ColumnHead({ name, reference, onRemove, headingId, level = 3 }: { name: string; reference: boolean; onRemove?: () => void; headingId: string; level?: 3 | 4 }) {
  const Heading = level === 4 ? 'h4' : 'h3';
  return <header className="strategy-head">
    <Heading id={headingId}>{name}</Heading>
    {reference ? <span className="history-tag is-reference">Reference</span> : <button type="button" className="strategy-remove" onClick={onRemove} aria-label={`Remove ${name} from the comparison`}>Remove</button>}
  </header>;
}
