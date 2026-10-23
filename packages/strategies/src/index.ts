import type { ConcreteAction, ObservableGameView, StrategyDescriptor } from '@poker/contracts';
import { createRandomSource } from '@poker/engine';
import { SimpleHeuristicPolicy } from './simple-heuristic.js';
export { SimpleHeuristicPolicy };

export interface Choice { readonly action: ConcreteAction; readonly probability: number }
export interface PolicyResult { readonly choices: readonly Choice[]; readonly diagnostics?: Readonly<Record<string, unknown>> }
export type CompatibilityResult = { readonly compatible: true } | { readonly compatible: false; readonly reasons: readonly { readonly code: string; readonly message: string }[] };
export interface EvaluationOptions { readonly evaluationSeed: string; readonly signal?: AbortSignal }
export interface SelectionOptions { readonly selectionSeed: string }
export interface Policy {
  checkCompatibility(view: ObservableGameView): CompatibilityResult | Promise<CompatibilityResult>;
  evaluate(view: ObservableGameView, options: EvaluationOptions): PolicyResult | Promise<PolicyResult>;
}
export interface ActionSelector { select(choices: readonly Choice[], options: SelectionOptions): ConcreteAction }
export interface Strategy { readonly policy: Policy; readonly actionSelector: ActionSelector }

/** Plain detached snapshots; the caller retains no mutable aliases. */
export function immutableData<T>(value: T): T {
  const copy = structuredClone(value);
  const freeze = (item: unknown): void => { if (item && typeof item === 'object') { Object.values(item).forEach(freeze); Object.freeze(item); } };
  freeze(copy);
  return copy;
}
export class UniformChoicePolicy implements Policy {
  checkCompatibility(view: ObservableGameView): CompatibilityResult {
    return view.state.legalActions.length ? { compatible: true } : { compatible: false, reasons: [{ code: 'no-decision', message: 'A current participant decision is required.' }] };
  }
  evaluate(view: ObservableGameView, _options: EvaluationOptions): PolicyResult {
    const actions: ConcreteAction[] = view.state.legalActions.flatMap<ConcreteAction>(legal => {
      if (legal.type === 'bet' || legal.type === 'raise') {
        const amounts = legal.minimum === legal.maximum ? [legal.minimum] : [legal.minimum, legal.maximum];
        return amounts.map(amount => legal.type === 'bet' ? { type: 'bet' as const, betTo: amount } : { type: 'raise' as const, raiseTo: amount });
      }
      return [{ type: legal.type }];
    });
    return { choices: actions.map(action => ({ action, probability: 1 / actions.length })) };
  }
}
const order = { fold: 0, check: 1, call: 2, bet: 3, raise: 4 };
const size = (action: ConcreteAction) => action.type === 'bet' ? action.betTo : action.type === 'raise' ? action.raiseTo : 0;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
function plainData(value: unknown): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return true;
  if (Array.isArray(value)) return value.every(plainData);
  return object(value) && Object.values(value).every(plainData);
}
export class PolicyValidationError extends Error { constructor() { super('Policy output is not a legal normalized distribution.'); } }
/** Absolute sum tolerance 1e-9; no other output repair. Canonical order ignores probabilities. */
export function validatePolicyResult(raw: PolicyResult, view: ObservableGameView): PolicyResult {
  const invalid = () => { throw new PolicyValidationError(); };
  if (!object(raw) || !Array.isArray(raw.choices) || !raw.choices.length || (raw.diagnostics !== undefined && (!object(raw.diagnostics) || !plainData(raw.diagnostics)))) invalid();
  const seen = new Set<string>();
  let sum = 0;
  for (const choice of raw.choices) {
    if (!object(choice) || !object(choice.action) || typeof choice.probability !== 'number' || !Number.isFinite(choice.probability) || choice.probability < 0 || choice.probability > 1) invalid();
    const action = choice.action;
    if (!Object.hasOwn(order, action.type)) invalid();
    const fields = action.type === 'bet' ? ['type', 'betTo'] : action.type === 'raise' ? ['type', 'raiseTo'] : ['type'];
    if (Object.keys(action).length !== fields.length || Object.keys(action).some(key => !fields.includes(key))) invalid();
    const amount = size(action);
    if ((action.type === 'bet' || action.type === 'raise') && !Number.isSafeInteger(amount)) invalid();
    const legal = view.state.legalActions.some(legal => legal.type === action.type && (!('minimum' in legal) || amount >= legal.minimum && amount <= legal.maximum));
    const identity = action.type + ':' + amount;
    if (!legal || seen.has(identity)) invalid();
    seen.add(identity);
    sum += choice.probability;
  }
  if (!(sum > 0) || Math.abs(sum - 1) > 1e-9) invalid();
  return immutableData({ choices: raw.choices.filter(choice => choice.probability > 0).map(choice => ({ probability: choice.probability / sum, action: { ...choice.action } })).sort((a, b) => order[a.action.type] - order[b.action.type] || size(a.action) - size(b.action)), ...(raw.diagnostics === undefined ? {} : { diagnostics: raw.diagnostics }) });
}

export class ProbabilitySelector implements ActionSelector {
  select(choices: readonly Choice[], options: SelectionOptions): ConcreteAction {
    const unit = createRandomSource(options.selectionSeed).unit();
    let cumulative = 0;
    for (const choice of choices) {
      cumulative += choice.probability;
      if (unit < cumulative) return choice.action;
    }
    // Normalization rounding may place the final cumulative sum just below one.
    if (choices.length) return choices[choices.length - 1]!.action;
    throw new Error('A validated distribution is required.');
  }
}
export class HighestProbabilitySelector implements ActionSelector {
  select(choices: readonly Choice[], _options: SelectionOptions): ConcreteAction {
    let selected = choices[0];
    for (const choice of choices) if (selected && choice.probability > selected.probability) selected = choice;
    if (!selected) throw new Error('A validated distribution is required.');
    return selected.action;
  }
}
export function isSupportedStrategy(value: unknown): value is StrategyDescriptor {
  if (!object(value) || Object.keys(value).length !== 2) return false;
  const valid = (descriptor: unknown, ids: readonly string[]) => object(descriptor) && Object.keys(descriptor).length === 3 && ids.includes(descriptor.id as string) && descriptor.version === 'v1' && object(descriptor.configuration) && Object.keys(descriptor.configuration).length === 0;
  return valid(value.policy, ['uniform-choice', 'simple-heuristic']) && valid(value.selector, ['seeded-sampling', 'highest-probability']);
}
export function createStrategy(descriptor: StrategyDescriptor): Strategy {
  if (!isSupportedStrategy(descriptor)) throw new Error('Unsupported Strategy descriptor.');
  return { policy: descriptor.policy.id === 'simple-heuristic' ? new SimpleHeuristicPolicy() : new UniformChoicePolicy(), actionSelector: descriptor.selector.id === 'highest-probability' ? new HighestProbabilitySelector() : new ProbabilitySelector() };
}
/** Uniform Choice entry points retained for callers that explicitly request the baseline. */
export function isBaselineStrategy(value: unknown): value is StrategyDescriptor {
  return isSupportedStrategy(value) && value.policy.id === 'uniform-choice';
}
export function baselineStrategy(descriptor: StrategyDescriptor): Strategy {
  if (!isBaselineStrategy(descriptor)) throw new Error('Unsupported baseline Strategy descriptor.');
  return createStrategy(descriptor);
}
