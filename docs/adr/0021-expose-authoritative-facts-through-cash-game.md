# Expose Authoritative Facts Through CashGame

CashGame is the trusted server-side game abstraction and may expose immutable authoritative domain facts, including hidden cards and configuration, while encapsulating PokerCore, mutable collections, RNG objects, and other implementation details. ParticipantCashGame is the sole game-facing information boundary supplied to participants, Bots, Policies, and participant-facing application paths. Research restores a CashGame from the poker record and reads completed-Hand facts through its authoritative APIs without a separate privileged replay adapter; the Research and server layers enforce Hand completion and construct browser-facing results that omit the master seed.

CashGame and ParticipantCashGame objects stay server-side. When a client feature needs a result requiring full authoritative information, the server computes it and constructs an authorized result DTO rather than transferring the game or its unrestricted state for browser computation. Normal Policy and equity evaluation retain their participant-visible inputs, while privileged completed-Hand Research uses authoritative inputs only within its authorized server path.

## Participant-safe analysis and privileged inspection

`packages/research` is a server-only analysis layer, not exclusively a completed-Hand inspection layer. It owns shared Trainer scoring and summary computation, Range Visualizer hypothetical-input construction and aggregation, and Poker Math Overlay calculations. These ordinary analysis functions use immutable participant-safe inputs, return plain results through JobRunner, and may run during live play or later review without requiring the Hand to have completed. They do not receive an unrestricted CashGame or authoritative hidden state merely because they live in Research.

Privileged hidden-information inspection is a separate Research path that consumes authoritative persisted data and requires both authorization and Hand completion. The completion gate applies to that inspection path, not to participant-safe live analysis. The frontend owns grids, filters, overlays, score formatting, and interaction; it does not duplicate the Research computations or import the server-only package. Legal-action calculation, observability, accepted-command recording, and deterministic poker replay remain engine responsibilities.

## Replay, history, and counterfactual analysis

Every completed Hand becomes available in hand history. Normal replay proceeds action by action and permits inspection of each decision while reproducing information that was legally visible at that point, not everything revealed later. Review may select the current Reference Strategy or another compatible Strategy and recompute derived analysis using historical ParticipantCashGame snapshots.

For counterfactual comparison, freeze the original participant's ObservableGameConfiguration, ObservableCashGameState, and ObservableSessionHistory at the exact recorded decision and give that same context to every compatible candidate Strategy. Evaluate candidates independently even if their earlier choices would never have reached this situation; a Bot normally using a candidate Strategy contributes no different personal history. Compare the resulting distributions and selected actions without modifying the authoritative game or leaking later hidden facts into analysis.

Historical reconstruction orchestration, completed-Hand inspection, and counterfactual orchestration belong to `packages/research`, not the engine or Strategies package; the engine still implements deterministic replay and historical participant projections. Research computes plain results through JobRunner but does not own database or cache infrastructure. The server authenticates and authorizes access, supplies the participant-safe snapshot or loads the private poker record appropriate to the operation, checks completion when privileged inspection is requested, submits Research work through JobRunner, owns result persistence/caching, and constructs the permitted browser DTO.

## Admin-only hidden-information reveal

The **Reveal Hidden Information** control is visible only in **Admin Mode**, which is enabled by default for M1. This is an application-level privileged mode, not an engine rule or an expansion of participant observability. Its server-side access check is required even if a caller bypasses the UI; disabling Admin Mode removes access to privileged reveal, not merely the visible control.

Authorized reveal is an explicit read-only operation for a completed Hand and may expose all hole cards, burn cards, and the reconstructed shuffled deck or deal trace where useful. Research must reject active-Hand inspection even in Admin Mode. The server retains the master seed and omits it from browser-facing results. Completion and authorization remain mandatory for the Playground as well as the product interface.

Revealing information never changes earlier observable snapshots or the inputs to normal Policy evaluation, Decision Scores, or Strategy comparison. Those analyses always reconstruct the original participant-visible context. Admin Mode does not grant a Bot or Policy access to hidden information and does not mutate poker state or accepted command history.
