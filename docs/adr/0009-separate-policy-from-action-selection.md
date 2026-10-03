# Separate Policy from Action Selection

A Strategy composes a logically stateless Policy with an Action Selector: the Policy owns all poker reasoning and returns the authoritative Choice distribution, while the selector only selects from that unchanged distribution. Probability Selector is the default seeded sampler and Highest Probability Selector is the deterministic alternative; manual branch exploration is not an Action Selector. Deck generation, stochastic Policy evaluation, and action selection use independently derived, versioned random sources so changing one cannot implicitly alter the others.

M1 uses a UniformChoicePolicy baseline with equal probabilities across all legal unsized actions and the minimum and maximum legal sized choices, deduplicating coincident choices and preserving a documented deterministic order. It is composed with ProbabilitySelector by default, with HighestProbabilitySelector also available, and carries no claim of poker expertise.

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

interface Strategy {
  readonly policy: Policy;
  readonly actionSelector: ActionSelector;
}

interface StrategyContext {
  readonly gameConfiguration: ObservableGameConfiguration;
  readonly gameState: ObservableCashGameState;
  readonly observableSessionHistory: ObservableSessionHistory;
}

interface ActionSelector {
  select(
    choices: readonly Choice[],
    options: SelectionOptions,
  ): ConcreteAction;
}
```

The Policy receives participant-safe StrategyContext together with its declared configuration and an explicit evaluation seed when needed, and may evaluate synchronously or asynchronously. It returns an authoritative finite, flat Choice distribution, optionally with informational diagnostics. Choice probabilities sum to one. Sized actions use exact integer chips and represent total committed chips on the current street, not additional chips; internally expressed pot fractions or other sizing rules must be converted to legal exact amounts. Any legal size may be returned, with multiple meaningful sizes allowed and no global public sizing buckets. All-in is an ordinary legal Bet, Raise, or Call that exhausts the stack, not another action type.

The Strategy framework exposes compatibility checks for configured Strategies using ObservableGameConfiguration and ObservableCashGameState before evaluation, returning structured reasons for unsupported configurations or decisions. A general-purpose Policy may accept broadly; specialized and solver-derived Policies must not silently analyze unsupported games. Validate nonempty legal distributions, finite probabilities in range, at least one positive probability, uniqueness of concrete actions, and normalization before any analysis or selection. Omit zero-probability entries; only documented floating-point normalization tolerance may be corrected, never invalid probabilities or illegal actions. Preserve Choice order through validation. Evaluation and selection failures are explicit and do not produce fallback poker actions.

ProbabilitySelector performs seeded probability-based sampling without changing the distribution. HighestProbabilitySelector scans the existing Choice order and keeps the first highest-probability concrete choice: replace the selected entry only on a strictly greater probability. It does not sort, break ties separately, use randomness, or consume a selection seed. Neither selector performs poker reasoning, and any compatible selector can be used for Bot play or analysis; manual branch selection remains a direct user/tooling operation, not a ManualSelector.

## Declared randomness and configuration

Derive independent seeds directly from the hidden master seed and stable identities, never by sequentially consuming a shared RNG:

```text
deriveSeed(masterSeed, "deck", handSequence)
deriveSeed(masterSeed, "policy", participantId, decisionId)
deriveSeed(masterSeed, "selector", participantId, decisionId)
```

The derivation and shuffle algorithms must be explicitly defined and versioned. Authoritative Hand and Decision identifiers make seeds reconstructible by random access, and changing one subsystem's consumption or configuration cannot consume another's randomness. The server supplies effective Policy and selection seeds without exposing the master seed; deterministic implementations may ignore them. Automated selections retain identity, version, configuration, and effective seeds or their reconstructible provenance as application data, while the engine record persists only poker inputs and accepted actions.

Given identical implementation/version, configuration, observable inputs, and evaluation seed, a Policy must logically reproduce its distribution. Given identical choices, selector implementation/version/configuration, and selection seed, selection must reproduce its action. Do not depend on undeclared Math.random(), mutable external state, or wall-clock timing; exact bit-for-bit equality across different hardware or numerical backends is not required when impractical.

Every parameter affecting output belongs in that Policy's declared configuration, such as Monte Carlo sample count, solver iterations and abstraction settings, model artifact selection, or heuristic thresholds. Prefer deterministic counts or limits over elapsed-time-only computation controls, and do not add a universal computationBudget to the Policy contract. Optional diagnostics may describe error estimates or solver quality but cannot change action selection. The same validated Choice distribution powers overlays, Action Probability, Action Rank Score, Decision Score, comparisons, and selector execution.
