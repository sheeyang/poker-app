# M2 final review repairs

The final Standards and Spec reviews of integration `5fe9f980e265d435501de1cc3523b6da93192b9c` identified three actionable findings. Repair source is committed as `9f95b3dfe856862b517ace24f7a9c4d1b2d9a06b` on `codex/m2-review-repairs`. Independent read-only rechecks of that immutable source cleared both original Standards findings and the original Spec finding, with no new findings on either axis.

## Result acceptance through the Table Session queue (P2)

ADR-0019 requires table-scoped job results to re-enter the existing Table Session queue before orchestration uses them. Reference evaluations, decision scores, propagated dependency failures, immediate capacity failures, summary reductions and aggregate results now use that boundary. The queue checks the committed owner and the frozen request's current execution attempt. Historical results remain valid when live poker revisions, seating or the selected Reference Strategy have changed.

The boundary accepts a synchronous callback. Successful derived evaluation/score persistence happens outside the mutation queue, between result validation and a second attempt check that publishes the readable terminal state. Human acceptance never waits for pending Strategy work or an admitted computation. Known failures still appear in the initial HTTP response, including immediate capacity failures. Shutdown and superseded-attempt guards remain in place. Notifications follow readable terminal state.

Two real HTTP/WebSocket regressions held an actual human mutation transaction at its pre-COMMIT boundary, then completed or failed an earlier evaluation. On the unchanged integration baseline, both evaluations became terminal while the mutation still owned the queue. After the repair, repeated HTTP reads remained pending and no terminal notification appeared until the mutation was released; each frozen historical request then reached its expected terminal state despite the advanced poker revision.

An additional real PostgreSQL lock test blocked derived evaluation insertion. Human Fold still committed and returned through HTTP while analysis remained pending. Releasing the derived-write lock allowed the original historical result to complete. The database lock is external fault control; behavior is asserted through HTTP.

## Shared Strategy execution contract (P3)

The repeated compatibility, evaluation, PolicyResult validation, seeded selection and selected-Choice membership checks now live in one small server helper. It returns the validated PolicyResult and selected ConcreteAction. Bot and analysis owners retain their scheduling purposes, result acceptance and persistence. Existing `incompatible`, `invalid-policy`, `selection-failed` and generic failure behavior is preserved, with unchanged evaluation and selection seeds. Bots continue to retain only the selected action/provenance; analysis continues to omit private Policy diagnostics. Existing public Bot/analysis/Strategy tests cover these semantics without new helper-level tests or duplicate validation cases.

## Failure precedence beyond bounded summary admission (P2)

The analysis module now owns an admission-free matching lookup using the same complete identities as get-or-start and Retry. New summaries inspect every frozen member and passively observe matching active work, independently of the global missing-work budget. Existing failed members immediately make the summary an error with no averages. Later failures in already-active matching members are also observed while two missing members remain held. Inspection does not submit, promote or retry jobs.

Only missing evaluation/scoring stages enter the existing globally bounded coordinator. Existing evaluation success still requires bounded admission of a missing score. Failed-only Retry and per-attempt physical settlement remain shared, so a new execution identity cannot release an older still-running physical attempt. New explicit snapshots can still recover an earlier lookup failure that created no analysis state.

Both new real HTTP regressions reproduced product red on the unchanged integration baseline: a third member already failed before snapshot creation, and a third matching member failed after snapshot creation while two summary-started members remained held. Each baseline summary incorrectly stayed pending. Both now become error without averages, additional evaluations or a changed existing attempt ID.

## Verification

Approved seams remain real HTTP/WebSocket/PostgreSQL, Research's public numerical functions and real browser transport.

- Affected Bot, evaluation, scoring, Hand summary and Table Session summary tests: **64 passed in 5 files**, 74.85 seconds.
- Full serial real-PostgreSQL suite: **327 tests in 39 files passed**, exit 0, **190.30 seconds** (`node node_modules/vitest/vitest.mjs run --maxWorkers=1`).
- Workspace typecheck, both production builds, package-boundary checks and Git whitespace checks passed on the same source.
- Combined real Chrome flow: **22 passed** (6 automatic/live analysis, 6 Hand summary, 10 Table Session summary).
- Browser coverage includes nonblocking play, shared evaluation/score reuse, complete-only means `(.325,.375)`, failed-only frozen Retry, notifications without a table subscription or polling, POST/notification and POST/reconnect races, obsolete attempts/connections, stale-reference recovery and restart persistence.
- Browser console contained only intentional HTTP 404 responses for lost transient manifests; no JavaScript exception remained.

The owned Chrome session `poker-m2-repairs` (bridge 9594), application/control ports 3094/3096 and unique fixture schema, relay 4094 and Vite 5294 were stopped before broad tests. All five dedicated listener ports were verified closed. The preserved shared PostgreSQL cluster remains with the parent task (wrapper session 20004, PostgreSQL PID 24820, port 54329).

Final integration ancestry was verified against `codex/m2-numerical-trainer-analysis` at `5fe9f980e265d435501de1cc3523b6da93192b9c`. No source changes followed the independent reviewer rechecks or final validation; the follow-up commit records this evidence only.
