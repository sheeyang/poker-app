# M1-12 implementation: baseline Bots through JobRunner

Ticket: https://github.com/sheeyang/poker-app/issues/12.
Base: integration `implement/m1` at `3255f94`.

## Implemented behavior

`@poker/strategies` exports Policy, ActionSelector and composed Strategy contracts,
UniformChoicePolicy, shared validatePolicyResult, ProbabilitySelector,
HighestProbabilitySelector, and the baseline descriptor resolver. Policy
compatibility and evaluation receive the same detached immutable
ObservableGameView. Configuration belongs to the configured capability;
effective evaluation seed and execution AbortSignal remain separate options.

Uniform Choice includes every legal unsized action and both inclusive sizing
endpoints, deduplicating a coincident endpoint (including the sole short all-in).
The shared validator rejects empty/all-zero, duplicate, illegal, noninteger-sized,
nonfinite/out-of-range, and incorrectly normalized distributions. Absolute sum
tolerance is `1e-9`. It drops zero entries, normalizes tolerated drift, preserves
plain informational diagnostics in a detached immutable result, and orders Fold,
Check, Call, ascending Bet-to, then ascending Raise-to. Selectors consume these
choices unchanged. Highest Probability retains the first maximum; Probability
uses one unit from its declared fresh seed stream.

M1 jobs use the exact unsuffixed ParticipantId/DecisionId tuple documented in
[random-v1.md](../random-v1.md). Independent Python standard-library vectors in
[fixtures/strategy-v1.py](../fixtures/strategy-v1.py) lock the bytes, namespace
independence and first sampling result. Policy/selector draws cannot consume the
Hand deck stream. Uniform Choice uses no Policy randomness; Highest Probability
uses no selector seed.

One JobRunner is created per server. Defaults are two executing jobs, at most
sixteen waiting jobs, and a ten-second execution timeout. It returns tagged plain
success/failure, freezes detached inputs/results, and signals cancellation.
Capacity, cancellation, timeout, evaluation, compatibility, validation and
selection failures never invent a poker action. Timeout or running cancellation
keeps its execution slot charged until underlying work settles; queued work can
be removed immediately. Late settlements/rejections are absorbed.

The supported M1 production backend is the bounded synchronous Uniform Choice
baseline and trivial selectors. In-process async extensions must cooperate with
AbortSignal and settle in bounded time, including shutdown. Main-thread timers
cannot preempt arbitrary synchronous CPU work. Arbitrary CPU or permanently
uncooperative backends require an isolated-worker execution/confirmed-termination
adapter before production support. `close()` cancels work and waits for underlying
settlements; the lifecycle test deliberately settles an ignored-cancellation
fixture and proves its late success cannot act in the closed lifecycle.

The existing per-session mutation FIFO owns scheduling and acceptance. Its Bot
slot captures pokerRevision, ParticipantId, HandId, DecisionId, complete Strategy
descriptor/configuration, private assignment generation, independently derived
seeds, frozen input fingerprint and unique evaluation request identity. Every
completion/status re-enters that FIFO and checks all identities against one
committed state. Computation runs outside the queue. A valid result uses the
existing internal acceptance primitive, avoiding nested-queue deadlock.

Accepted automated actions atomically append application Bot provenance beside
the poker command, revisions and durable request outcome. `commandIndex` is
zero-based within accepted poker commands. Provenance retains the original
Policy/selector identities, versions, complete configurations, effective seeds,
input fingerprint, assignment and evaluation identity; distributions are derived
and are not persisted as replay authority. Later controller changes preserve old
provenance. Restoration replays ConcreteActions without historical evaluations.

Startup enumerates committed sessions and resumes only current Bot decisions,
even without a browser. Corrupt-record restoration is isolated per session so
other sessions and the server can start. Human decisions remain pending and
settlement never starts another Hand. Close invalidates current Bot slots and
prevents late callbacks from changing actions/status; pending accepted mutations
drain before persistence closes.

Transient public thinking/failure/recovery feedback advances no revision.
Failures use a fixed code/message whitelist; raw exceptions, diagnostics,
compatibility reasons, seeds and private cards never become status text. Recovery
has precedence over late job failures. A reconnect receives the current complete
participant-safe view and current transient status.

## Reusable interfaces for the next tickets

