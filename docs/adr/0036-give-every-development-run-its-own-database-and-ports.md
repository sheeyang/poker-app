---
status: accepted
---

# Give Every Development Run Its Own Database and Ports

[ADR-0027](0027-use-embedded-postgresql-for-local-development-and-tests.md) kept development data in `.local/postgres`, owned by one command at a time on fixed ports. A second run in the same checkout failed, and a crash left a lock that only manual cleanup cleared. Several agents and a person now run the app at once, often from one checkout.

## Decisions

- **Every development run owns a throwaway database**, started the way a test run's is: an operating-system temporary directory, a free port, removed on exit. Development data is no longer kept between runs. This supersedes ADR-0027's persistent `.local/postgres` data and its `POKER_POSTGRES_PORT` override.
- **Every development run picks free ports** for the API (`PORT`) and the Trainer (`POKER_WEB_PORT`), points the Vite proxy (`POKER_API_TARGET`) at that API, and prints both addresses. A value already set in the environment is kept.
- **Every run registers itself** in a shared folder of the operating-system temporary directory, with a heartbeat and a stop marker it watches. `pnpm dev:status` lists runs; `pnpm dev:stop` asks this checkout's runs (or one id, or `--all`) to take the Ctrl+C shutdown by writing the marker, because signals cannot do that on Windows. A record whose process is gone is a crashed run, and `dev:stop` stops its PostgreSQL and removes its directory. A run that has a process but no heartbeat is only reported, never removed.
- **An explicit `DATABASE_URL` still wins**, as ADR-0027 decided: the launcher then starts no database.

## Consequences

- Parallel runs, in one checkout or several, cannot collide on a database, a lock or a port.
- A run starts empty: a new Guest, no saved tables. Anything that needs data creates it.
- A crash leaves only that run's own database and directory, and `pnpm dev:stop` removes them.
