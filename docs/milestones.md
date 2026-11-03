**Current interface:** The Playground was retired by [ADR-0029](adr/0029-retire-the-playground.md). M1 and M2 below retain their historical delivery descriptions. Later capabilities are validated through automated tests and their product interfaces.

**M3 status:** Complete as of 24 October 2026, accepted by the user. See [delivery and verification evidence](specs/m3-ui-implementation.md#completion--24-october-2026).

**Current focus:** M4 — Shared gameplay foundation. Open the hosted product to the public with Practice Tables and Online Tables, and prove shared gameplay with two Guests on separate devices before adding elaborate animations. The current roadmap has nine milestones; accounts, lobbies, and matchmaking remain unscheduled.

| Milestone | Summary of work | ADRs introduced here (each listed once) |
| --- | --- | --- |
| **M1 — Playable engine, server, and Playground** | Deliver the complete no-limit Hold'em CashGame with atomic mutations, participant-safe views, deterministic accepted-command replay, and restoration. Establish package and Strategy boundaries, independent seeded randomness, a baseline Bot Strategy, and the server-managed JobRunner. Run the authoritative Fastify server with PostgreSQL/Drizzle persistence, local identity and Table Ownership, mutation queues, revisions, idempotency, commit recovery, and Bot provenance. Provide a functional Playground for seating, explicit Hand starts, legal actions, top-ups/rebuys, and authorized completed-Hand inspection. Verify rules, conservation, visibility, replay, and durable mutation behavior. | [0001 — Package boundaries](adr/0001-separate-engine-and-strategies.md)<br>[0005 — Adaptation from observable history](adr/0005-derive-adaptation-from-observable-history.md)<br>[0009 — Policy and Action Selector](adr/0009-separate-policy-from-action-selection.md)<br>[0011 — Hold'em-specific CashGame](adr/0011-use-a-holdem-specific-cash-game.md)<br>[0012 — Atomic mutations](adr/0012-use-atomic-mutable-cash-game-operations.md)<br>[0013 — Authoritative server](adr/0013-use-an-authoritative-server-from-m1.md)<br>[0014 — Pre-release record compatibility](adr/0014-allow-pre-release-record-breaking-changes.md)<br>[0015 — Seed and accepted-command records](adr/0015-persist-seed-and-accepted-commands.md)<br>[0016 — Semantic and durable authority](adr/0016-separate-semantic-and-durable-authority.md)<br>[0017 — Participant Cash Game](adr/0017-bind-observability-with-participant-cash-game.md)<br>[0018 — Backend aggregate](adr/0018-wrap-poker-records-in-a-backend-aggregate.md)<br>[0019 — JobRunner boundary](adr/0019-route-computation-through-one-job-runner.md)<br>[0020 — Definitive mutation outcomes](adr/0020-remember-definitive-mutation-outcomes.md)<br>[0021 — Authoritative facts and information boundaries](adr/0021-expose-authoritative-facts-through-cash-game.md)<br>[0022 — Enduring Playground](adr/0022-maintain-an-independent-playground.md)<br>[0025 — Standard cash-game rules](adr/0025-document-standard-cash-game-rules.md)<br><br>The Playground ADR's existing milestone numbering predates this roadmap; see the earlier-reference mapping below. Later milestones retain these decisions and document only their additions in extension ADRs. |
| **M2 — Trainer** | Prove the numerical analysis pipeline through the Playground using existing baseline Strategies; stronger Strategies remain separate scope. Persist the Reference Strategy and Live Analysis setting per Table Session, defaulting to Uniform Choice with Probability Selector and Live Analysis off. Automatically request analysis after accepted human decisions without delaying gameplay. Each request captures the selected Reference Strategy; human actions store no assignment. Cache Reference Strategy Evaluations separately from scores, retaining successful results and reproducibility metadata apart from poker records; keep existing Bot provenance without Playing Policy distributions. Use HTTP for get-or-start, explicit failed-only Retry, results, and summary averages. Open one shared WebSocket per browser tab with authorized table subscriptions and user-scoped analysis notifications; refresh relevant state over HTTP after notifications and initial/reconnect readiness, without polling or durable job obligations. Include backend Hand and Table Session arithmetic means of both scores over frozen decision sets and one fixed Reference Strategy; return complete averages only when all required analyses succeed, otherwise pending/error. Extend the bounded JobRunner with fixed numeric priorities, FIFO within each priority, deduplication, and small globally bounded summary batches. M3 owns product presentation, summary request timing, and feedback; results carry no advice or good/bad judgments. | [0006 — Derived analysis, caching, and score summaries](adr/0006-treat-analysis-as-derived-data.md)<br>[0008 — Policy-derived Trainer scoring](adr/0008-derive-trainer-scoring-from-policy.md)<br>[0026 — Numerical Trainer analysis independent of gameplay](adr/0026-retain-numerical-trainer-analysis-independently-of-gameplay.md)<br><br>The selected action follows the configured ActionSelector; a sampled choice need not be the highest-probability action. |
| **M3 — Main product UI and UX** | **Complete — 24 October 2026.** Deliver the main product interface in `apps/web` for the capabilities delivered so far, including the full Trainer experience, presentation of numerical Strategy outputs and post-action alignment results, and loading/error/retry states. Preserve the human's interpretation of numerical results without advice or good/bad judgments. Retain the existing basic card-dealing and face-down burn motion; complete views keep the client synchronized when motion is skipped or missed. Elaborate animations move to M5. Extend the product UI as later capabilities are validated through automated tests and their product interfaces. | [0028 — Product Trainer interface](adr/0028-introduce-the-product-trainer-interface.md)<br>[0029 — Retire the Playground](adr/0029-retire-the-playground.md) |
| **M4 — Shared gameplay foundation** | Open the hosted product to the public with two table modes fixed at creation. Practice Tables keep one human against Bots with explicit dealing and an optional Action Time Limit. Online Tables let Guests join through a Join Link, choose Seats, and play humans and Bots under an Action Time Limit with Automatic Dealing. Add server-owned Presentation Phases at every table, Action Windows and Action Deadlines, and Timeout Actions. Add durable scheduling and restart recovery, reconnect and sit-out handling, owner and self-service permissions, and public-hosting safeguards. Keep Live Analysis and scoring per Participant, with participant-specific authorization and original-decision visibility, and add a Session summary tab. Use simple visuals while proving the lifecycle; see the detailed requirements below. | [0032 — Shared online play](adr/0032-extend-table-sessions-for-shared-online-play.md)<br><br>Revises ADR-0018, ADR-0025, ADR-0026, and ADR-0028 while preserving ADR-0012's atomic engine operations and ADR-0017's participant-safe projection boundaries. |
| **M5 — Animations** | Add card, chip, reveal, and payout animations following M4's shared phases and server timestamps. All-in runouts follow the server's schedule of hole-card reveals, remaining board streets, payout, and the inter-hand pause. Clients can skip motion or catch up after missed phases while remaining synchronized from complete views and the current schedule. Reduced motion and animation preferences affect presentation only; animation completion never starts or delays turns, deadlines, or dealing. | Add an animation extension ADR building on M4's shared phase contract and the existing participant-safe presentation boundaries. |
| **M6 — Replay, Analysis, and Research** | Deliver completed-Hand history, action-by-action replay with the information visible at each original decision, and reanalysis using the currently selected Reference Strategy and matching cached results. Add counterfactual Strategy comparison against the same frozen participant-safe inputs, deeper historical investigation and overall-history score summaries extending M2's backend Hand and Table Session summaries, and authorized completed-Hand Research tools. Deliver the Range Visualizer and Equity / Poker Math Overlay, retaining declared assumptions, computation methods, and uncertainty. Validate new capabilities through automated tests and their product experiences. | [0023 — Range Visualizer](adr/0023-visualize-policy-across-hypothetical-holdings.md)<br>[0024 — Equity assumptions and computation](adr/0024-declare-equity-assumptions-and-computation.md)<br><br>Add a replay/history/counterfactual extension ADR that defines the additional capabilities built on the established authoritative-facts and derived-analysis decisions. |
| **M7 — Solver** | Introduce the language-neutral Solver boundary and the first concrete Solver, reusing CashGame's Hold'em rules. When playable hypothetical scenarios are needed, add validated isolated scenario construction from observable facts, declared hypothetical holdings/ranges, and explicit modeling randomness. Retain model assumptions, abstractions, algorithm/configuration, computation, seeds, and available solution-quality evidence with Solver-Derived Strategies. Validate through automated tests and product integration. | [0004 — Language-neutral Solver boundary](adr/0004-use-a-language-neutral-solver-boundary.md)<br><br>A possible shared Hold'em transition-kernel extraction remains deferred; it is not an M7 completion requirement. |
| **M8 — Mass simulation and benchmarking** | Support Bot-vs-Bot runs with independently configured Strategies and automatic successive Hand starts during an explicitly started simulation run. Run thousands or millions of Hands for reproducible Strategy comparisons under declared game and Strategy configurations, reusing CashGame and JobRunner. Expose simulation and benchmarking through the Research Lab. Prioritize correctness and reproducibility without introducing a minimum throughput target. | No dedicated ADR yet. Add a simulation/benchmarking extension ADR defining the additional run orchestration, provenance, and comparison behavior built on the established engine, Strategy, and JobRunner decisions. |
| **M9 — Release preparation** | Resolve the robustness and safety work deferred until before a public release. Handle Action Deadlines and Next-Hand Countdowns that expire during a server outage fairly, including reconnect time after restart. Add backups and restore for Table Sessions, revisiting ADR-0031's non-durable hosting. Add Guest name moderation and cleanup of idle tables, and make Removal survive cleared browser storage. Accounts and login, including control from more than one device, remain unscheduled. | No dedicated ADR yet. Add release-preparation ADRs where durability or identity decisions change ADR-0031 or ADR-0032. |
| **Superseded (reference only)** | Retain these ADRs as historical context, not implementation requirements. Command/event records were replaced by seed-and-command records; explicit Strategy memory by observable-history adaptation; separate decision evaluation by Policy-derived scoring; and the earlier engine visibility boundary by the authoritative-facts decision. | [0002 — Command/event transitions; superseded by 0015](adr/0002-record-hands-as-command-event-transitions.md)<br>[0003 — Strategy memory; superseded by 0005](adr/0003-explicit-snapshotable-strategy-memory.md)<br>[0007 — Separate decision evaluation; superseded by 0008](adr/0007-separate-playing-policy-from-decision-evaluation.md)<br>[0010 — Engine visibility; superseded by 0021](adr/0010-enforce-visibility-in-the-engine.md) |

