# M2 #25 — Table Session Score Summaries

The Playground explicitly requests a Table Session Score Summary across accepted human decisions in every Hand. Each request freezes membership, one complete Reference Strategy, original participant-safe inputs and captured poker revision under the existing Table Session queue. Later play and settings changes require another explicit snapshot; no session-ending command is introduced.

## Shared summary pipeline

The existing summary coordinator now accepts a discriminated Hand or Table Session scope. Both scopes use the same dependency identities, successful persistent evaluation/score caches, active jobs, failed-only Retry, Research arithmetic, aggregate jobs, user notifications and HTTP reads. The shared outstanding limit and batch size remain 2, including aggregate submissions and physical settlement after logical timeouts. There is one coordinator and one application runner, with new missing members using priority 2.

POST /api/table-sessions/:id/session-summaries accepts an empty request and returns the frozen scope, request/attempt identities, captured revision, count and Decision IDs. Shared /summaries/:requestId reads and /retry operations retain owner authorization. Empty sets have no jobs or numerical means. Any member failure takes precedence over pending; complete means appear only after every member succeeds. Retry preserves the original membership, reference, inputs and seeds, reusing successful and active members.

A reproduced recovery edge also required a small coordinator correction: an initial derived-score lookup could throw before analysis created a request, leaving a dependency with a failure but no state. After the database recovered and individual analysis succeeded, a new summary still retained the old coordinator failure. New explicit snapshots now re-admit such lookups through the same bounded queue, and authoritative successful reads clear stale coordinator failures. Older failed summary requests remain failed until explicit Retry. No implicit retry-on-read or new recovery machinery was added.

## Browser behavior

Hand and Table Session controls share captured metadata, empty/error/pending states, Retry and numerical rendering. Each scope retains its own frozen resource target. All three consumers—decision, Hand and Table Session—use the existing event-driven HTTP reconciliation hook. Completion/failure notifications carry identities rather than numerical results, require no table subscription, and follow HTTP readability.

Session creation retains its returned request ID when a completion or readiness/reconnect races the POST. Exact reads, obsolete request/attempt/connection guards and abandoned-target cleanup remain shared. A missing old summary after cold restart is surfaced as unavailable; only explicit creation captures a new snapshot, which reuses persisted successful members.

The existing neutral engineering layout and labels were extended without new styling or a new session flow. Desktop and narrow inspection confirmed visible captured metadata and numerical means with no horizontal overflow at the host's 500px viewport floor. The one mechanical detector pass returned an empty findings list.

## Independent numerical example

The real multi-Hand fixture uses a passive Bot and a controlled external Reference Strategy. Legal human actions are Fold in Hand A; Check preflop, Check flop and Fold turn in Hand B. Independent member scores are:

| Scope/member | Decision Score | Action Rank Score |
| --- | ---: | ---: |
| Hand A decision | 1 | 1 |
| Hand B preflop | 0 | 0 |
| Hand B flop | .3 | .5 |
| Hand B turn | 0 | 0 |
| Hand B mean | .1 | 1/6 |
| Table Session mean over four decisions | .325 | .375 |

Averaging Hand means would incorrectly produce (.55,7/12). Both the HTTP test and real Playground show the decision-weighted (.325,.375). A later fifth successful Fold produces (.46,.5), while the earlier four-decision request remains unchanged.

## TDD and acceptance evidence

Approved seams are real HTTP/WebSocket/PostgreSQL and real browser transport, with controlled external Strategies and transport delivery. No assertions inspect coordinator maps or private execution methods. Observed red-to-green slices were the absent session creation route (404), the initial derived-score lookup failure retaining an obsolete dependency error, and missing session controls in a loaded Playground table. Existing Hand machinery already passed the additive frozen capture, Retry and restart cases.

Five new real server cases cover fresh/Bot-only empty sets and authorization; unequal-Hand means and overlapping Hand/session scopes under the same global budget; owner-only user-channel delivery/readability without table subscription; recovered derived lookup reuse; membership/reference/revision frozen across later play and settings; error precedence and failed-only Retry with identical inputs/seeds; and cold restart's old-request 404 plus persistent member reuse. Existing ten Hand cases continue to cover shared capacity, physical timeout/settlement, repeated Retry and fixed runner priority.

The combined final browser proof passed 22 cases on the updated Playground: six inherited automatic-analysis cases, six Hand-summary cases and ten session cases. The session driver includes an authenticated peer-tab reference change after a real unsubscribe-table command while retaining the user channel. Historical HTTP analysis stops loading with a recoverable target-mismatch message, exposes no wrong-reference result, and recovers after Refresh view without silently subscribing. It also verifies session notification/POST and readiness/POST races with exactly one creation, both summary means, no polling, persisted preferences in a fresh app tab, frozen later-play behavior, failed-only Retry, obsolete request/attempt/real retired connection delivery, cold restart reuse and a delayed exact read after closing the target.

Definitive checks on the final source:

- Full serial real-PostgreSQL suite: **322 tests in 39 files passed**, exit 0, 191.72 seconds (node node_modules/vitest/vitest.mjs run --maxWorkers=1).
- Workspace typecheck, both production builds, package boundaries and Git whitespace checks passed.
- **22 real Chrome cases passed** in the final combined flow, in addition to #24's prior definitive 37-case evidence.
- Browser console errors were the intentional HTTP 404 responses for lost transient manifests; no JavaScript exception remained. The 500px viewport had scrollWidth 500 and visible .325000/.375000 means.

 All owned Chrome, application fixture/schema, relay and Vite resources were stopped before the serial full suite. The shared PostgreSQL wrapper remains with the parent task.

## Reproduce

Start apps/server/test/fixtures/session-summary-browser.ts with TEST_DATABASE_URL set. Its isolated application/control ports default to 3094/3096. Start live-transport.ts with POKER_API_UPSTREAM=http://127.0.0.1:3094 and POKER_TRANSPORT_PORT=4094; run the Playground on 5294 with POKER_API_TARGET=http://127.0.0.1:4094. In isolated real Chrome, evaluate scripts/smoke-automatic-browser.js with automaticControl set to http://127.0.0.1:3096, then scripts/smoke-summaries-browser.js with summaryControl at that origin, then scripts/smoke-session-summaries-browser.js. Load each through Vite's absolute /@fs/ workspace path with ?raw and evaluate its default string. The final driver defaults to control3096.

The Strategy fixture preserves the real baseline path before switching to externally controlled passive/numerical policy outputs for the independent example. It changes no production acceptance, engine, persistence, limits or reconciliation behavior. The transport fixture's unsubscribe control sends the existing real typed protocol message; it does not disable production subscriptions or delivery logic.

Call control /stop to shut down the application and drop its unique schema, stop the isolated Chrome session, relay and Vite, then run the full suite serially. This branch starts from integration ae5df7c1d3e93a95507e951b31f87c20a9eed481 (#17–#24).
