# Poker Playground

An authoritative local no-limit Texas Hold'em workspace. M1 is implemented in dependency-ordered tickets; the current foundation creates and reopens owned, persistent Table Sessions and seats their Participants atomically. The Playground is the engineering interface defined in [the M1 spec](docs/specs/m1-playable-engine-server-playground.md).

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

`pnpm check` typechecks all packages, runs public engine and real localhost HTTP/PostgreSQL tests, builds the server and Playground, and checks workspace dependency directions. Tests require `TEST_DATABASE_URL` and create/drop a uniquely named PostgreSQL schema per test file; they do not modify development Table Sessions. The compiled server includes its SQL initialization asset and can run with `pnpm --filter @poker/server start` after `pnpm build`.

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

`GET /api/identity` establishes the local identity. `POST /api/table-sessions` accepts `requestId`, optional observable `configuration` overrides, and optional Bot name/Playing Strategy intentions. It allocates one stable human Participant binding and the configured Bots without seating them. All hidden fields and supplied ownership/Participant identifiers are rejected. The baseline Strategy descriptors are `uniform-choice/v1` and `seeded-sampling/v1`, each with empty configuration.

`GET /api/table-sessions` lists only the authenticated user's owned session identifiers. `GET /api/table-sessions/:id` restores or reads the committed game and returns a freshly mapped safe view with application-owned revisions and bindings.

Defaults are six seats, blinds 10/20, ante 0, minimum/default/maximum buy-in 1000, and seat changes enabled. Configuration is immutable. The server generates the hidden master seed. CashGame receives explicit trusted configuration; its version-1 record contains that configuration and accepted commands, without server revisions. A fresh session has zero accepted commands and both revisions at zero.

Each creation fingerprint uses SHA-256 of `create-table-v1:` followed by canonical JSON of request contents excluding `requestId`: object keys sort lexicographically, array order is retained, and JSON scalar representations are unchanged. The authenticated user and requestId identify the attempt. Session aggregate and small definitive acknowledgement/rejection commit together. Matching retries return original identifiers/bindings; different contents reject reuse. The Playground retains an unconfirmed attempt and has an explicit same-request retry; it never automatically retries creation.

Infrastructure failure is outside retained domain rejections. If COMMIT acknowledgement is unknown, the server returns `commit-outcome-unknown` and retains that pending attempt in the running process; an absent definitive row cannot trigger its execution again. Full durable recovery/reconciliation belongs to the subsequent M1 recovery ticket. Test-only transaction hooks wrap the real PostgreSQL transaction before COMMIT and after its acknowledgement; no HTTP fault routes exist.

The durable aggregate contains the private poker record, owner, human-user binding, Bot controllers, version metadata, Admin Mode setting, and committed poker/session revisions. Ordinary responses are mapped field by field and omit owner identity, master seed, record metadata and commands. There is no Reset Table operation.

## Seating and atomic acceptance

`POST /api/table-sessions/:id/seat-participant` accepts `requestId`, `expectedPokerRevision`, a bound `participantId`, a one-based `seat`, and optional `buyIn`. Omission uses the configured default; minimum and maximum are inclusive. Participant identity belongs to the continuing game, independently of its Seat. The owner may seat its human or configured Bots. Unexpected fields, unassigned Participants, occupied/invalid seats, duplicate seating, and invalid buy-ins return structured rejections.

The shared `createTableSessionMutations` service serializes all poker mutations through one FIFO per session. Different sessions progress independently. It resolves a processed request and fingerprint before checking expected revision or executing a fork of the committed CashGame. Accepted commands, both revisions incremented once, and the small acknowledgement commit in one PostgreSQL transaction. Only confirmed commit promotes the game and revisions together; readers continue to see the committed view while a transaction is held. Definitive domain/application rejections are retained in `processed_requests` without advancing either revision or entering the poker record. PostgreSQL's primary key enforces unique `(table_session_id, request_id)` identity.

Mutation fingerprints use SHA-256 of UTF-8 `poker-mutation-v1:` followed by canonical JSON of `{ kind, contents }`, where `kind` is the route's command name and `contents` is the complete request body excluding `requestId`. Object keys sort lexicographically, arrays retain order, and scalars use JSON serialization. Expected revision and omitted versus explicit buy-in remain part of those contents. Matching retries return the original small outcome, even after later changes or a restart; changed contents reject requestId reuse. Current views are read separately and never stored inside an idempotent response.

Confirmed rollback discards the working fork without promoting its seats, stacks, commands, or revisions. Unknown COMMIT confirmation reports `commit-outcome-unknown` and pauses further submissions to that session with `session-recovering`; it never treats a missing row as proof of rollback or executes the request again blindly. Full durable reconciliation is the subsequent M1 recovery slice. The Playground retains an unconfirmed seating attempt, disables further mutations, and permits explicit matching retry when the session is not known to be paused.

The Engine's private `#mutate` path evaluates an isolated complete draft, checks seat/identity/chip conservation, and atomically replaces state with one accepted command. Live table chips are bounded by `Number.MAX_SAFE_INTEGER`; exact BigInt sums validate that bound without making valid empty configurations depend on occupancy. The bankroll is the current chip balance, not cumulative gross buy-ins. `fork()` copies state and accepted history without recording a command; `toRecord()` exports detached immutable version-1 replay inputs, and `fromRecord()` validates and replays the complete command sequence before returning a usable game. Private draft and PostgreSQL test hooks can cause controlled failures but expose no draft data or HTTP endpoint.

Future commands extend the Engine command/replay dispatch and private state, and the server's command validation/execution inside this acceptance service. They reuse the same queue, retained outcomes, transaction, revision update, and promotion rules.
