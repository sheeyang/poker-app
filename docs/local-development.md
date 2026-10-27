# Local development

Install Node.js 24 or newer and pnpm 11.25.0. Run `pnpm install --frozen-lockfile`, then `pnpm dev:trainer`. The first dependency installation downloads the platform's PostgreSQL binaries. Keep optional dependencies and the approved package installation scripts enabled; neither a global PostgreSQL installation nor an `.env` file is required.

The pinned `embedded-postgres@18.4.0-beta.17` package supplies released PostgreSQL 18.4 binaries. Its prerelease suffix describes the Node package. Available platforms are Windows x64, macOS x64/arm64, and Linux x64/arm/arm64/ia32/ppc64. Windows is verified initially; the other available platforms are assumed compatible. Native Windows ARM64 is not supplied. On Unix, run as a normal unprivileged user, as required by PostgreSQL.

## Commands and ownership

| Command | Default database lifecycle |
| --- | --- |
| `pnpm dev:trainer` / `pnpm dev` | Start the persistent development database, API and Trainer at `127.0.0.1:5174`; gracefully stop the database when the command ends. |
| `pnpm db:init` | Start the development database, initialize the schema, then stop while retaining data. |
| `pnpm test [filters/options]` | Start a fresh test database on a separate port; stop and remove temporary data afterward. |
| `pnpm check` | Run the checks; its test step manages a fresh test database. |
| `pnpm db:with-test -- <command> [arguments]` | Run a browser fixture or other command against its own temporary test database. |
| `pnpm --filter @poker/server start` | Connect to a configured `DATABASE_URL`; never start a local database. |

`pnpm dev` starts all apps; `pnpm dev:trainer` selects the API and Trainer.
Vite proxies `/api`, including WebSocket traffic, to `http://127.0.0.1:3001`,
so browser cookies and requests use the Trainer's origin.

For separate frontend or backend development, use `pnpm --filter @poker/web dev`
or `pnpm --filter @poker/server dev`. The backend-only command requires an
already running database and a configured `DATABASE_URL`; use the root development
commands for automatic database management.

Development data is under `.local/postgres/data`, resolved relative to this checkout. Its parent holds the server log and command ownership file. The database binds only to `127.0.0.1`; its default port is 54329, configurable through `POKER_POSTGRES_PORT`. The default local database and credentials are `poker` / `poker` / `poker`, intended only for local development.

Test instances use separate operating-system temporary directories and ports. Existing fixtures continue to create isolated schemas within that database. Concurrent test invocations and development therefore have independent database lifecycles. Tests never fall back to the application's `DATABASE_URL`.

For a browser fixture, for example:

```powershell
pnpm db:with-test -- node --import tsx apps/server/test/fixtures/session-summary-browser.ts
```

Keep the wrapper running while using the fixture. Use the fixture's documented stop control or Ctrl+C to finish. Older implementation evidence names `TEST_DATABASE_URL` explicitly; the wrapper supplies that value automatically for the same fixture commands.

## Checks and compiled startup

```powershell
pnpm check
```

This typechecks scripts and packages, runs public engine and real localhost
HTTP/WebSocket/PostgreSQL tests, builds the server and Trainer, and checks
workspace dependency directions. To run only the recovery tests:

```powershell
pnpm test apps/server/test/recovery.test.ts
```

To run the compiled server, configure `DATABASE_URL` for an already running
database, then run:

```powershell
pnpm build
pnpm --filter @poker/server start
```

The build includes the SQL initialization asset. Compiled startup requires
`DATABASE_URL` and never starts embedded PostgreSQL.

## Server and proxy settings

Set `PORT` for the API listener and `POKER_API_TARGET` for the Vite proxy target.
Use Vite's `--port` option for another frontend port. Concurrent checkouts also
need distinct `POKER_POSTGRES_PORT` values when using managed development
databases.

Admin Mode defaults on locally. Set `POKER_ADMIN_MODE=false` before starting the
server to disable completed-Hand hidden-information reveal.

