# Poker Playground

An authoritative local no-limit Texas Hold'em workspace. M1 is implemented in dependency-ordered tickets; this foundation creates and reopens owned, persistent, empty Table Sessions. The Playground is the engineering interface defined in [the M1 spec](docs/specs/m1-playable-engine-server-playground.md).

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

`GET /api/table-sessions` lists only the authenticated user's owned session identifiers. `GET /api/table-sessions/:id` reconstructs a committed game and returns a freshly mapped safe view with application-owned revisions and bindings.

Defaults are six seats, blinds 10/20, ante 0, minimum/default/maximum buy-in 1000, and seat changes enabled. Configuration is immutable. The server generates the hidden master seed. CashGame receives explicit trusted configuration; its version-1 record contains that configuration and accepted commands, without server revisions. A fresh session has zero accepted commands and both revisions at zero.

Each creation fingerprint uses SHA-256 of `create-table-v1:` followed by canonical JSON of request contents excluding `requestId`: object keys sort lexicographically, array order is retained, and JSON scalar representations are unchanged. The authenticated user and requestId identify the attempt. Session aggregate and small definitive acknowledgement/rejection commit together. Matching retries return original identifiers/bindings; different contents reject reuse. The Playground retains an unconfirmed attempt and has an explicit same-request retry; it never automatically retries creation.

Infrastructure failure is outside retained domain rejections. If COMMIT acknowledgement is unknown, the server returns `commit-outcome-unknown` and retains that pending attempt in the running process; an absent definitive row cannot trigger its execution again. Full durable recovery/reconciliation belongs to the subsequent M1 recovery ticket. Test-only transaction hooks wrap the real PostgreSQL transaction before COMMIT and after its acknowledgement; no HTTP fault routes exist.

The durable aggregate contains the private poker record, owner, human-user binding, Bot controllers, version metadata, Admin Mode setting, and committed poker/session revisions. Ordinary responses are mapped field by field and omit owner identity, master seed, record metadata and commands. There is no Reset Table operation.