## M4 — Shared gameplay foundation

M4 opens the hosted product to the public and establishes the shared lifecycle before elaborate animation work. The server is the source of truth for poker state and time. Animations represent game events; their completion never determines whether an action is valid. [ADR-0032](adr/0032-extend-table-sessions-for-shared-online-play.md) records the decisions. ADR-0012's atomic engine operations and ADR-0017's participant-safe projection and historical visibility boundaries remain requirements, and terms follow the [glossary](../GLOSSARY.md). The requirements below define the planned M4 delivery.

### Table modes

- Every Table Session is created as a Practice Table or an Online Table. Its mode never changes and is never inferred from how many humans are seated.
- A Practice Table seats one human against Bots only and has no Join Link. Each Hand starts by explicit Deal, accepted as soon as the payout phase ends. Its Action Time Limit is optional and off by default. Under progressive disclosure it offers the same lengths as Online Tables.
- An Online Table has 2–9 Seats and may mix humans and Bots. It always uses Automatic Dealing and always has an Action Time Limit of 15, 30, or 60 seconds, defaulting to 30. Allow Live Analysis and seat changes default to on under progressive disclosure.

### Guests, joining, and seating

- Anyone may create a table. A Guest enters a display name of 1–20 characters before first creating or joining a table. The name prefills later joins and can be edited for future joins.
- Each Online Table has one unguessable Join Link, distinct from its Table Session ID, which its Table Owner can copy or replace. Replacing it invalidates the previous link without removing joined Participants.
- Joining makes the Guest an unseated Participant who sees public table information. That includes every Action Window, the Next-Hand Countdown, and each Participant's connection and sitting-out status.
  - Their Observable Session History begins when they join.
  - Names are fixed when the Guest joins and are unique within the table, ignoring case.
  - An Online Table admits at most 20 Participants, Bots included, and shows a clear message when full. Leave Table frees a place; the Table Owner's place is held while they are away.
