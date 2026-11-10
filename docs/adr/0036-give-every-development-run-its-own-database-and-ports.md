---
status: accepted
---

# Give Every Development Run Its Own Database and Ports

[ADR-0027](0027-use-embedded-postgresql-for-local-development-and-tests.md) kept development data in `.local/postgres`, owned by one command at a time on fixed ports. A second run in the same checkout failed, and a crash left a lock that only manual cleanup cleared. Several agents and a person now run the app at once, often from one checkout.

## Decisions

- **Every development run owns a throwaway database**, started the way a test run's is: an operating-system temporary directory, a free port, removed on exit. Development data is no longer kept between runs. This supersedes ADR-0027's persistent `.local/postgres` data and its `POKER_POSTGRES_PORT` override.
- **Every development run picks free ports** for the API (`PORT`) and the Trainer (`POKER_WEB_PORT`), points the Vite proxy (`POKER_API_TARGET`) at that API, and prints both addresses. A value already set in the environment is kept.
- **An explicit `DATABASE_URL` still wins**, as ADR-0027 decided: the launcher then starts no database.

## Consequences

- Parallel runs, in one checkout or several, cannot collide on a database, a lock or a port.
- A run starts empty: a new Guest, no saved tables. Anything that needs data creates it.
- Nothing shared is left to recover after a crash except that run's own temporary directory.
