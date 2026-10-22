---
status: accepted
---

# Use Embedded PostgreSQL for Local Development and Tests

Standard local development and tests use a real PostgreSQL server supplied by the `embedded-postgres` package's platform binaries, replacing Docker configuration and documentation so that a container runtime is no longer a prerequisite. The application continues to connect through a configurable `DATABASE_URL`, allowing externally hosted PostgreSQL such as Neon without making local process management part of the application's database interface. Neon is the intended database provider for future deployment; choosing it does not introduce public application hosting, accounts, or multiple backend processes into the current local scope of [ADR-0013](0013-use-an-authoritative-server-from-m1.md).

## Agreed workflow

The root `pnpm dev`, `pnpm dev:playground`, `pnpm test`, and `pnpm db:init` commands automatically manage the appropriate local database when needed. `pnpm check` inherits test database management through its test step. Provide a managed test-database wrapper for ad hoc browser fixtures. First use requires dependency installation followed by the development command, without requiring an `.env` file or a separate database initialization step. Compiled server startup continues to require a configured database URL and does not start embedded PostgreSQL.

Persistent development data lives in a Git-ignored `.local/postgres` directory within each checkout. Resolve this directory relative to the checkout rather than the invoking shell's working directory. Development data survives command shutdown; ephemeral test data lives in the operating system's temporary directory.

An explicitly configured `DATABASE_URL` takes precedence over embedded development startup; an explicitly configured `TEST_DATABASE_URL` takes precedence over embedded test startup. A failed configured connection is an error, rather than a reason to silently switch databases. Neither mode starts or stops an externally configured database.

Each standard test invocation without an explicit `TEST_DATABASE_URL` owns a fresh PostgreSQL instance, a separate port, and a temporary data directory. Clean up the owned instance and directory after success or failure. Keep this lifecycle independent of persistent development data and retain the existing per-fixture PostgreSQL schema isolation.

If the configured development database port is occupied, fail with an actionable message and allow an explicit port override. Do not infer database ownership from a listening port or stop an unidentified process.

Support Windows, macOS, and Linux on architectures for which the package supplies binaries. Verify the implementation on Windows initially and assume compatibility on the other package-supported platforms without claiming that they have been tested.

Pin `embedded-postgres` to `18.4.0-beta.17`, which supplies released PostgreSQL 18.4 binaries, and resolve its platform dependencies through the frozen lockfile. The prerelease label belongs to the wrapper package, not to the PostgreSQL server. Use PostgreSQL major 18 for future Neon compatibility validation.

Start with a fresh development database. Leave the existing temporary database under `.scratch/m2-runtime/data` untouched; do not import or remove its contents as part of this change.

Shut down owned database processes gracefully on Ctrl+C and handled errors, preserving development data and cleaning up temporary test data. Cleanup after crashes or forced termination is the developer's responsibility, supported by brief troubleshooting instructions. Do not implement a dedicated recovery command or automatically reset development data.

Retain the existing pre-release schema initialization policy rather than introducing migration tooling in this work. [ADR-0014](0014-allow-pre-release-record-breaking-changes.md) continues to govern record compatibility and requires a compatibility policy before real user data is treated as durable.
