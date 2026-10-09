# Poker Playground

An authoritative local no-limit Texas Hold'em workspace. M1 includes continuing owned Table Sessions, complete Hold'em play, durable recovery, baseline Bots, between-Hand management, live synchronization, and authorized completed-Hand inspection. The Playground is the engineering interface defined in [the M1 spec](docs/specs/m1-playable-engine-server-playground.md).

## Local startup

Install Node.js 24 or newer, pnpm 11.25.0, and Docker Desktop (or an existing PostgreSQL 17 server). Start Docker Desktop, then from the repository root:

```powershell
docker compose up -d --wait
Copy-Item .env.example .env
pnpm install --frozen-lockfile
pnpm db:init
pnpm dev
```

On macOS/Linux use `cp .env.example .env` for the copy step. Open [the Playground](http://127.0.0.1:5173). Vite proxies `/api` to the Fastify server at `127.0.0.1:3001`, so cookies and requests use the same browser origin. Keep both development processes running. The PostgreSQL service listens only on `127.0.0.1:54329`; its named Docker volume survives process/container restarts.

For an existing PostgreSQL installation, create separate `poker` and `poker_test` databases and update `DATABASE_URL` and `TEST_DATABASE_URL` in `.env`. The server and database initialization scripts load the root `.env`; environment variables already supplied by the shell take precedence. Initialization is idempotent and also runs when the server starts.

The example database password is for local development. The identity is an opaque server-issued HttpOnly, SameSite=Strict cookie; retaining that browser cookie retains ownership after reload or server restart. Browser storage remembers the selected Table Session, but it does not establish permission. Clearing the identity cookie creates a different local user.

## Checks and compiled startup

```powershell
pnpm check
pnpm --filter @poker/server start
```

`pnpm check` typechecks all packages, runs public engine and real localhost HTTP/WebSocket/PostgreSQL tests, builds the server and Playground, and checks workspace dependency directions. Tests require `TEST_DATABASE_URL` and create/drop a uniquely named PostgreSQL schema per test file; they do not modify development Table Sessions. The compiled server includes its SQL initialization asset and can run with `pnpm --filter @poker/server start` after `pnpm build`.

The frontend development command is `pnpm --filter @poker/playground dev`; the backend command is `pnpm --filter @poker/server dev`. Stop development with Ctrl+C. To stop PostgreSQL while keeping its persisted data, use `docker compose stop`.

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
| `apps/playground` | React/Vite, TanStack Router/Query, Zustand, and Tailwind engineering UI. |

Browser code depends only on Contracts. The dependency check rejects authoritative package dependencies, and the Vite build independently rejects authoritative runtime imports, including relative imports. Engine does not depend on Strategies or Research; other authoritative packages do not depend back on Research.

## Creation protocol and persistence

`GET /api/identity` establishes the local identity. `POST /api/table-sessions` accepts `requestId`, optional observable `configuration` overrides, and optional Bot name/Playing Strategy intentions. It allocates one stable human Participant binding and the configured Bots without seating them. All hidden fields and supplied ownership/Participant identifiers are rejected. The baseline Policy is `uniform-choice/v1`, paired with `seeded-sampling/v1` or `highest-probability/v1`; each has empty configuration.

`GET /api/table-sessions` lists only the authenticated user's owned session identifiers. `GET /api/table-sessions/:id` restores or reads the committed game and returns a freshly mapped safe view with application-owned revisions and bindings.

Defaults are six seats, blinds 10/20, ante 0, minimum/default/maximum buy-in 1000, and seat changes enabled. Configuration is immutable. The server generates the hidden master seed. CashGame receives explicit trusted configuration; its version-1 record contains that configuration and accepted commands, without server revisions. A fresh session has zero accepted commands and both revisions at zero.

Each creation fingerprint uses SHA-256 of `create-table-v1:` followed by canonical JSON of request contents excluding `requestId`: object keys sort lexicographically, array order is retained, and JSON scalar representations are unchanged. The authenticated user and requestId identify the attempt. Session aggregate and small definitive acknowledgement/rejection commit together. Matching retries return original identifiers/bindings; different contents reject reuse. The Playground retains an unconfirmed attempt and has an explicit same-request retry; it never automatically retries creation.

Infrastructure failure is outside retained domain rejections. Unknown creation COMMIT returns `commit-outcome-unknown`; a durable attempt journal identifies it by authenticated user/requestId before a Table Session ID is available. Matching retries check that attempt's durable outcome instead of allocating a second seed, session, or binding set. Other users remain independent. See the recovery protocol below.

The durable aggregate contains the private poker record, owner, human-user binding, Bot controllers, version metadata, Admin Mode setting, and committed poker/session revisions. Ordinary responses are mapped field by field and omit owner identity, master seed, record metadata and commands. There is no Reset Table operation.

## Seating and atomic acceptance

`POST /api/table-sessions/:id/seat-participant` accepts `requestId`, `expectedPokerRevision`, a bound `participantId`, a one-based `seat`, and optional `buyIn`. Omission uses the configured default; minimum and maximum are inclusive. Participant identity belongs to the continuing game, independently of its Seat. The owner may seat its human or configured Bots. Unexpected fields, unassigned Participants, occupied/invalid seats, duplicate seating, and invalid buy-ins return structured rejections.

The shared `createTableSessionMutations` service serializes all poker mutations through one FIFO per session. Different sessions progress independently. It resolves a processed request and fingerprint before checking expected revision or executing a fork of the committed CashGame. Accepted commands, both revisions incremented once, and the small acknowledgement commit in one PostgreSQL transaction. Only confirmed commit promotes the game and revisions together; readers continue to see the committed view while a transaction is held. Definitive domain/application rejections are retained in `processed_requests` without advancing either revision or entering the poker record. PostgreSQL's primary key enforces unique `(table_session_id, request_id)` identity.

Mutation fingerprints use SHA-256 of UTF-8 `poker-mutation-v1:` followed by canonical JSON of `{ source, kind, contents }`, where `source` is `human` or `bot`, `kind` is the command name, and `contents` is the complete request body excluding `requestId`. Controller mutations use `controller-mutation-v1:` and `{ ownerUserId, kind, contents }`. Object keys sort lexicographically, arrays retain order, and scalars use JSON serialization. Expected revision and omitted versus explicit buy-in remain part of those contents. Matching retries return the original small outcome, even after later changes or a restart; changed contents reject requestId reuse. Current views are read separately and never stored inside an idempotent response.

Confirmed rollback discards the working fork without promoting its seats, stacks, commands, or revisions. Unknown COMMIT confirmation reports `commit-outcome-unknown` and pauses submissions to the affected session with `session-recovering`. The Playground retains the attempt, shows confirmed state, and offers an explicit outcome check.

The Engine's private `#mutate` path evaluates an isolated complete draft, checks seat/identity/chip conservation, and atomically replaces state with one accepted command. Live table chips are bounded by `Number.MAX_SAFE_INTEGER`; exact BigInt sums validate that bound without making valid empty configurations depend on occupancy. The bankroll is the current chip balance, not cumulative gross buy-ins. `fork()` copies state and accepted history without recording a command; `toRecord()` exports detached immutable version-1 replay inputs, and `fromRecord()` validates and replays the complete command sequence before returning a usable game. Private draft and PostgreSQL test hooks can cause controlled failures but expose no draft data or HTTP endpoint.

Engine records use `schemaVersion:1` and `engineVersion:'v1'`; the backend aggregate uses `schemaVersion:1`. Seed derivation, random source, deck order/shuffle, and selector sampling are explicitly documented in [random v1](docs/random-v1.md). Accepted Bot actions retain Strategy versions/configuration and evaluation/selection seeds in backend provenance. Restoration replays accepted concrete commands without evaluating Strategies again.

## Play, Bots, and inspection

Use the Playground to choose human/Bot seats and buy-ins, then explicitly Start Hand. Human controls contain only the current legal Fold/Check/Call and exact integer Bet-to/Raise-to totals. The engine handles multiway antes, reopening, all-ins, unmatched returns, main/side/split pots, showdown ranking and payouts. Between Hands, owners can move or cash out/reseat Participants, sit out/return, choose the next button, top up stacks, and rebuy a zero stack. Every next Hand requires an explicit Start Hand; reconnect and restart do not start one.

Bots evaluate immutable participant-safe inputs through the server's single JobRunner and submit valid selected actions back through the same mutation FIFO. Baseline Strategies are testing controls with no claim of poker expertise. Invalid, failed, incompatible, timed-out, or unsaved Bot work produces no implicit action. Owners can Retry the current decision or Save Playing Strategy. Assignment changes increment sessionRevision only; Retry and transient thinking/failure advance neither revision. The runner defaults to two active jobs, sixteen queued jobs and a ten-second logical timeout. Running work retains capacity until it actually settles; arbitrary CPU backends require an isolated execution adapter.

Admin Mode defaults on locally. Set `POKER_ADMIN_MODE=false` before starting the server to disable hidden-information reveal. An authenticated owner explicitly submits a completed Hand to `/api/table-sessions/:id/inspect-hand`; active/missing Hands and unauthorized callers are rejected. Server-only Research uses the same JobRunner to reconstruct that completed Hand's cards, deal and payout facts without changing gameplay. Inspection capability comes only from the current WebSocket connection, so a delayed HTTP/cache read cannot enable a previous server's Admin setting. The result is scoped to its requested completed Hand; normal participant views and Policy inputs remain unchanged.

## Unknown-commit recovery

Creation, poker, controller assignment, definitive rejection and Retry acknowledgements share a narrow real `pg` transaction boundary. Before target COMMIT, an independent bounded pool durably stores the attempt scope, versioned fingerprint, decimal xid8, and optional created Table Session hint. It stores no candidate cards, seed or game. The hint deliberately has no foreign key to a target's uncommitted row.

The resolver uses fresh primary READ COMMITTED statements: `pg_xact_status(xid8)` first, then a separate definitive outcome read. `in progress`, NULL, query failure, or a committed transaction without its matching outcome remain unresolved; absence of a request row alone never proves abort. A committed attempt reloads the game, both revisions, controllers/assignments and provenance together inside its existing FIFO, returns the original small outcome and publishes the current complete safe view. Only that session is paused; independent sessions continue.

An aborted ambiguous attempt retains a `commit-not-applied` tombstone. Checking its old requestId never executes it again, including after restart. The Playground offers Start a new attempt for deliberate human resubmission. Bot work receives a fresh evaluation identity after confirmed abort, and late pre-recovery work cannot submit. An ordinary failure before terminal COMMIT remains `persistence-unavailable` with no definitive outcome and preserves explicit same-ID retry behavior.

Startup loads recovery gates before restoring sessions or resuming Bots. HTTP reads, initial live snapshots and transient `table-status` feedback expose recovery while keeping last confirmed gameplay facts; status can change without a revision increment. A pre-close lifecycle gate invalidates waiting callbacks before HTTP drains. Test fixtures can hold actual terminal SQL on independently owned PostgreSQL clients through restart; production exposes no fault routes or engine mutation bypasses.

Run the real recovery checks with `pnpm test apps/server/test/recovery.test.ts`, or all checks with `pnpm check`. The isolated browser fixture is `apps/server/test/fixtures/recovery-browser.ts`; its stdin commands `hold-next`, `commit`, `rollback`, `restart`, and `stop` control real SQL/lifecycle timing. Start it with `pnpm exec tsx apps/server/test/fixtures/recovery-browser.ts` and `TEST_DATABASE_URL` set, then use Vite port 5185 with `POKER_API_TARGET=http://127.0.0.1:3015`. `stop` closes its owned resources and removes its unique schema. [M1-15 evidence](docs/specs/m1-15-implementation.md) records the combined browser flow and recovery checks.

## Live synchronization

`GET /api/table-sessions/:id/live` upgrades to WebSocket only for an authenticated Table Owner. The server binds the observer to that owner's human Participant independently of any client-supplied ParticipantId. On connection it sends the latest complete committed view with `tableSessionId`, `pokerRevision`, `sessionRevision`, safe controller bindings, and an empty `presentationEvents` array. Subsequent `table-update` messages publish complete views and explicitly projected events only after confirmed commit and promotion. Connections retain identity bindings rather than live CashGame or participant facade objects.

The Playground orders both HTTP reads and WebSocket snapshots by `sessionRevision` through the same React Query guard. Older and duplicate snapshots cannot replace newer gameplay facts or replay their events; a newer full view is sufficient across missing revisions. Reconnection uses the current complete view without replaying missed animations. Transient `table-status` messages carry thinking/failure/recovery feedback separately, so unchanged durable revisions do not hide that feedback. Lost COMMIT confirmation publishes a recovery status while preserving the last confirmed gameplay view.

The Playground shows live connection status and offers explicit disconnect/reconnect controls. Closing the live connection submits no poker command and leaves valid HTTP action controls available. Unexpected closure triggers automatic reconnection and a guarded HTTP refresh. Selecting another table closes the previous subscription. Presentation-event counts are engineering diagnostics; cards, stacks, pots, and actor come entirely from the latest complete view.

For concurrent local development, `POKER_API_TARGET` can override the Vite proxy target while a server's `PORT` and Vite's `--port` select separate listening ports. The real transport browser fault fixture and reproducible smoke command are documented in [M1-11 implementation evidence](docs/specs/m1-11-implementation.md).
