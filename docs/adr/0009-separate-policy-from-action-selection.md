# Separate Policy from Action Selection

A Strategy composes a logically stateless Policy with an Action Selector: the Policy owns all poker reasoning and returns the authoritative Choice distribution, while the selector only selects from that unchanged distribution. Probability Selector is the default seeded sampler and Highest Probability Selector is the deterministic alternative; manual branch exploration is not an Action Selector. Deck generation, stochastic Policy evaluation, and action selection use independently derived, versioned random sources so changing one cannot implicitly alter the others.

M1 uses a UniformChoicePolicy baseline with equal probabilities across all legal unsized actions and the minimum and maximum legal sized choices, deduplicating coincident choices and preserving a documented deterministic order. It is composed with ProbabilitySelector by default, with HighestProbabilitySelector also available, and carries no claim of poker expertise.
