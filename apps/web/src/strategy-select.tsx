import { baselinePlayingStrategy, highestProbabilityPlayingStrategy, simpleHeuristicPlayingStrategy, type StrategyDescriptor } from '@poker/contracts';

const strategies: readonly StrategyDescriptor[] = [
  simpleHeuristicPlayingStrategy,
  { ...simpleHeuristicPlayingStrategy, selector: highestProbabilityPlayingStrategy.selector },
  baselinePlayingStrategy,
  highestProbabilityPlayingStrategy,
];
const identity = (strategy: StrategyDescriptor) => `${strategy.policy.id}:${strategy.selector.id}`;

export function policyName(strategy: StrategyDescriptor): string {
  return strategy.policy.id === 'simple-heuristic' ? 'Simple Heuristic' : strategy.policy.id === 'uniform-choice' ? 'Uniform Choice' : strategy.policy.id;
}

export function strategyName(strategy: StrategyDescriptor): string {
  return `${policyName(strategy)} · ${strategy.selector.id === 'seeded-sampling' ? 'Probability Selector' : 'Highest Probability'}`;
}

export function StrategySelect({ value, disabled, onChange }: { value: StrategyDescriptor; disabled?: boolean; onChange: (strategy: StrategyDescriptor) => void }) {
  return <select value={identity(value)} disabled={disabled} onChange={event => {
    const strategy = strategies.find(option => identity(option) === event.target.value);
    if (strategy) onChange(strategy);
  }}>{strategies.map(strategy => <option key={identity(strategy)} value={identity(strategy)}>{strategyName(strategy)}</option>)}</select>;
}
