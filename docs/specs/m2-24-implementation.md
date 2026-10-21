# M2 #24 - Hand Score Summaries

The Playground can explicitly request a Hand Score Summary over accepted human decisions, inspect captured revision/count/reference, and Retry a failed frozen request. Hand completion is not required. Research supplies both arithmetic means only after every member succeeds; empty sets have no numeric score, errors outrank pending, and neither missing nor failed members become zero or a partial average.

## Committed snapshot and shared execution

`captureHandSummary` runs once under the existing Table Session queue. It freezes accepted human Decision IDs in history order, captured poker revision, one complete selected Reference Strategy, and each original participant-safe input using the same synchronous `captureEvaluation` helper as #23. Later accepted actions and configuration changes cannot change that request.

One server-lifetime summary coordinator shares the existing analysis module and JobRunner across all owners and requests. Batch size and the global outstanding bound are both 2; aggregate Research jobs use that same budget. Missing member jobs use `summary-analysis` priority 2. Matching cache entries and active jobs retain their first submitted purpose, including interactive/live/automatic work.

The runner exposes physical settlement separately from its logical result. Analysis retains settlement by execution attempt, and a scored attempt includes settlement of its evaluation dependency. Summary slots remain occupied through logical timeout until physical execution settles. Repeated summary Retry cannot use a new attempt ID to bypass that bound. New summaries refresh member state from the authoritative analysis module when another consumer has retried it; older physical attempts remain accounted for while the newer success or active attempt is reused.

Summary manifests and failures remain transient. Successful member evaluations/scores retain the existing PostgreSQL persistence and matching reuse. No additional evaluator, runner, durable obligation, recovery sweep, polling loop or gameplay revision is introduced.

## HTTP and browser lifecycle

- `POST /api/table-sessions/:id/hand-summaries` captures a new snapshot from a Hand ID.
- `GET /api/table-sessions/:id/summaries/:requestId` reads that exact authorized transient manifest.
- `POST /api/table-sessions/:id/summaries/:requestId/retry` retries failed dependencies with original frozen inputs/seeds and reuses successful or active members. Concurrent Retry converges on one attempt.

Terminal summary state is stored before the authorized user-channel notification. Notifications identify Table Session, request and attempt, contain no averages, and require no live table subscription. A missing old manifest returns 404 after restart; it is never recaptured under the old request ID.

Decision and summary UI now share `analysis-resource.ts` reconciliation. It preserves notification-during-fetch dirtiness, connection generation, request/attempt guards, readiness refresh and abandoned-target cleanup. Summary creation retains its returned immutable ID before handling a notification or lifecycle change that raced the POST, so reconciliation performs an exact read rather than another snapshot. Summaries disable missing-request recovery; the UI explains unavailability and offers explicit new creation. A response whose target no longer matches stops loading with a recoverable message.

The existing neutral engineering controls and styling are retained. This does not choose M3 summary timing or introduce advice labels.

## TDD evidence and validation

Approved seams were real HTTP/WebSocket/PostgreSQL, Research public numerical functions and real browser transport. No tests assert internal coordinator maps or the production completion/settlement methods.

Observed red-to-green slices included missing empty-summary HTTP handling; missing Research means; incorrect empty state for an accepted member; three starts against the global bound of two; missing frozen Retry; stale failed member state after individual Retry; and summary priority incorrectly matching interactive priority. The original browser lacked the explicit Hand control. The held exact-summary-read test first failed because the real transport fixture did not yet support that delivery control.

Ten server cases cover committed snapshot membership/reference/revision, independent means, active-Hand analysis, no partial output, failure precedence, failed-only Retry/seeds, active/successful shared reuse, global bounds across owners/overlap, capacity errors, physical timeout/repeated Retry, user-channel authorization/readability, no subscription requirement, unchanged poker state and restart behavior. Research independently verifies empty, one-decision and `(0,0),(.3,.5),(0,0)` means. Known server examples include `(0.25,0)` and `(0.65,0.75)`.

Final checks on the integrated source:

- Full serial real-PostgreSQL suite: **317 tests in 38 files passed**, exit 0, 182.85 seconds (`node node_modules/vitest/vitest.mjs run --maxWorkers=1`).
- Workspace typecheck, both production builds, package boundaries and Git whitespace checks passed.
- **37 real Chrome cases passed**: 31 inherited evaluation/Retry/scoring/automatic cases and six Hand-summary cases in `scripts/smoke-summaries-browser.js`.
- The Hand driver covers empty metadata, completion during held creation, reconnect/readiness during held creation with exactly one POST, explicit Retry and superseded-attempt rejection, restart without recapture plus persistent member reuse, and a held exact read after closing the table.
- One batched desktop 1440px/narrow 500px visual inspection showed no horizontal overflow. The browser resize floor was 500px; no smaller viewport result is claimed. The single mechanical detector pass returned `[]`.
- Final browser errors were expected HTTP 404s for lost manifests and WebSocket handshake failures during deliberate fixture restart/relay replacement; no remaining JavaScript exception was observed.

All owned Chrome, fixture/schema, relay and Vite resources were stopped before the serial suite. The shared PostgreSQL wrapper remains owned by the parent task.

## Reproduce browser checks

Use the existing real `evaluation-browser.ts` fixture with `POKER_EVALUATION_PORT=3084`, `POKER_EVALUATION_CONTROL_PORT=3086` and `TEST_DATABASE_URL` set to the test database. Run `live-transport.ts` with upstream 3084 and transport port 4084, then the Playground on 5284 with API target 4084. Open an isolated Chrome session and evaluate `scripts/smoke-summaries-browser.js` through Vite's absolute `/@fs/` path. Its control origin defaults to 3086. The inherited drivers accept their corresponding global control-origin overrides for the same isolated fixture. Stop Chrome, call control `/stop` to remove the schema, then stop relay/Vite before broad tests.

This branch includes integration `423d732d596f9af875789aadd98a2f74375923e1` (#23). Expected additive conflicts preserved purpose propagation, accepted-action capture and Live Analysis alongside summary routes and physical settlement.
