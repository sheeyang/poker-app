# M1-13 implementation: safe Bot recovery and Playing Strategy changes

Ticket: https://github.com/sheeyang/poker-app/issues/13.
Base: integration `implement/m1` at `bf1592d`.

## Delivered behavior

Ticket #12 already delivered the owner-only Retry and Change Playing Strategy
HTTP routes, Playground controls, one session FIFO, exact current-request guards,
durable controller outcomes, provenance and restart behavior. This slice retains
those working interfaces and verifies the remaining races through the real
Fastify HTTP/WebSocket, isolated PostgreSQL and shared JobRunner boundary.

A confirmed rollback while saving a computed Bot action now publishes the
explicit `persistence-unavailable` controller failure with the safe message
“The Bot action could not be saved. Retry this decision.” The failure changes
neither revision and adds no command or provenance. Retry evaluates the unchanged
decision from the same declared inputs and effective seeds, using a fresh
orchestration identity. Unknown COMMIT still enters the existing recovery barrier;
this change does not implement the separate ticket #15 reconciler.

No private engine helper, reducer, HTTP authority bypass, second queue or second
JobRunner was added. The trusted `readPersistedSession` callback verifies detached,
confirmed application persistence and provenance; ordinary clients receive only
the explicit participant-safe projections.

## Acceptance evidence

- Owner authorization, human Bot impersonation rejection, duplicate Strategy
  success, conflicting request contents and expected-session-revision rejection
  remain covered by the existing real-server lifecycle fixtures.
- The new rollback fixture establishes RED before the new failure code/message,
  then verifies GREEN, unchanged revisions and provenance, safe wire text,
  identical Retry inputs/seed and a distinct accepted evaluation request identity.
- A new held-COMMIT controller fixture queues a returned old action behind an
  assignment change at the same DecisionId. HTTP, trusted persistence and WS keep
  the old committed assignment/revisions until COMMIT. The complete new WS view
  advances sessionRevision only; old work cannot act, and the newly configured
  Strategy alone supplies the accepted command and provenance.
- A new durable Retry fixture returns the exact stored success/rejection after
  later assignment changes and restart. Matching request IDs schedule no fresh
  evaluation, changed contents conflict, and a stale-session rejection remains
  definitive independently of later revisions.
- A new repeated-Retry fixture holds three computations through the real runner.
  Older errors/actions cannot replace the newest thinking status or accepted
  action; identical declared inputs/configuration/seeds remain intact.
- Existing fixtures verify explicit compatibility/evaluation/validation/selection
  failures, timeout/capacity with no fallback, replace-away-and-back assignment
  generation, poker advancement before work acceptance, recovery precedence,
  committed provenance surviving assignment/restart, and current-only startup
  resumption without historical Policy reevaluation.
- Running timed-out work remains charged until it settles. Supported cooperative
  async work settles on shutdown; bounded in-process baseline work remains the
  production path. Timers do not claim arbitrary synchronous CPU preemption.

`pnpm check` passed: workspace typecheck, **212 tests in 27 files**, production
server/Playground builds, and authoritative-package browser boundary checks.

## Browser evidence

An isolated browser fixture used server port 3013, Vite port 5183 and its own
PostgreSQL schema. The fixture now accepts `POKER_BROWSER_PORT` and
`POKER_BROWSER_FAIL_SAVE_ONCE` so save rollback can be exercised through ordinary
UI controls without an authority bypass.

Through those controls, the browser created a two-seat, one-Bot Highest Probability
table, seated both Participants, started Hand 1 and submitted legal Raise-to 40.
The controlled save rollback displayed the explicit failure and Retry at revisions
4/4. Retry settled the same Hand at 5/5. A Strategy change advanced only
sessionRevision to 6. A second connected browser client received another Strategy
change at sessionRevision 7 via its complete WS envelope, without refresh. Actual
390×844 mobile/touch emulation saved another change at sessionRevision 8, then
disconnected/reconnected to the same completed Hand at pokerRevision 5. No next
Hand started automatically.

The incumbent React engineering interface was preserved; no frontend component or
style was changed. The localized infrastructure error copy follows Articulate's
specific problem and recovery-action guidance. Desktop (1440×1000) and mobile had
no horizontal overflow, and browser console errors were empty. The actual normal
read body at 5/8 contained no master/effective seeds, assignment/evaluation IDs,
Bot provenance, deck or burn identities; unrevealed Bot hole cards were absent.

Captures and wire evidence:

- `C:/Users/sy/.codex/visualizations/2026/10/07/01a115dd-7d6d-79d2-82a4-f9d61deb33de/m1-13-persistence-failure.png`
- `C:/Users/sy/.codex/visualizations/2026/10/07/01a115dd-7d6d-79d2-82a4-f9d61deb33de/m1-13-desktop.png`
- `C:/Users/sy/.codex/visualizations/2026/10/07/01a115dd-7d6d-79d2-82a4-f9d61deb33de/m1-13-mobile-390.png`
- `C:/Users/sy/.codex/visualizations/2026/10/07/01a115dd-7d6d-79d2-82a4-f9d61deb33de/m1-13-wire-read.network-response`

The ticket-owned Chrome bridge and verified server/Vite processes were stopped.
Its exact isolated schema was dropped and verified absent, and ports 3013/5183
were no longer listening. Other processes and databases were not modified.