For a local check of the compiled hosted layout, set `SERVE_WEB=true`, build the
workspace, and start the compiled server with `DATABASE_URL` configured. `HOST`
defaults to `127.0.0.1`; hosted environments use `0.0.0.0`. `/healthz` reports a
live listener, while `/readyz` reports restored application readiness and its
deployment revision. Production mode enables Secure cookies and the direct
PostgreSQL authority guard; local HTTP checks should use development mode.

For the package map and dependency checks, see [workspace architecture](architecture.md).
For identity, endpoints, fingerprints, and recovery mechanics, see
[the server protocol reference](server-protocol.md).
For a hosted free preview, see the [Render and Neon deployment guide](deployment_guide.md).

## Recovery browser fixture

Start the isolated fixture in one terminal:

```powershell
pnpm db:with-test -- node --import tsx apps/server/test/fixtures/recovery-browser.ts
```

In a second PowerShell terminal, start the Trainer against that fixture:

```powershell
$env:POKER_API_TARGET = 'http://127.0.0.1:3015'
pnpm --filter @poker/web dev --port 5185
```

Open [the fixture Trainer](http://127.0.0.1:5185). The fixture's stdin accepts:

| Command | Effect |
| --- | --- |
| `hold-next` | Hold the next acceptance's terminal SQL and report lost confirmation. |
| `commit` / `rollback` | Resolve the held real PostgreSQL transaction. |
| `restart` | Restart the fixture server while retaining its isolated schema. |
| `restart-off` | Restart with Admin Mode disabled. |
| `stop` | Roll back any held transaction, close the fixture, and remove its schema. |

After `stop`, the wrapper stops PostgreSQL and removes its temporary data. Stop
Vite with Ctrl+C; remove the proxy override with `Remove-Item Env:POKER_API_TARGET`
before using that terminal for normal development. See
[M1-15 implementation evidence](specs/m1-15-implementation.md) for the combined
browser flow and recovery checks. These controls are fixture-only; production
exposes no fault routes or engine mutation bypasses.

## External PostgreSQL

An explicit `DATABASE_URL` bypasses embedded development startup. An explicit `TEST_DATABASE_URL` independently bypasses embedded test startup. The corresponding database must already exist and be reachable. Neither path creates, starts, stops, or resets an external database, and a connection error never triggers embedded fallback.

Set values in the shell or optionally in the root `.env`, using `.env.example` as a guide. Shell values take precedence. If an existing `.env` contains URLs for a previously stopped local database, remove those assignments to use automatic embedded startup. Unset unused URL variables rather than assigning empty strings.

The [deployment guide](deployment_guide.md) uses Neon for hosted previews. Keep its required TLS parameters in the supplied connection string. Validate the application's transaction-recovery behavior against a separate real Neon test project before release; hosting configuration does not establish a new schema migration policy. See [ADR-0027](adr/0027-use-embedded-postgresql-for-local-development-and-tests.md).

## Troubleshooting

- **Port already occupied:** stop the development command using it, or choose a different `POKER_POSTGRES_PORT`. A listening port never establishes ownership; the launcher does not take over an existing database.
- **Another command owns the data directory:** finish that command before starting another development command for this checkout. Different checkouts have separate development data but need different configured ports when run together.
- **Crash or forced terminal termination:** cleanup is manual. Check the recorded owner PID and PostgreSQL's `postmaster.pid` against running processes before removing a leftover ownership file. If PostgreSQL is still running, use its bundled `pg_ctl` tool with the exact data directory and `-m fast -w stop` to shut it down gracefully first. The launcher prints the bundled tool path. Do not delete the development data directory. Abandoned test directories are prefixed `poker-test-postgres-` in the OS temporary directory; remove one only after confirming its database has stopped. There is no recovery command or automatic crash cleanup.
- **Initialization or startup failure:** inspect the printed error and `.local/postgres/server.log` for development. Unsupported platforms, missing optional binary packages, or permission errors fail explicitly. Run dependency installation normally with its approved platform scripts; avoid elevated/root execution on Unix.

Normal Ctrl+C and handled errors shut down owned databases gracefully. Development data is retained. The previous task's `.scratch/m2-runtime/data` is separate and remains untouched. Existing pre-release schema initialization and record compatibility remain governed by [ADR-0014](adr/0014-allow-pre-release-record-breaking-changes.md).