- A returning Guest keeps the same Participant. Control from more than one device waits for accounts.
- A Participant may take an empty Seat at any time, including during a Hand, with a buy-in within the table limits. They are dealt in from the next Hand. At either table mode, owners may likewise add Bots at any time. No missed-blind obligation applies.
- For their own Participant, a human may:
  - change Seat between Hands when seat changes are allowed;
  - sit out or resume;
  - top up or rebuy between Hands;
  - Stand Up or Leave Table.

  Sitting out and Leave Table requested during a Hand apply after it. At an Online Table, Timeout Actions cover any remaining decisions.
- At an Online Table, the Table Owner may:
  - change the Action Time Limit length, Allow Live Analysis, and seat-change permission between Hands;
  - manage Bots, including Playing Strategies and stacks;
  - replace the Join Link;
  - remove a human. Removal takes effect after any current Hand and prevents that Guest from joining again.

  The owner never acts for, manages, or sees private information of another human. Admin Mode is never available at an Online Table. Ownership never transfers, and the table continues if the owner leaves.
- The saved-tables list shows owned Practice Tables and Online Tables the Guest has joined and not left, labeled by mode. Owned tables stay listed.
- Chips are free play money within the buy-in limits. Never rebuy automatically.
- Public hosting adds these safeguards:
  - per-IP rate limits on table creation, joining, and Join Link replacement;
  - at most 10 tables with seated humans per Guest;
  - limits on name length and characters.

