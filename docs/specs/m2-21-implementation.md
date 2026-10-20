# M2 #21 implementation evidence

Retry is an explicit owner-authorized POST to /api/table-sessions/:id/analysis/:requestId/retry with an empty body. It restarts only a retained failed analysis. A pending attempt or successful result is returned unchanged, including persistent successful results after restart. Missing transient requests return not-found; ordinary get-or-start and result reads keep existing failures without re-execution.

The immutable request ID, original participant-safe view, complete Reference Strategy descriptor, cache identity and effective seeds survive Retry. Only attemptId changes. Concurrent Retry admissions share one operation. A capacity rejection is a readable safe error with HTTP 503, with no phantom pending job. The runner's submitted purpose/priority is unchanged when active work is reused, and timeout/cancellation continues retaining running capacity until underlying computation settles.

Evaluation completion, persistence and publication are guarded by the current attempt. Late timed-out success/error cannot replace a retry. Numerical completion is saved and HTTP-readable before the authorized notification; failures are readable first as well. Retry does not submit poker commands, alter controller provenance, or advance poker/session revisions.

The Playground adds Retry evaluation to its failed state and keeps legal actions available. A local operation version rejects old HTTP responses racing Retry. Notifications retain reconciliation dirtiness while a fetch is in flight. A same-request notification carrying an unknown attempt triggers an authoritative exact-request HTTP read, allowing Retry begun in another tab to become visible. Previously observed superseded attempts are ignored. Responses also retain the target and connection-generation guards; no polling is introduced.

## Verification

- Red/green: the Retry route initially returned 404 instead of authenticated Retry handling, and the browser initially lacked the Retry control.
- The evaluation HTTP/WebSocket/PostgreSQL suite passes 15 tests, including five added cases: preserved frozen inputs/reference/seeds with concurrent/active/success reuse and authorization; late old success; late old error; timeout capacity retained across Retry; and successful Retry after a real PostgreSQL result-write failure.
- The two-tab real browser driver scripts/smoke-retry-browser.js passes six cases: failed-only control, local Retry against a held old failure read, nonblocking play, known obsolete attempt rejection, Retry from another actual browser tab against an old displayed/held failure, and no polling.
- The existing scripts/smoke-evaluation-browser.js passes its 12 transport/restart cases. Its fabricated unknown-attempt notification now verifies one authoritative exact-request refresh rather than blanket rejection; unrelated requests and known superseded attempts remain ignored.
- Workspace typecheck, both production builds, package boundaries and diff whitespace checks pass. The complete serial suite passed 273 tests in 33 files with node node_modules/vitest/vitest.mjs run --maxWorkers=1 (164 seconds).
- An initial parallel full-suite run encountered host allocation failure and PostgreSQL recovery under concurrent workloads. Browser/relay/Vite/application fixtures were stopped before coordinated serial validation. No production limits or tests were relaxed for that infrastructure failure. The final browser run had no JavaScript exceptions; its console retained the expected missing-transient-request HTTP 404 from the restart recovery scenario.

## Reproduce browser verification

Use the existing isolated real PostgreSQL evaluation-browser.ts fixture with POKER_EVALUATION_PORT=3034 and POKER_EVALUATION_CONTROL_PORT=3036; TEST_DATABASE_URL points at the test database. Run live-transport.ts with POKER_API_UPSTREAM=http://127.0.0.1:3034 and POKER_TRANSPORT_PORT=4032. Start the Playground on port 5204 with POKER_API_TARGET=http://127.0.0.1:4032.

Open http://localhost:5204 in an isolated chrome-devtools-axi session and evaluate the async function from scripts/smoke-retry-browser.js through Vite's absolute /@fs/ source path. The driver opens and closes a real peer tab sharing the authenticated cookie. Evaluate smoke-evaluation-browser.js with its Strategy control origin changed from 3026 to 3036 for this isolated stack. Each returns passed: true. Stop the scoped browser, call the fixture control /stop to remove its isolated schema, and stop the relay/Vite processes when finished.
