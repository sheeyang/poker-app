# M2 #20 implementation evidence

This slice explicitly evaluates the current human decision against the committed Reference Strategy. It does not automatically trigger Live Analysis, calculate accepted-action scores, or offer failed-work Retry; those belong to the dependent tickets.

## HTTP and retention

- `POST /api/table-sessions/:id/analysis` accepts only `{ decisionId }`. It captures an authorized committed human decision and complete reference descriptor. Missing work is admitted at priority 1; matching active/successful/failed work is reused. A capacity error returns HTTP 503 with a readable `status: error` resource, never an unadmitted pending job.
- `GET /api/table-sessions/:id/analysis/:requestId` reads an exact authorized request. It never starts or retries computation. A transient request absent after restart returns 404; the browser can get-or-start the still-current matching target again.
- Request and execution-attempt identities are separate. The identity retains table/participant/Hand/decision, complete Policy and selector descriptors/configurations, safe-input fingerprint, effective independent seeds, and engine/random/evaluation versions. No master seed or authoritative object enters Policy input or browser results.
- Successful normalized distributions and selected actions persist separately in `analysis_evaluations`. They are readable before owner-scoped completion notification. Execution/persistence failures become safe readable transient errors before notification. They never advance poker/session revisions or submit an action.
- Exact successful results survive restart. Pending jobs and failures are transient; there is no recovery sweep or durable obligation.

## Playground and transport

The explicit **Evaluate current decision** control shows the Policy's exact Concrete Choices/probabilities and its selected action separately. Legal play stays available during held or failed evaluation. No scores or advice are shown.

The shared user channel triggers HTTP reconciliation independently of live table subscriptions. Initial readiness and reconnect refresh relevant requested analysis. The reconciliation latch remembers a notification received while an older pending HTTP response is held, including before the initial response installs its request ID. Table/decision/reference, request/attempt, and connection generations reject obsolete delivery. Missing transient work after restart is requested again; a retained error is read without restarting.

## Verification

- Red/green: initial route was absent (404), completion notification was absent, capacity returned 200, and the current-decision Playground control was absent before the corresponding slices were added.
- Real HTTP/WebSocket/PostgreSQL: 10 new tests cover pending/complete/error/missing, concurrent matching requests, full descriptor identity, participant-safe immutable inputs, owner authorization without table subscription, persist-before-notify, a real PostgreSQL write failure, retained failure reads, timeout capacity, late historical cache population, shutdown, and restart reuse/missing work.
- Full suite: **268 tests / 33 files passed**, using `node node_modules/vitest/vitest.mjs run --maxWorkers=2` with `TEST_DATABASE_URL` set to the task's real test database.
- `pnpm typecheck`, `pnpm build`, `pnpm check:boundaries`, and `git diff --check` passed. The single Impeccable mechanical check returned no findings.
- Real Chrome driver `scripts/smoke-evaluation-browser.js` passed 12 cases: notification during initial pending HTTP, exact sizes/selected action, no polling, preconnection completion on readiness, reconnect with old HTTP, changed-reference late response isolation, obsolete request/attempt notifications, abandoned table response, failure/nonblocking play, no implicit retry, one shared socket, and missing transient recovery after server restart.
- Desktop and narrow viewport inspection found no horizontal overflow; the new section follows the existing labeled native controls and table styles.

## Reproduce the browser driver

Use an isolated real PostgreSQL fixture and ports; do not reuse another active browser fixture's schema:

1. Set `TEST_DATABASE_URL`, then run `node --import tsx apps/server/test/fixtures/evaluation-browser.ts` (HTTP 3024, lifecycle/Strategy control 3026).
2. Set `POKER_API_UPSTREAM=http://127.0.0.1:3024` and `POKER_TRANSPORT_PORT=4022`; run `node --import tsx apps/server/test/fixtures/live-transport.ts`.
3. From `apps/playground`, set `POKER_API_TARGET=http://127.0.0.1:4022`; run its package-local Vite on port 5194.
4. Open 5194 in an isolated Chrome CLI session. Evaluate the async function in `scripts/smoke-evaluation-browser.js`; a Vite raw import avoids Windows command-line length limits. The Strategy fixture controls only genuine Strategy timing/failure; it retains the real app and PostgreSQL.
5. Call the control fixture's `/stop` to close its server and drop its owned schema. Stop its relay/Vite/Chrome session separately.

`live-transport.ts` now supports one-shot `analysis`/`analysis-read` HTTP holds, `analysis-live`/`ready` frame holds, captured-analysis replay (including an obsolete attempt identity), and request counters. These remain browser fixture delivery controls, not production APIs.