### Server scheduling and presentation contracts

- The server owns Presentation Phase durations: deal 1.5 s, street reveal 1 s, showdown reveal 2 s, and payout 2 s. Under Automatic Dealing there is also a 3 s pause between Hands. Each schedule entry retains the duration it used.
- Shared Contracts define the Presentation Phases and their timestamps, applicable street identifiers, Action Window start and Action Deadline, and Next-Hand Countdown start time. Complete views carry the current schedule.
- An Action Window opens only after any preceding Presentation Phase. Clients cannot open or extend one by finishing an animation.
- Under an Action Time Limit, a human's Action Deadline is exact: actions arriving after it are rejected. Clients estimate the server clock and disable action controls at the deadline. Bots have no Action Deadline.
- When a human's Action Deadline passes, the server submits the Timeout Action: Check when legal, otherwise Fold.
- Preserve atomic CashGame operations. Schedules describe the transitions returned by those operations; Presentation Phases are not poker commands.
- During normal betting, future streets, unrevealed opponent cards, burn identities, and deck order remain inaccessible through participant-facing responses. Once no betting decisions remain, the complete participant-safe resolved result may arrive before its presentation finishes.
- For an all-in runout, build the schedule from the remaining transitions. These are the hole-card reveals, the remaining board streets in order, payout, and, when Automatic Dealing applies, the pause between Hands. The M4 client reveals each step at its timestamp, without motion.
- Complete views remain the synchronization authority. Reconnect restores the latest authoritative view and current schedule; clients skip elapsed phases without replaying missed events. Skipped animations, reduced motion, slow clients, and analysis completion never alter Action Deadlines or Hand starts.
- Persist active deadlines and schedules for restart recovery. An Action Deadline that expired during an outage resolves as a Timeout Action exactly once before further actions are accepted. Recovery and repeated delivery never duplicate Timeout Actions, payouts, or Hand starts. Fairer outage handling belongs to M9.

