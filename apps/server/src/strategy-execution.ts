import type { ConcreteAction, ObservableGameView } from '@poker/contracts';
import { validatePolicyResult, PolicyValidationError, type EvaluationOptions, type PolicyResult, type SelectionOptions, type Strategy } from '@poker/strategies';
import { canonical } from './canonical.js';
import { JobFailure } from './job-runner.js';

/** Shared execution contract; callers retain scheduling, result acceptance and persistence. */
export async function executeStrategy(strategy: Strategy, view: ObservableGameView, options: EvaluationOptions & SelectionOptions): Promise<{ readonly policyResult: PolicyResult; readonly selectedAction: ConcreteAction }> {
  if (!(await strategy.policy.checkCompatibility(view)).compatible) throw new JobFailure('incompatible');
  const raw = await strategy.policy.evaluate(view, { evaluationSeed: options.evaluationSeed, signal: options.signal });
  let policyResult;
  try { policyResult = validatePolicyResult(raw, view); }
  catch (error) { if (error instanceof PolicyValidationError) throw new JobFailure('invalid-policy'); throw error; }
  try {
    const selectedAction = strategy.actionSelector.select(policyResult.choices, { selectionSeed: options.selectionSeed });
    if (!policyResult.choices.some(choice => canonical(choice.action) === canonical(selectedAction))) throw new Error('Not a Choice.');
    return { policyResult, selectedAction };
  } catch { throw new JobFailure('selection-failed'); }
}
