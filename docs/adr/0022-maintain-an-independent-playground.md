# Maintain an Independent Playground Through All Milestones

M1 will deliver a minimal playable engine-and-server vertical slice through a functional React Playground, with animations and polished product UX deferred. The Playground remains an engineering interface throughout M1-M5, and new platform capabilities are exercised there before their product experiences are planned and implemented. It is maintained independently of the final application so validation tooling does not dictate Trainer or Research Lab UX; M2 introduces the full Trainer and animations, M3 Replay and Research, M4 the Solver, and M5 mass simulation and benchmarking.

`apps/playground` exists from M1 onward, `apps/web` introduces the product experiences from M2 onward, and both use the shared authoritative `apps/server` through safe contracts. The Playground follows participant visibility rules and uses authorized, completion-gated Research endpoints when exercising hidden-information reveal.

The Range Visualizer and Equity / Poker Math Overlay remain in the roadmap and are exercised through the Playground before product presentation is implemented.

## M1 completion criteria

M1 is complete only when the minimal playable vertical slice includes all of the following:

- Full CashGame rules, atomic mutations, deterministic accepted-command replay, and participant-specific projections.
- Fastify with PostgreSQL/Drizzle persistence, local identity and Table Ownership, per-Table Session mutation queues, poker and session revisions, idempotency, and complete restoration.
- Safe HTTP/WebSocket contracts carrying complete participant views and participant-safe presentation events.
- The server-managed JobRunner boundary and one simple baseline Bot Strategy, with failures producing no implicit poker actions.
- A functional React Playground for choosing human and Bot seats, seating participants, explicitly starting Hands, submitting legal Fold/Check/Call/Bet/Raise actions, and between-Hand top-ups/rebuys.
- Tests covering betting and reopening edge cases, all-ins, main/side/split pots and payouts, chip conservation, participant and historical visibility, deterministic replay/restoration, and atomic rejection. Durable mutation tests cover commit-before-publish behavior, duplicate and stale requests, persistence failure, unknown-commit recovery, and restoration after restart.

Animations and polished product UX are not M1 completion requirements. The Playground remains available throughout M1-M5; new capabilities are exercised and validated there before their separate product UI and UX are planned and implemented.

## M2 dealing and burn presentation

The full Trainer must animate cards being dealt and cards being burned. Private cards are dealt without exposing opponents' hidden hole-card identities, and burn cards move face-down without revealing their identities. These animations use participant-safe presentation events and do not control engine progression or client state correctness. Skipping or losing an animation must still leave the client synchronized from its complete view.

## M5 Bot-vs-Bot simulation and benchmarking

Simulation supports games in which every participating controller is a Bot with an independently configured Strategy; a human does not need to play. An explicitly started simulation run automatically starts successive Hands, unlike normal Table Sessions where the next Hand always requires an explicit Start Hand operation.

Mass simulation supports configured runs of thousands or millions of Hands to compare long-term performance between Strategies under declared game and Strategy configurations. Bot-vs-Bot play and benchmark capabilities are exposed through the Playground and Research Lab. Correctness and reproducibility come first; this scope does not establish a minimum throughput target or require non-trivial performance optimization before the functionality works.
