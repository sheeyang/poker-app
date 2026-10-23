# Poker product context

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

The primary users are poker players studying their decisions on desktop and
mobile browsers. They play Texas Hold'em against Bots and examine numerical
outputs from a selected Reference Strategy. This audience and both device classes
were confirmed during M3 initialization; a specific skill level or need for
instruction in poker basics has not been established.

## Product Purpose

Let a human play no-limit Hold'em Cash Game Hands against strategy-controlled
Participants and study how their concrete decisions align with a chosen Reference
Strategy. The Trainer supplies numerical evidence for the player's interpretation
without prescribing an action or labeling a decision good or bad.

M3 delivered the main product interface in `apps/web` for capabilities established
through M1 and M2. Success means the player can configure and continue a Table
Session, play legal actions, understand confirmed table state, and inspect Strategy
outputs and alignment results on desktop and mobile. Analysis and presentation
must not delay gameplay or make its correctness depend on an animation.

## Positioning

Bot Playing Strategies and the human-selected Reference Strategy are independent.
Players can study a Reference Strategy's complete Policy distribution, concrete
sizings and selected action alongside their own accepted decision. A sampled
Reference action is distinct from the distribution and need not have its highest
probability.

Decision Score and Action Rank Score measure Policy alignment. They do not measure
EV, regret, accuracy, objective strategic quality or long-run frequency calibration.
The currently implemented baseline Strategies are testing controls and support no
claim of poker expertise or Solver quality.

## Operating Context

- Start practice from table-size and starting-stack presets; the explicit gesture
  creates the Table Session, seats the human and Bots and starts its first Hand.
  Custom rules and Bot Playing Strategies remain available through progressive
  disclosure. Reopen saved tables using observable stakes, stack and play state.
- Explicitly start each Hand. Submit the human's legal Fold, Check, Call, Bet-to or
  Raise-to action; the authoritative server runs Bot decisions.
- Observe cards, stacks, turn, bets, pots, showdown and payouts. Manage Participants
  and stacks between Hands, including sit out/return, seat changes, top-ups and
  rebuys when permitted by the configuration.
- Select a complete Reference Strategy independently of Bot assignments. Optional
  Live Analysis exposes its numerical outputs before the human acts; Live Analysis
  defaults to off. Every accepted human decision triggers nonblocking analysis.
- Review the visible Hand recap after completion, then choose a street-labeled
  decision to inspect its captured cards and numerical reference. Reviews stay
  within the current Hand and follow the newest accepted decision
  as play advances. Session summary captures a Table Session summary.
- Retain confirmed state through loading, failure, uncertain outcomes, reload and
  reconnect. Offer specific recovery actions and explicit Retry where supported.

The existing implementation runs locally with Fastify and PostgreSQL. A
server-issued browser identity establishes Table Ownership; browser storage only
remembers the selected session. The current setup is documented in
[README.md](README.md) and [local development](docs/local-development.md).
Desktop and mobile browser support is the M3 product target; remote access,
deployment and account requirements have not been established by this init.

## Capabilities and Constraints

### Product and engineering boundaries

`apps/web` is the product Trainer, with a table-first interface and a collapsible
analysis panel. It uses React/Vite, TanStack Router and Query, and Zustand in a
pnpm/TypeScript workspace. The browser consumes safe Contracts and shared client
transport from `packages/client`; it must not import the Poker Engine or
server-only Research implementations. Platform capabilities are validated through
automated tests and the relevant product interface. See
[ADR-0029](docs/adr/0029-retire-the-playground.md).
Use the terms in [GLOSSARY.md](GLOSSARY.md).

### Play, visibility and presentation

- Complete Observable Game Views synchronize the interface. Participant-safe
  presentation events support animations without becoming authoritative state.
- M3 includes card-dealing and face-down burn animations. Opponents' hidden cards
  and burn-card identities remain hidden. Skipped or missed animations must still
  leave the client synchronized, including after reconnect.
- Hidden seeds, authoritative game objects and privileged information remain
  server-side. Completed-Hand inspection requires Table Ownership, enabled Admin
  Mode and Hand completion, and does not expand ordinary Participant observations
  or Policy inputs.
- Legal Bet-to and Raise-to amounts are exact integer total commitments for the
  current betting street. The interface must respect server-provided legality and
  bounds, including all-ins and reopening rules.
