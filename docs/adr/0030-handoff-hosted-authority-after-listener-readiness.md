# Hand Off Hosted Authority After Listener Readiness

This extends the initial local-only scope of [ADR-0013](0013-use-an-authoritative-server-from-m1.md) and [ADR-0027](0027-use-embedded-postgresql-for-local-development-and-tests.md) to a hosted Trainer preview without introducing accounts or shared multiplayer.

The free Render service uses rolling replacement, while ADR-0016 permits one authoritative server process. Bind a gated listener first and report liveness at `/healthz`, then acquire one direct PostgreSQL session advisory lock before schema initialization, recovery, or Bot startup; expose `/readyz` and application routes only after restoration. This permits Render to retire the old process without changing the service URL or ownership cookies, accepting a brief interruption instead of introducing active-active game coordination or paid hosting.

Retain the lock until application shutdown has stopped queues and jobs, and stop on loss of its connection. The release workflow must check both the requested commit and application readiness after Render reports a live listener. This coordinates ordinary deployments and maintenance; it does not establish distributed failover or partition fencing. Startup failure after routing can interrupt availability, and rollback must not assume backwards-compatible records under ADR-0014.
