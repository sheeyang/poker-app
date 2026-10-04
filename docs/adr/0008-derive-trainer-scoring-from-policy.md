# Derive Trainer Scoring from the Reference Policy

The Trainer will use one human-selected Reference Strategy Policy for recommendations, counterfactual comparison, Decision Score, and Action Rank Score rather than introducing a separate decision evaluator. An unsized action's Decision Score is its Choice probability; a sized action takes the maximum same-type `ChoiceProbability × SizingSimilarity`, where similarity is the smaller additional commitment divided by the larger. This deliberately scores low-frequency mixed actions lower and represents per-decision Policy alignment—not EV, regret, accuracy, strategic quality, or long-run frequency calibration.

`packages/research` owns the shared implementation of Decision Score, Action Probability, Action Rank Score, and Hand/session/history score aggregation. These analysis functions consume frozen participant-safe views, validated Policy results, and the concrete decisions being analyzed, returning plain normalized results without mutating a game or accessing hidden facts. Policies produce distributions, the Strategies framework validates them, Research interprets them, and the frontend formats and presents the resulting scores rather than implementing its own scoring formulas. This ownership does not introduce a DecisionEvaluator abstraction or couple Policies to Trainer scoring.

## Complete scoring rules

For Fold, Check, or Call, use the probability of the matching concrete choice, or zero if it is absent. For a legal Bet or Raise, compare only choices of the same action type, using the frozen participant's street commitment before the decision:

```text
ChosenAdded = chosenTo - chipsAlreadyCommittedThisStreet
ReferenceAdded = referenceTo - chipsAlreadyCommittedThisStreet
SizingSimilarity = min(ChosenAdded, ReferenceAdded)
                   / max(ChosenAdded, ReferenceAdded)
DecisionScore = max(ChoiceProbability * SizingSimilarity)
```

Legal sized choices add positive chips, so the denominator is positive. No same-type Policy choice yields Decision Score zero. Use every returned same-type sizing even if the player's exact amount is not in the distribution; the result measures only numerical Policy alignment. Do not require a separate Sizing Quality metric, DecisionEvaluator, EV-based score, Top-Action Agreement, or Frequency Calibration metric.

Action Probability sums all concrete-choice probabilities of one action type. For Action Rank Score, aggregate every currently legal action type, including those absent from the Policy at probability zero. Sort the distinct aggregated probability values from highest to lowest: with `k > 1` distinct ranks, rank index `i` starting at zero scores `1 - i / (k - 1)`. Equal probabilities share a rank, and if there is only one distinct rank, every legal action type scores one. Bet or Raise sizing never affects this rank. All probabilities and scores are normalized internally to `0.00–1.00`.

## Trainer presentation

Use an always-expanded tree: legal action types show aggregated probabilities, and Bet or Raise children show their exact amounts and original unconditional Choice probabilities, not probabilities divided by the parent. Fold, Check, and Call are leaves. Display probabilities as `0.00–1.00`, distinctly from scores shown as `/100`; make Decision Score visually primary with Action Rank Score underneath, and expose underlying Action Probability in a tooltip or expanded analysis.

For each analyzed decision, evaluate both parts of the complete Reference Strategy and show the Policy distribution alongside the ConcreteAction returned by its ActionSelector. A ProbabilitySelector result is a reproducible sampled choice, not necessarily the highest-probability or objectively best action. The selected sample does not replace the Policy distribution or change the human's Policy-derived scores. Playing and Reference Strategies share one type; do not introduce separate AnalysisReference, ReferencePolicy, or TrainerAnalysisConfig abstractions.
