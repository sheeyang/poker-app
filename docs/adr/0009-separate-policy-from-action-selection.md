# Separate Policy from Action Selection

A Strategy composes a logically stateless Policy with an Action Selector: the Policy owns all poker reasoning and returns the authoritative Choice distribution, while the selector only selects from that unchanged distribution. Probability Selector is the default seeded sampler and Highest Probability Selector is the deterministic alternative; manual branch exploration is not an Action Selector. Deck generation, stochastic Policy evaluation, and action selection use independently derived, versioned random sources so changing one cannot implicitly alter the others.

M1 uses a UniformChoicePolicy baseline with equal probabilities across all legal unsized actions and the minimum and maximum legal sized choices, deduplicating coincident choices. Its result passes through the same shared validation and canonical ordering as every other Policy result. It is composed with ProbabilitySelector by default, with HighestProbabilitySelector also available, and carries no claim of poker expertise.

## Concrete choices and execution

Developers implement Policies and ActionSelectors; users select complete Strategies containing one configured instance of each. Every Bot has an independently selected Playing Strategy, and the human selects a Reference Strategy of the same type independently of the Bots. Policies may be heuristic, rule-based, EV-based, solver-derived, exploitative, adaptive, machine-learning-based, or stochastic; all changes to strategic preference belong in the Policy.

```typescript
type ConcreteAction =
  | { readonly type: "fold" }
  | { readonly type: "check" }
  | { readonly type: "call" }
  | { readonly type: "bet"; readonly betTo: ChipAmount }
  | { readonly type: "raise"; readonly raiseTo: ChipAmount };

interface Choice {
  readonly action: ConcreteAction;
  readonly probability: number;
}

interface PolicyResult {
  readonly choices: readonly Choice[];
  readonly diagnostics?: Readonly<Record<string, unknown>>;
}

interface Strategy {
  readonly policy: Policy;
  readonly actionSelector: ActionSelector;
}

interface ActionSelector {
  select(
    choices: readonly Choice[],
    options: SelectionOptions,
  ): ConcreteAction;
}
```

The Policy receives an immutable participant-safe ObservableGameView directly, using its existing configuration, state, and history fields as defined in ADR-0017. Do not introduce a separate StrategyContext or a mapping that merely renames those fields: it adds no distinct information or responsibility. Policy configuration and execution options, including the explicit evaluation seed when needed, remain separate from the game view. Pass a snapshot rather than CashGame, ParticipantCashGame, or the WebSocket update envelope; historical and hypothetical evaluations use the same view shape with the appropriate frozen or consistently derived observable facts.

```typescript
const view = game.forParticipant(participantId).getView();

// Inside the Policy job, using the immutable snapshot supplied by JobRunner:
const rawResult = await configuredPolicy.evaluate(
  view,
  { evaluationSeed },
);

const result = validatePolicyResult(rawResult, view);
```

The Policy may evaluate synchronously or asynchronously and always returns a PolicyResult object, not a bare Choice array or a union of array and object shapes. Its choices remain a finite, flat distribution; optional diagnostics are Policy-specific plain data and do not change selection. Choice probabilities sum to one. Sized actions use exact integer chips and represent total committed chips on the current street, not additional chips; internally expressed pot fractions or other sizing rules must be converted to legal exact amounts. Any legal size may be returned, with multiple meaningful sizes allowed and no global public sizing buckets. All-in is an ordinary legal Bet, Raise, or Call that exhausts the stack, not another action type.

The Strategy framework exposes compatibility checks for configured Strategies through `checkCompatibility(view)`, accepting the same immutable ObservableGameView rather than separate configuration and state arguments or another context type. Checks run before evaluation and return structured reasons for unsupported configurations or decisions. A general-purpose Policy may accept broadly; specialized and solver-derived Policies must not silently analyze unsupported games.

## Shared Policy-result validation and canonicalization

A Policy may construct its choices in any internal order. Before its result is exposed to selectors, analysis, overlays, comparison, or other consumers, a shared `validatePolicyResult` helper owned by the framework in `packages/strategies` validates and canonicalizes it. Individual Policies, ActionSelectors, Research workflows, and JobRunner do not own separate validators or canonicalizers; execution paths use the same framework helper. Validation checks nonempty legal distributions, finite probabilities in range, at least one positive probability, duplicate concrete actions, exact integer Bet/Raise amounts and their legality, and a probability sum approximately equal to one. The helper uses the frozen ObservableGameView from that evaluation for legality checks, not the current mutable game. Invalid output is rejected rather than silently merging duplicates, repairing illegal choices, or inventing probabilities.

Distribution validation does not replace engine action validation. CashGame owns poker legality and describes the legal choices in the observable view; the framework checks Policy output against that frozen description, while CashGame independently validates every action actually submitted against its current authoritative state.

The helper returns a new immutable PolicyResult with canonical choices and the original informational diagnostics; it does not mutate the raw result. Omit zero-probability entries, and correct only probability-sum drift within a documented floating-point normalization tolerance. The canonicalizer applies one documented deterministic order based on concrete action type and exact sizing, independent of Policy construction order or probability-based preferences. The precise canonical comparator and numerical normalization tolerance must be defined and tested before implementation is treated as complete; this decision does not select those constants.

This replaces the earlier requirement to preserve raw Policy Choice order through validation. The validated, canonical choices are the single authoritative distribution consumed everywhere. Policies decide probabilities and sizes, the shared helper verifies and standardizes the result, and selectors only select from the supplied canonical choices. Selectors do not perform their own ordering or Policy-result validation. Evaluation and selection failures remain explicit and do not produce fallback poker actions.

ProbabilitySelector performs seeded probability-based sampling without changing the distribution. HighestProbabilitySelector scans the supplied canonical Choice order and keeps the first highest-probability concrete choice: replace the selected entry only on a strictly greater probability. It does not sort, break ties separately, use randomness, or consume a selection seed. Neither selector performs poker reasoning, and any compatible selector can be used for Bot play or analysis; manual branch selection remains a direct user/tooling operation, not a ManualSelector.

## Declared randomness and configuration

Derive independent seeds directly from the hidden master seed and stable identities, never by sequentially consuming a shared RNG:

```text
deriveSeed(masterSeed, "deck", handSequence)
deriveSeed(masterSeed, "policy", participantId, decisionId)
deriveSeed(masterSeed, "selector", participantId, decisionId)
```

The derivation and shuffle algorithms must be explicitly defined and versioned. Authoritative Hand and Decision identifiers make seeds reconstructible by random access, and changing one subsystem's consumption or configuration cannot consume another's randomness. The server supplies effective Policy and selection seeds without exposing the master seed; deterministic implementations may ignore them. Automated selections retain identity, version, configuration, and effective seeds or their reconstructible provenance as application data, while the engine record persists only poker inputs and accepted actions.

Given identical implementation/version, configuration, observable inputs, and evaluation seed, a Policy must logically reproduce its distribution. Given identical choices, selector implementation/version/configuration, and selection seed, selection must reproduce its action. Do not depend on undeclared Math.random(), mutable external state, or wall-clock timing; exact bit-for-bit equality across different hardware or numerical backends is not required when impractical.

Every parameter affecting output belongs in that Policy's declared configuration, such as Monte Carlo sample count, solver iterations and abstraction settings, model artifact selection, or heuristic thresholds. Prefer deterministic counts or limits over elapsed-time-only computation controls, and do not add a universal computationBudget to the Policy contract. Optional diagnostics may describe error estimates or solver quality but cannot change action selection. The same validated, canonical `PolicyResult.choices` powers overlays, Action Probability, Action Rank Score, Decision Score, comparisons, and selector execution.
