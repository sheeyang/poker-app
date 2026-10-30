# Host Production on One Oracle Always Free VM

Production must use only free tiers, never sleep or cold-start, and remain available after months without users. Free managed PostgreSQL suspends or pauses when idle, and Neon's suspension also ends the session advisory lock required by [ADR-0030](0030-handoff-hosted-authority-after-listener-readiness.md); free application platforms sleep, expire, or are not intended for production. Production therefore runs Caddy, the server, and PostgreSQL 18 under Docker Compose on one Oracle Always Free Ampere VM in `ap-singapore-1`. The account is upgraded to Pay As You Go to avoid idle-instance reclamation, and the VM stays within the Always Free allowance under a budget alert. This replaces [ADR-0027](0027-use-embedded-postgresql-for-local-development-and-tests.md)'s intent to use Neon and ADR-0030's premise of Render rolling replacement, while retaining ADR-0030's readiness gate and single-authority lock.

Production is always available but not durable. Table Sessions may be lost with the VM, and [ADR-0014](0014-allow-pre-release-record-breaking-changes.md) still governs record compatibility.

## Consequences

- The public hostname is a free DuckDNS subdomain. Changing it discards every browser's Table Ownership cookie.
- The Oracle home region cannot be changed.
- Docker is a production-only dependency; local development and tests remain Docker-free under ADR-0027.