- `apps/server/src/job-runner.ts`: JobRunner.submit(input, execute) returns a
  result promise and cancel handle; execution receives AbortSignal. Research must
  use the same `jobRunner` instance in createServer, rather than create another.
- `apps/server/src/mutations.ts`: configure() accepts authenticated
  `set-playing-strategy` and `retry-bot` operations within the existing FIFO.
  Both use durable idempotent fingerprints/outcomes. Strategy replacement takes
  expectedSessionRevision, changes private assignment generation and increments
  sessionRevision only. Retry changes neither revision, retains exact inputs/seeds,
  and installs a fresh evaluation request identity after confirmed acceptance.
- HTTP `/api/table-sessions/:id/set-playing-strategy` and `/retry-bot` are
  owner-authorized. The browser act route still rejects Bot impersonation.
- Trusted `readPersistedSession(id)` reads only a committed PostgreSQL aggregate,
  validates the complete poker record, and returns a detached immutable durable
  record. It is available beside the trusted controller capability and has no
  HTTP route. Research can reuse this persistence read; it exposes no working
  cache/proposed aggregate or live CashGame.
- `automaticBots:false` is an explicit server-only fixture mode. Existing poker
  fixtures use it with their trusted manual controller actions; production defaults
  to automatic Bots. Manual fixtures do not invent Strategy provenance for actions
  that were never evaluated by a Strategy. No HTTP bypass was added.

Ticket #13's basic owner retry/Strategy change path and Playground controls are
already present. Its remaining work can extend acceptance/race/recovery coverage
and refine controller feedback without duplicating the queue or runner.

## Playground and verification

Each Bot independently selects a complete baseline Playing Strategy at creation
and can change it later. The default is Uniform Choice + Probability Selector;
Highest Probability Selector is available. Current failures show explicit retry
and Strategy recovery controls. Pending controller attempts retain their request
identity and distinguish definitive rejection from unconfirmed infrastructure
outcomes. Legal human action controls are independent of controller computation.

The incumbent React engineering interface, palette and native controls were
preserved. Intent/Impeccable context was loaded once; the craft floor was applied
before UI edits. One mechanical detector pass returned `[]`.

`pnpm check` passed: workspace typecheck, **208 tests in 27 files**, production
server/Playground builds, and authoritative-package browser boundary checks.
The real PostgreSQL/HTTP/WebSocket fixtures cover safe frozen inputs, all explicit
Strategy failure stages, seeded public fixtures, retry/assignment/configuration
races, trusted poker supersession, timeout capacity, restart without historical
reevaluation, owner authorization/idempotency, human responsiveness, close, recovery
precedence, and provenance held invisible until confirmed real COMMIT. The full
suite's short-timeout fixture was made deterministic by answering its fresh
backend request immediately; the old timed-out work remains charged until its
controlled settlement and returns a different obsolete action.

The isolated browser fixture used server port 3012, Vite port 5182 and its own
PostgreSQL schema. Through ordinary UI controls it created a two-seat, one-Bot
Highest Probability table; seated both Participants; started Hand 1; submitted
legal Raise-to 40; displayed an injected computation failure at revisions 4/4;
explicitly retried; and settled Hand 1 at 5/5. A Strategy change to Probability
advanced only sessionRevision to 6. Disconnect/reconnect retained the completed
Hand. A mobile change back to Highest Probability advanced only sessionRevision
to 7 and showed “Playing Strategy saved.” No next Hand was started automatically.
Normal HTTP/WS data contained no effective seeds, diagnostics, assignment or
provenance fields, and unrevealed Bot cards remained absent.

Desktop (1440×1000) and actual mobile emulation (390×844) had no horizontal
overflow. Mobile helper text contrast was 6.36:1 on white; native controls and
focus rings remained usable. Browser console error list was empty. Captures:

- `C:/Users/sy/.codex/visualizations/2026/10/07/01a115dd-7d6d-79d2-82a4-f9d61deb33de/m1-12-bot-failure.png`
- `C:/Users/sy/.codex/visualizations/2026/10/07/01a115dd-7d6d-79d2-82a4-f9d61deb33de/m1-12-desktop.png`
- `C:/Users/sy/.codex/visualizations/2026/10/07/01a115dd-7d6d-79d2-82a4-f9d61deb33de/m1-12-mobile-390.png`

The ticket-owned bridge/server/Vite processes were stopped. Its exact isolated
browser schema was dropped and verified absent. Other processes/databases were
not modified.