### Eligibility, disconnects, and successive Hands

- An Eligible Participant is seated with chips and is not Sitting Out. At an Online Table, they must also be either a Bot or a human with at least one authorized live connection.
- At a Practice Table, a missed Action Deadline submits the Timeout Action, and later missed decisions in that Hand also time out. The human is not sat out, and the table waits for Deal. Deal resumes a human who sat out by choice.
- At an Online Table, a human who disconnects during a Hand stays in it, and their Action Deadline continues.
  - A Timeout Action sits the human out after the current Hand.
  - When the Next-Hand Countdown expires, eligibility is rechecked, and a human who is still disconnected is sat out.
  - A human who was sat out must resume explicitly. Reconnecting before then continues normally.
- When the Next-Hand Countdown expires, Automatic Dealing starts the next Hand if at least two Eligible Participants remain and at least one of them is human. Otherwise, cancel the countdown and wait. When the condition holds again, announce a fresh countdown. Animation completion never triggers or delays dealing.
- Always settle payouts and preserve remaining chips.
- Practice Tables keep ADR-0018's Bot-failure policy. At an Online Table, a failed Bot decision is retried once with the same inputs. If the retry also fails, the server submits the Timeout Action for the Bot, sits it out after the Hand, and shows the failure to everyone at the table.

### Live Analysis, scoring, and summaries

- In both table modes, each Participant has their own Reference Strategy, Live Analysis setting, Analysis Results, scores, and summaries. Only that Participant's Human Controller may capture, read, or retry them, or receive their notifications.
- Allow Live Analysis is an Online Table option, visible to everyone at the table and on by default. Disallowing it takes effect from the next decision; post-action analysis and scoring continue.
- Supply analysis only with participant-visible information from `ParticipantCashGame.getView()`. Scoring uses the historical snapshot at the original decision from `getView({ at: { decisionId } })`, together with the accepted action. Later streets, showdown reveals, and subsequent Hands must not contaminate those inputs.
- Analysis responses must not expose unrevealed opponent cards, future cards, hidden deck data, or another Participant's analysis.
- Analysis remains nonblocking: neither its computation nor feedback delays actions, Action Deadlines, or dealing.
- Score Timeout Actions as the human's own decisions for Decision Scores, Action Rank Scores, and Score Summaries. No separate action-origin tracking is required.
- The analysis panel gains a Session summary tab at both table modes, replacing the explicit end-of-session action.
  - It covers the viewer's decisions in completed Hands against their current Reference Strategy.
  - It requests a fresh summary when opened, and after each completed Hand while it remains open.

  The automatic Hand summary is unchanged.

### Completion evidence

Demonstrate successive Hands at an Online Table with simple visuals and the existing UI. Two humans join through its Join Link as Guests, on separate devices over the internet.

The demonstration verifies:
- Presentation Phase and Action Window timing;
- all-in schedules;
- Automatic Dealing with eligibility rechecks;
- disconnect/reconnect and sit-out/resume behavior;
- chip preservation;
- restart recovery without duplicate actions or deals.

Automated checks must also cover:
- both table modes;
- Guest joining and seating;
- owner and self-service permissions, including Removal;
- mid-Hand seating;
- Online Bot failure;
- independently authorized actions and analysis;
- historical snapshot visibility;
- timeout scoring;
- the Session summary tab;
- clients that skip or miss Presentation Phases.

## Earlier milestone references

Historical delivery specs and implementation evidence retain the milestone numbers used when they were written. This roadmap defines the current delivery order:

| Previous six-milestone roadmap | Current roadmap |
| --- | --- |
| M3 — Main product UI and UX with animations | M3 — Main product UI and UX; elaborate animations move to M5 |
| M4 — Replay, Analysis, and Research | M6 — Replay, Analysis, and Research |
| M5 — Solver | M7 — Solver |
| M6 — Mass simulation and benchmarking | M8 — Mass simulation and benchmarking |

Older five-milestone references, including those in the superseded Playground decision, also predate this plan. Use the milestone names and current roadmap when interpreting them.
