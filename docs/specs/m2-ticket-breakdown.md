# M2 ticket breakdown

Source: [M2 — Numerical Trainer analysis](m2-numerical-trainer-analysis.md), the accepted M2 conversation through Q18, the current six-milestone plan, and ADR-0006, ADR-0008, ADR-0017, ADR-0018, ADR-0019, and ADR-0026.

Status: approved on 20 October 2026 and published as GitHub issues #17–#25, all labelled ready-for-agent, with all ten native blocking relationships verified. The source is a local spec rather than a published parent issue; no parent issue was created, modified, or closed.

Each ticket is a complete, independently verifiable behavior through the existing server and Playground, with schema changes where persistence is needed and its own tests. Existing workloads demonstrate scheduling; existing live tables demonstrate shared connections. These are usable slices rather than separate scaffolding tasks. No standalone mechanical prefactor is required: the current runner, mutation path, connection modules, server construction, and controlled Strategy/transport fixtures supply the necessary seams. Extend them within each delivered behavior.

## Implementation tickets

1. **Prioritize Bot play and inspection on the shared JobRunner** — [#17](https://github.com/sheeyang/poker-app/issues/17)
   - **Blocked by:** None (can start immediately).
   - **What it delivers:** Existing Bot play and completed-Hand inspection share fixed numeric priorities, bounded admission, and FIFO within each priority, demonstrated through their current Playground/API workflows.
   - [Full issue draft](../../.scratch/m2-tickets/issues/01-prioritize-shared-computation.md)

2. **Keep live tables on one shared browser connection** — [#18](https://github.com/sheeyang/poker-app/issues/18)
   - **Blocked by:** None (can start immediately).
   - **What it delivers:** One authenticated socket per tab supports authorized table subscriptions, user-channel readiness, cleanup, and reconnect without replacing the socket when tables change.
   - [Full issue draft](../../.scratch/m2-tickets/issues/02-share-browser-live-connection.md)

3. **Persist Table Session analysis preferences** — [#19](https://github.com/sheeyang/poker-app/issues/19)
   - **Blocked by:** None (can start immediately).
   - **What it delivers:** Choose and restore the Reference Strategy and Live Analysis setting through durable owner-only configuration, synchronized across tabs independently of Bot Playing Strategies.
   - [Full issue draft](../../.scratch/m2-tickets/issues/03-persist-analysis-preferences.md)

4. **Inspect and cache Reference Strategy Evaluations** — [#20](https://github.com/sheeyang/poker-app/issues/20)
   - **Blocked by:** [#17](https://github.com/sheeyang/poker-app/issues/17), [#18](https://github.com/sheeyang/poker-app/issues/18), and [#19](https://github.com/sheeyang/poker-app/issues/19).
   - **What it delivers:** Explicitly get or start a current-decision evaluation, reuse persistent successes or active matching jobs, return failures without restarting, and refresh numerical HTTP results from authorized notifications without polling.
   - [Full issue draft](../../.scratch/m2-tickets/issues/04-inspect-reference-evaluations.md)

5. **Retry failed analysis without replacing newer attempts** — [#21](https://github.com/sheeyang/poker-app/issues/21)
   - **Blocked by:** [#20](https://github.com/sheeyang/poker-app/issues/20).
   - **What it delivers:** Retry only failed analysis with frozen inputs/seeds, reuse active/successful work, and prevent delayed attempts or responses from overwriting current state.
   - [Full issue draft](../../.scratch/m2-tickets/issues/05-retry-failed-analysis.md)

6. **Score current and historical accepted human decisions** — [#22](https://github.com/sheeyang/poker-app/issues/22)
   - **Blocked by:** [#20](https://github.com/sheeyang/poker-app/issues/20).
   - **What it delivers:** Fetch reproducible Decision Score and Action Rank Score for accepted decisions, reuse pre-action evaluations, and analyze authorized historical decisions without a live table subscription.
   - [Full issue draft](../../.scratch/m2-tickets/issues/06-score-accepted-decisions.md)

7. **Run Live Analysis and automatic post-action analysis** — [#23](https://github.com/sheeyang/poker-app/issues/23)
   - **Blocked by:** [#21](https://github.com/sheeyang/poker-app/issues/21) and [#22](https://github.com/sheeyang/poker-app/issues/22).
   - **What it delivers:** The persisted toggle drives optional current-decision evaluation; every accepted human action requests scored analysis at priority 2 without delaying gameplay, with matching work reused at its fixed priority.
   - [Full issue draft](../../.scratch/m2-tickets/issues/07-run-live-and-post-action-analysis.md)

8. **Request complete Hand Score Summaries** — [#24](https://github.com/sheeyang/poker-app/issues/24)
   - **Blocked by:** [#21](https://github.com/sheeyang/poker-app/issues/21) and [#22](https://github.com/sheeyang/poker-app/issues/22).
   - **What it delivers:** Explicitly request both Hand averages over frozen decisions and one reference, with globally bounded missing-work batches, complete-only results, pending/error/empty states, Retry, and user-channel notifications.
   - [Full issue draft](../../.scratch/m2-tickets/issues/08-hand-score-summaries.md)

9. **Request complete Table Session Score Summaries** — [#25](https://github.com/sheeyang/poker-app/issues/25)
   - **Blocked by:** [#24](https://github.com/sheeyang/poker-app/issues/24).
   - **What it delivers:** Extend the shared summary behavior across Hands, calculating decision-weighted means and sharing global submission bounds with Hand summaries, without requiring a session-ending lifecycle.
   - [Full issue draft](../../.scratch/m2-tickets/issues/09-table-session-score-summaries.md)

## Dependency rationale

- Tickets 1, 2, and 3 are the initial frontier. Scheduling uses existing Bot/inspection workflows; connections use existing table views; settings use existing durable configuration/publication mechanisms. File overlap is not a blocking edge. Ticket 3 can use M1 table synchronization until the shared connection lands, and ticket 2 carries committed table payloads without requiring new Trainer settings.
- Ticket 4 requires numeric purpose scheduling (1), independent authorized notification delivery/readiness (2), and the selected durable Reference Strategy (3). It delivers one explicit pre-action evaluation before automatic triggers, scores, or summaries are added.
- Tickets 5 and 6 can proceed independently after ticket 4: explicit failed-evaluation Retry and accepted-decision scoring are separate usable behaviors. Ticket 6 needs frozen evaluation inputs/cache/notification state, not a Retry control, and ticket 5 needs a failed evaluation, not accepted-decision scoring.
- Automatic triggers (7) and requested summaries (8) join those two paths, including failed scored-work Retry that reuses successful evaluations. Their acceptance explicitly exercises this composition. A summary must also work over decisions whose analysis was never automatically requested, so ticket 7 does not gate it.
- Ticket 9 reuses ticket 8's frozen-summary state, dependency Retry, notification handling, means, and global batching across a wider decision set. Automatic analysis (7) is not a prerequisite for either summary scope.
- These are direct blocking edges; transitive prerequisites need not be repeated on every ticket. Work any ticket whose blockers have all completed. No expand–contract refactor or shared integration branch is necessary for this scoped change.

## Shared acceptance and testing

- Preserve M1 authorization, durable definitive mutation outcomes, poker semantics, participant visibility, selected-action Bot provenance, and explicit Hand starts. Analysis cache/status/notifications add no poker commands or revision increments; committed settings still use session revisions.
- Use the existing HTTP/WebSocket boundary with real PostgreSQL as the primary behavioral seam. Reuse controlled Strategies, bounded runner options, fault injection, restart patterns, and the real browser transport fixture. Focused Research public-function tests cover independent numerical expectations; browser checks cover socket lifetime and refresh races that server tests cannot prove. Do not add test-only orchestration interfaces or assert private queue/cache layouts.
- Each slice carries its own checks and Playground demonstration. Keep typecheck, tests, build, and package-boundary validation green as slices land; no separate testing/hardening ticket defers core correctness to the end.
- HTTP carries get-or-start, Retry, results, and averages; user-channel WebSocket messages notify completion/failure with Table Session/request/attempt identity after state is readable. Initial readiness, reconnect, and relevant notifications reconcile through HTTP without polling.
- Persist successful derived results and reproducibility metadata; jobs/failures may be transient. There is no durable analysis obligation, guaranteed background completion, recovery sweep, promotion, preemption, reserved Bot capacity, or starvation-prevention rule.
- Deliver numerical baseline Strategy behavior through the Playground without advice or good/bad judgments. M3 owns product presentation and request timing; M4 owns overall-history summaries and general replay/comparison tools. No stronger Strategies, Bot distribution retention, or human-action reference assignments are added.

## Coverage

Every numbered User Story in the source spec is assigned below; shared invariants are also exercised by dependent slices.

| Source User Stories | Owning tickets |
| --- | --- |
| 1–7 | 3: complete reference selection, defaults, durable/shared settings |
| 8 | 7: automatic optional Live Analysis |
| 9, 11–12 | 4: concrete numerical evaluation and selected action; neutral language is shared acceptance |
| 10, 17–21 | 6: action aggregation and concrete/rank scoring |
| 13–16 | 7: nonblocking automatic analysis, acceptance, and deduplication |
| 22 | 6 and 7: pre-action evaluation reuse after acceptance |
| 23–25, 28–31 | 4: deduplication, cache/failure behavior, immutable requests, metadata, and restart |
| 26–27 | 5: failed-only Retry with frozen inputs/seeds |
| 32–33 | 6: participant-safe historical targets with no live subscription |
| 34, 36–41 | 8: complete Hand summaries and shared frozen-summary behavior |
| 35, 42 | 9: Table Session summaries across individual decisions |
| 43–45 | 2: shared connection and authorized live subscriptions |
| 46–52 | 4–6, 8–9: user notifications, readiness recovery, HTTP reconciliation, and obsolete attempt/response rejection |
| 53 | 1: bounded purpose-based numeric dispatch |
| 54–55 | 4, 7–8: explicit admission errors and fixed-priority matching reuse |
| 56 | All tickets: engineering Playground behaviors, controls, and verification |
| 57 | 4–8: derived failures leave poker/revisions unchanged |
| 58 | 6–7: existing Bot provenance without Policy distribution retention |

M2 completes only when all nine slices satisfy their acceptance criteria and the combined Playground flow exercises persisted preferences, optional live evaluation, automatic accepted-decision scoring, explicit Retry, historical HTTP analysis without a live table subscription, reconnect/restart matching reuse, and complete Hand/Table Session averages.

## Publication

The user approved the nine-ticket granularity and blocking edges on 20 October 2026. All nine issues were published in dependency order with the ready-for-agent label, actual blocking issue references in their bodies, and ten native GitHub blocking relationships. Readback verified each title, complete approved body, open state, label, and exact native blocker set.

The initial unblocked frontier is [#17](https://github.com/sheeyang/poker-app/issues/17), [#18](https://github.com/sheeyang/poker-app/issues/18), and [#19](https://github.com/sheeyang/poker-app/issues/19). The local draft numbers and dependency rationale above refer to M2-01 through M2-09; GitHub issue numbers are linked beside each title. GitHub is the configured tracker, and the local files retain the approved drafting context. Publication does not begin implementation.
