# Poker Trainer

An authoritative local no-limit Texas Hold'em workspace. M1 includes continuing owned Table Sessions, complete Hold'em play, durable recovery, baseline Bots, between-Hand management, live synchronization, and authorized completed-Hand inspection. The participant-facing Trainer is implemented in `apps/web`.

## Local startup

The M3 product interface is the [Trainer](http://127.0.0.1:5174). Run
`pnpm dev:trainer` to start it with the API and managed local database. Create a
table, open **Table settings → Seat all players**, then **Deal first hand**.
**Analysis** opens the collapsible study panel. **Finish session** captures a
numerical summary between Hands; the continuing table stays saved.

Install Node.js 24 or newer and pnpm 11.25.0, then from the repository root:

```powershell
pnpm install --frozen-lockfile
pnpm dev:trainer
```

Open [the Trainer](http://127.0.0.1:5174). The command starts and initializes a real local PostgreSQL 18.4 server, the API server, and the Trainer. No `.env` file or manual database initialization is required. `pnpm dev` starts all apps with the same database management. Vite proxies `/api` to the Fastify server at `127.0.0.1:3001`, so cookies and requests use the same browser origin.

Keep the terminal running. Ctrl+C gracefully stops the owned database; development data persists in the ignored `.local/postgres` directory. The database listens only on `127.0.0.1:54329`; set `POKER_POSTGRES_PORT` to change that port. An occupied port is an error, and startup does not take over another database.

An explicit `DATABASE_URL` uses an externally managed PostgreSQL database instead. An explicit `TEST_DATABASE_URL` does the same independently for tests. Optional settings can go in a root `.env`; shell values take precedence. Configured connection failures are reported without switching databases. See [local development](docs/local-development.md) for platform support, browser fixtures, and troubleshooting.

The example database password is for local development. The identity is an opaque server-issued HttpOnly, SameSite=Strict cookie; retaining that browser cookie retains ownership after reload or server restart. Browser storage remembers the selected Table Session, but it does not establish permission. Clearing the identity cookie creates a different local user.

## Checks and compiled startup

```powershell
pnpm check
# After pnpm build, with DATABASE_URL configured:
pnpm --filter @poker/server start
```

`pnpm check` typechecks the scripts and packages, runs public engine and real localhost HTTP/WebSocket/PostgreSQL tests, builds the server and Trainer, and checks workspace dependency directions. Without `TEST_DATABASE_URL`, each `pnpm test` invocation starts a fresh PostgreSQL instance on its own port, then removes its temporary data on completion. Fixtures also create/drop a uniquely named PostgreSQL schema; they do not modify development Table Sessions. The compiled server includes its SQL initialization asset and requires `DATABASE_URL`; it never starts embedded PostgreSQL.

The frontend-only command is `pnpm --filter @poker/web dev`; the backend-only command is `pnpm --filter @poker/server dev` with `DATABASE_URL` configured. Use the root development commands for automatic database management. `pnpm db:init` also manages its database and retains the initialized development data after exiting.

## Workspace

| Path | Responsibility |
| --- | --- |
| `packages/contracts` | Explicit participant-safe HTTP/WebSocket and observable game types. |
| `packages/engine` | Trusted CashGame construction, rules, records, replay, forks, and ParticipantCashGame projections. |
| `packages/strategies` | Policy/Action Selector implementation and validation. |
| `packages/solver` | Deferred Solver capability boundary. |
| `packages/simulation` | Deferred automated simulation boundary. |
| `packages/research` | Server-only analysis and authorized completed-Hand inspection. |
| `apps/server` | Fastify authorization, identity, ownership, controllers, PostgreSQL/Drizzle persistence and durable orchestration. |
| `apps/web` | React/Vite, TanStack Router/Query, and Zustand Trainer UI. |
| `packages/client` | Shared HTTP, live synchronization, and analysis-resource reconciliation. |

Browser code uses the shared Client and participant-safe Contracts. The dependency check rejects authoritative package dependencies, and the Vite build independently rejects authoritative runtime imports, including relative imports. Engine does not depend on Strategies or Research; other authoritative packages do not depend back on Research.

## Creation protocol and persistence

`GET /api/identity` establishes the local identity. `POST /api/table-sessions` accepts `requestId`, optional observable `configuration` overrides, and optional Bot name/Playing Strategy intentions. It allocates one stable human Participant binding and the configured Bots without seating them. All hidden fields and supplied ownership/Participant identifiers are rejected. The baseline Policy is `uniform-choice/v1`, paired with `seeded-sampling/v1` or `highest-probability/v1`; each has empty configuration.

New practice tables use **Simple Heuristic** (`simple-heuristic/v1`) with Probability Selector for Bots and the Reference Strategy. It uses basic hand strength, modest bets, draws and occasional bluffs; see [the strategy rules](docs/specs/simple-heuristic.md). Both Policies support both Action Selectors and have fixed versioned rules with empty configuration. Uniform Choice remains available. Saved tables and captured analyses retain their original Strategies.

`GET /api/table-sessions` lists only the authenticated user's owned session identifiers. `GET /api/table-sessions/:id` restores or reads the committed game and returns a freshly mapped safe view with application-owned revisions and bindings.

Defaults are six seats, blinds 10/20, ante 0, minimum/default/maximum buy-in 1000, and seat changes enabled. Configuration is immutable. The server generates the hidden master seed. CashGame receives explicit trusted configuration; its version-1 record contains that configuration and accepted commands, without server revisions. A fresh session has zero accepted commands and both revisions at zero.

Each creation fingerprint uses SHA-256 of `create-table-v1:` followed by canonical JSON of request contents excluding `requestId`: object keys sort lexicographically, array order is retained, and JSON scalar representations are unchanged. The authenticated user and requestId identify the attempt. Session aggregate and small definitive acknowledgement/rejection commit together. Matching retries return original identifiers/bindings; different contents reject reuse. The Trainer retains an unconfirmed attempt and has an explicit same-request retry; it never automatically retries creation.

Infrastructure failure is outside retained domain rejections. Unknown creation COMMIT returns `commit-outcome-unknown`; a durable attempt journal identifies it by authenticated user/requestId before a Table Session ID is available. Matching retries check that attempt's durable outcome instead of allocating a second seed, session, or binding set. Other users remain independent. See the recovery protocol below.

The durable aggregate contains the private poker record, owner, human-user binding, Bot controllers, Trainer configuration, version metadata, Admin Mode setting, and committed poker/session revisions. Ordinary responses are mapped field by field and omit owner identity, master seed, record metadata and commands. There is no Reset Table operation.

## Seating and atomic acceptance

`POST /api/table-sessions/:id/seat-participant` accepts `requestId`, `expectedPokerRevision`, a bound `participantId`, a one-based `seat`, and optional `buyIn`. Omission uses the configured default; minimum and maximum are inclusive. Participant identity belongs to the continuing game, independently of its Seat. The owner may seat its human or configured Bots. Unexpected fields, unassigned Participants, occupied/invalid seats, duplicate seating, and invalid buy-ins return structured rejections.

The shared `createTableSessionMutations` service serializes all poker mutations through one FIFO per session. Different sessions progress independently. It resolves a processed request and fingerprint before checking expected revision or executing a fork of the committed CashGame. Accepted commands, both revisions incremented once, and the small acknowledgement commit in one PostgreSQL transaction. Only confirmed commit promotes the game and revisions together; readers continue to see the committed view while a transaction is held. Definitive domain/application rejections are retained in `processed_requests` without advancing either revision or entering the poker record. PostgreSQL's primary key enforces unique `(table_session_id, request_id)` identity.

Mutation fingerprints use SHA-256 of UTF-8 `poker-mutation-v1:` followed by canonical JSON of `{ source, kind, contents }`, where `source` is `human` or `bot`, `kind` is the command name, and `contents` is the complete request body excluding `requestId`. Controller mutations use `controller-mutation-v1:` and `{ ownerUserId, kind, contents }`. Object keys sort lexicographically, arrays retain order, and scalars use JSON serialization. Expected revision and omitted versus explicit buy-in remain part of those contents. Matching retries return the original small outcome, even after later changes or a restart; changed contents reject requestId reuse. Current views are read separately and never stored inside an idempotent response.

Confirmed rollback discards the working fork without promoting its seats, stacks, commands, or revisions. Unknown COMMIT confirmation reports `commit-outcome-unknown` and pauses submissions to the affected session with `session-recovering`. The Trainer retains the attempt, shows confirmed state, and offers an explicit outcome check.

The Engine's private `#mutate` path evaluates an isolated complete draft, checks seat/identity/chip conservation, and atomically replaces state with one accepted command. Live table chips are bounded by `Number.MAX_SAFE_INTEGER`; exact BigInt sums validate that bound without making valid empty configurations depend on occupancy. The bankroll is the current chip balance, not cumulative gross buy-ins. `fork()` copies state and accepted history without recording a command; `toRecord()` exports detached immutable version-1 replay inputs, and `fromRecord()` validates and replays the complete command sequence before returning a usable game. Private draft and PostgreSQL test hooks can cause controlled failures but expose no draft data or HTTP endpoint.

Engine records use `schemaVersion:1` and `engineVersion:'v1'`; the backend aggregate uses `schemaVersion:1`. Seed derivation, random source, deck order/shuffle, and selector sampling are explicitly documented in [random v1](docs/random-v1.md). Accepted Bot actions retain Strategy versions/configuration and evaluation/selection seeds in backend provenance. Restoration replays accepted concrete commands without evaluating Strategies again.

## Play, Bots, and inspection

Use the Trainer to choose human/Bot seats and buy-ins, seat players in Table settings, then explicitly deal a Hand. Human controls contain only the current legal Fold/Check/Call and exact integer Bet-to/Raise-to totals. The engine handles multiway antes, reopening, all-ins, unmatched returns, main/side/split pots, showdown ranking and payouts. Between Hands, owners can move or cash out/reseat Participants, sit out/return, choose the next button, top up stacks, and rebuy a zero stack. Every next Hand requires an explicit Start Hand; reconnect and restart do not start one.

Bots evaluate immutable participant-safe inputs through the server's single JobRunner and submit valid selected actions back through the same mutation FIFO. Baseline Strategies are testing controls with no claim of poker expertise. Invalid, failed, incompatible, timed-out, or unsaved Bot work produces no implicit action. Owners can Retry the current decision or Save Playing Strategy. Assignment changes increment sessionRevision only; Retry and transient thinking/failure advance neither revision. The runner defaults to two active jobs, sixteen queued jobs and a ten-second logical timeout. Running work retains capacity until it actually settles; arbitrary CPU backends require an isolated execution adapter.

Each Table Session also retains `trainerConfiguration`: a complete `referenceStrategy` descriptor and boolean `liveAnalysis`. New sessions use Uniform Choice + Probability Selector with Live Analysis off. The Trainer's Reference Strategy and Live Analysis controls save both fields with `POST /api/table-sessions/:id/set-trainer-configuration`, using `requestId` and `expectedSessionRevision`. This owner-only change follows the same definitive-outcome, rollback and unknown-commit recovery path as controller changes, advances only `sessionRevision`, and publishes the complete committed configuration across the owner's tabs. It does not change Bot Playing Strategies or submit a poker command. Trainer configuration restores exactly after restart; incompatible pre-release records fail restoration rather than silently receiving replacement preferences.

Admin Mode defaults on locally. Set `POKER_ADMIN_MODE=false` before starting the server to disable hidden-information reveal. An authenticated owner explicitly submits a completed Hand to `/api/table-sessions/:id/inspect-hand`; active/missing Hands and unauthorized callers are rejected. Server-only Research uses the same JobRunner to reconstruct that completed Hand's cards, deal and payout facts without changing gameplay. Inspection capability comes only from the current WebSocket connection, so a delayed HTTP/cache read cannot enable a previous server's Admin setting. The result is scoped to its requested completed Hand; normal participant views and Policy inputs remain unchanged.

## Unknown-commit recovery

Creation, poker, controller assignment, definitive rejection and Retry acknowledgements share a narrow real `pg` transaction boundary. Before target COMMIT, an independent bounded pool durably stores the attempt scope, versioned fingerprint, decimal xid8, and optional created Table Session hint. It stores no candidate cards, seed or game. The hint deliberately has no foreign key to a target's uncommitted row.

The resolver uses fresh primary READ COMMITTED statements: `pg_xact_status(xid8)` first, then a separate definitive outcome read. `in progress`, NULL, query failure, or a committed transaction without its matching outcome remain unresolved; absence of a request row alone never proves abort. A committed attempt reloads the game, both revisions, controllers/assignments and provenance together inside its existing FIFO, returns the original small outcome and publishes the current complete safe view. Only that session is paused; independent sessions continue.

An aborted ambiguous attempt retains a `commit-not-applied` tombstone. Checking its old requestId never executes it again, including after restart. The Trainer offers Start a new attempt for deliberate human resubmission. Bot work receives a fresh evaluation identity after confirmed abort, and late pre-recovery work cannot submit. An ordinary failure before terminal COMMIT remains `persistence-unavailable` with no definitive outcome and preserves explicit same-ID retry behavior.

Startup loads recovery gates before restoring sessions or resuming Bots. HTTP reads, initial live snapshots and transient `table-status` feedback expose recovery while keeping last confirmed gameplay facts; status can change without a revision increment. A pre-close lifecycle gate invalidates waiting callbacks before HTTP drains. Test fixtures can hold actual terminal SQL on independently owned PostgreSQL clients through restart; production exposes no fault routes or engine mutation bypasses.

Run the real recovery checks with `pnpm test apps/server/test/recovery.test.ts`, or all checks with `pnpm check`. The isolated browser fixture is `apps/server/test/fixtures/recovery-browser.ts`; its stdin commands `hold-next`, `commit`, `rollback`, `restart`, and `stop` control real SQL/lifecycle timing. Start it with `pnpm db:with-test -- node --import tsx apps/server/test/fixtures/recovery-browser.ts`, then use Vite port 5185 with `POKER_API_TARGET=http://127.0.0.1:3015`. `stop` closes the fixture and its schema; the wrapper then stops PostgreSQL and removes its temporary data. [M1-15 evidence](docs/specs/m1-15-implementation.md) records the combined browser flow and recovery checks.

## Live synchronization

After local identity is established, the Trainer retains one authenticated `GET /api/live` WebSocket while the app is open, including with no table selected. Its user channel readies independently of live tables. Typed `subscribe-table` and `unsubscribe-table` messages receive correlated acceptance, rejection, or removal responses; every table subscription is authorized individually. The server binds the observer to that owner's human Participant independently of any client-supplied ParticipantId. On each table subscription it sends the latest complete committed view with `tableSessionId`, `pokerRevision`, `sessionRevision`, safe controller bindings, and an empty `presentationEvents` array. Subsequent `table-update` messages publish complete views and explicitly projected events only after confirmed commit and promotion. Connections retain identity bindings rather than live CashGame or participant facade objects.

The Trainer orders both HTTP reads and WebSocket snapshots by `sessionRevision` through the same React Query guard. Older and duplicate snapshots cannot replace newer gameplay facts or replay their events; a newer full view is sufficient across missing revisions. Reconnection uses the current complete view without replaying missed animations. Transient `table-status` messages carry thinking/failure/recovery feedback separately, so unchanged durable revisions do not hide that feedback. Lost COMMIT confirmation publishes a recovery status while preserving the last confirmed gameplay view.

The Trainer shows live connection status. Unexpected closure restores desired subscriptions after reconnect and triggers a guarded HTTP refresh. Selecting another table changes subscriptions on the same socket. Readiness and analysis notification callbacks support HTTP analysis reconciliation. Cards, stacks, pots, and actor come entirely from the latest complete view.

For concurrent local development, `POKER_API_TARGET` can override the Vite proxy target while a server's `PORT` and Vite's `--port` select separate listening ports. The server transport fixtures remain available for browser verification. The earlier table-specific live endpoint remains available for existing transport consumers.

The Trainer presents Live Analysis for the current human decision and accepted-decision results in its Analysis panel, including Policy distributions and selected concrete actions. Failed analyses expose **Retry analysis**. `POST /api/table-sessions/:id/analysis/:requestId/retry` reuses successful/active work and restarts only failure with the same immutable inputs and seeds plus a new execution attempt. Ordinary reads never retry a retained failure. Cross-tab attempt notifications reconcile through authoritative HTTP without polling. See [M2 evaluation evidence](docs/specs/m2-20-implementation.md) and [Retry evidence](docs/specs/m2-21-implementation.md).

Enabling Live Analysis automatically evaluates the current human decision at priority 1; disabling it hides pre-action output while allowing shared work to finish into its original cache. Every newly committed human action starts nonblocking scored analysis at priority 2, including with Live Analysis off or no connected browser. The Trainer automatically selects its latest accepted decision and refreshes results on notifications and user-channel readiness. Matching interactive requests reuse automatic work without changing its submitted priority, and explicit failed-only Retry preserves the original reference, action, inputs, seeds and purpose. The live process also requests analysis after proving an uncertain human COMMIT accepted; rejected actions, rollback and duplicate acknowledgements schedule none. Restart introduces no durable analysis obligation or historical recovery sweep. See [M2 automatic-analysis evidence](docs/specs/m2-23-implementation.md).
