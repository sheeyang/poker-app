# Local development

Install Node.js 24 or newer and pnpm 11.25.0. Run `pnpm install --frozen-lockfile`, then `pnpm dev:playground`. The first dependency installation downloads the platform's PostgreSQL binaries. Keep optional dependencies and the approved package installation scripts enabled; neither a global PostgreSQL installation nor an `.env` file is required.

The pinned `embedded-postgres@18.4.0-beta.17` package supplies released PostgreSQL 18.4 binaries. Its prerelease suffix describes the Node package. Available platforms are Windows x64, macOS x64/arm64, and Linux x64/arm/arm64/ia32/ppc64. Windows is verified initially; the other available platforms are assumed compatible. Native Windows ARM64 is not supplied. On Unix, run as a normal unprivileged user, as required by PostgreSQL.

## Commands and ownership

| Command | Default database lifecycle |
| --- | --- |
| `pnpm dev:playground` / `pnpm dev` | Start the persistent development database before the apps; gracefully stop it when the command ends. |
| `pnpm db:init` | Start the development database, initialize the schema, then stop while retaining data. |
| `pnpm test [filters/options]` | Start a fresh test database on a separate port; stop and remove temporary data afterward. |
| `pnpm check` | Run the checks; its test step manages a fresh test database. |
| `pnpm db:with-test -- <command> [arguments]` | Run a browser fixture or other command against its own temporary test database. |
| `pnpm --filter @poker/server start` | Connect to a configured `DATABASE_URL`; never start a local database. |

Development data is under `.local/postgres/data`, resolved relative to this checkout. Its parent holds the server log and command ownership file. The database binds only to `127.0.0.1`; its default port is 54329, configurable through `POKER_POSTGRES_PORT`. The default local database and credentials are `poker` / `poker` / `poker`, intended only for local development.

Test instances use separate operating-system temporary directories and ports. Existing fixtures continue to create isolated schemas within that database. Concurrent test invocations and development therefore have independent database lifecycles. Tests never fall back to the application's `DATABASE_URL`.

For a browser fixture, for example:

```powershell
pnpm db:with-test -- node --import tsx apps/server/test/fixtures/session-summary-browser.ts
```

Keep the wrapper running while using the fixture. Use the fixture's documented stop control or Ctrl+C to finish. Older implementation evidence names `TEST_DATABASE_URL` explicitly; the wrapper supplies that value automatically for the same fixture commands.

## External PostgreSQL

An explicit `DATABASE_URL` bypasses embedded development startup. An explicit `TEST_DATABASE_URL` independently bypasses embedded test startup. The corresponding database must already exist and be reachable. Neither path creates, starts, stops, or resets an external database, and a connection error never triggers embedded fallback.

Set values in the shell or optionally in the root `.env`, using `.env.example` as a guide. Shell values take precedence. If an existing `.env` contains URLs for a previously stopped local database, remove those assignments to use automatic embedded startup. Unset unused URL variables rather than assigning empty strings.

Neon is the intended future deployed database provider. Keep its required TLS parameters in the supplied connection string. Validate the application's transaction-recovery behavior against a real Neon database before release; choosing the provider does not establish a production deployment or a new schema migration policy. See [ADR-0027](adr/0027-use-embedded-postgresql-for-local-development-and-tests.md).

## Troubleshooting

- **Port already occupied:** stop the development command using it, or choose a different `POKER_POSTGRES_PORT`. A listening port never establishes ownership; the launcher does not take over an existing database.
- **Another command owns the data directory:** finish that command before starting another development command for this checkout. Different checkouts have separate development data but need different configured ports when run together.
- **Crash or forced terminal termination:** cleanup is manual. Check the recorded owner PID and PostgreSQL's `postmaster.pid` against running processes before removing a leftover ownership file. If PostgreSQL is still running, use its bundled `pg_ctl` tool with the exact data directory and `-m fast -w stop` to shut it down gracefully first. The launcher prints the bundled tool path. Do not delete the development data directory. Abandoned test directories are prefixed `poker-test-postgres-` in the OS temporary directory; remove one only after confirming its database has stopped. There is no recovery command or automatic crash cleanup.
- **Initialization or startup failure:** inspect the printed error and `.local/postgres/server.log` for development. Unsupported platforms, missing optional binary packages, or permission errors fail explicitly. Run dependency installation normally with its approved platform scripts; avoid elevated/root execution on Unix.

Normal Ctrl+C and handled errors shut down owned databases gracefully. Development data is retained. The previous task's `.scratch/m2-runtime/data` is separate and remains untouched. Existing pre-release schema initialization and record compatibility remain governed by [ADR-0014](adr/0014-allow-pre-release-record-breaking-changes.md).