- Analysis and feedback never gate acceptance of a legal human action. Every normal
  next Hand still requires an explicit Start Hand operation.

### Trainer analysis

- Preserve [ADR-0008's presentation contract](docs/adr/0008-derive-trainer-scoring-from-policy.md):
  an always-expanded action tree with aggregated action probabilities and exact
  Bet/Raise sizing children showing unconditional Choice probabilities. Show the
  Policy distribution alongside the Action Selector's selected concrete action.
- Display probabilities as `0.00–1.00` and scores as `/100`, with Decision Score
  primary and Action Rank Score secondary. The frontend presents server-computed
  results rather than implementing another scoring formula.
- Hand and Table Session summaries freeze a decision set and one complete
  Reference Strategy. Show complete averages only after all required analyses
  succeed. Pending and failed results never become zero or a partial average;
  failure takes precedence over pending. No human decisions means no score.
- Keep results associated with the decision and Reference Strategy that produced
  them as play advances or preferences change. Explicit failed-only Retry preserves
  the original inputs and seeds; changing the reference creates a different request.
- HTTP supplies numerical results and summaries. The shared browser WebSocket
  supplies authorized table updates and analysis notifications; initial readiness
  and reconnect reconcile relevant state without normal-operation polling.

### Milestone scope

M3 is complete as of 24 October 2026. It delivered the full Trainer interface,
feedback timing, loading/error/retry states and basic dealing/burn presentation.
[ADR-0028](docs/adr/0028-introduce-the-product-trainer-interface.md) records the
product interaction and authority decisions; [ADR-0029](docs/adr/0029-retire-the-playground.md)
records retirement of the Playground.

The [current eight-milestone plan](docs/milestones.md) makes M4 — Shared gameplay
foundation the current focus. Elaborate animations belong to M5. General history
navigation, action-by-action replay, counterfactual comparison, Range Visualizer,
Equity / Poker Math Overlay and overall-history summaries belong to M6. Solver
work belongs to M7; mass simulation and benchmarking belong to M8. Older ADR
milestone numbers retain their historical meaning; use the current plan for
delivery order.

## Evidence on Hand

- [Current milestone plan](docs/milestones.md): M3 scope and subsequent milestones.
- [M2 specification](docs/specs/m2-numerical-trainer-analysis.md): existing Trainer
  behavior and the boundaries of product presentation work.
- [ADR-0006](docs/adr/0006-treat-analysis-as-derived-data.md),
  [ADR-0008](docs/adr/0008-derive-trainer-scoring-from-policy.md) and
  [ADR-0026](docs/adr/0026-retain-numerical-trainer-analysis-independently-of-gameplay.md):
  derived analysis, numerical meaning, presentation requirements and summaries.
- [ADR-0017](docs/adr/0017-bind-observability-with-participant-cash-game.md): safe views and events.
- [Trainer code](apps/web/src/main.tsx), shared client, and server/contracts:
  implemented behavior and testable data.
- The M3 init confirms the audience and desktop/mobile use. No primary user
  research, usability findings, market claims or product brand assets were
  established in this init.

## Product Principles

1. Preserve player agency: present numerical Strategy evidence without advice or
   evaluative judgments.
2. Keep play authoritative and continuous: confirmed server state governs the
   table, independently of animation and analysis completion.
3. Make analysis interpretable: distinguish probabilities, selected actions,
   scores, references and incomplete results.
4. Protect information boundaries in every state, including animation, recovery
   and completed-Hand inspection.
5. Support the complete play-and-study workflow on desktop and mobile.

## Open Decisions

The user selected the classic poker-room direction for M3: green oval felt, dark
rail and shell, ivory cards and familiar betting controls. The table leads;
analysis opens beside it on desktop and below play on mobile. Visual details were
delegated to the implementer. Accepted-decision results update without interrupting
play; completed Hands request a Hand summary, and **Session summary** explicitly
captures a session summary without removing the continuing table. See ADR-0028.

- Final product name, voice and binding brand assets or commitments.
- Depth of terminology help and onboarding for the intended poker-player audience.
- Specific accessibility requirements or conformance targets beyond the existing
  requirement that optional presentation must not govern gameplay correctness.
