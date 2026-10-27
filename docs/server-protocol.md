# Server protocol reference

Concrete request formats and recovery mechanics for the current local server.
Canonical request/response types live in
[`packages/contracts/src/index.ts`](../packages/contracts/src/index.ts);
routes live in [`apps/server/src/server.ts`](../apps/server/src/server.ts).
See [the workspace map](architecture.md) for package responsibilities and
[local development](local-development.md) for running the server and its fixtures.

## Identity and routes

`GET /api/identity` establishes an opaque server-issued `poker_local` cookie with
HttpOnly, SameSite=Strict, and path `/`. Retaining that cookie retains local
ownership after reload or server restart. Browser storage remembers the selected
Table Session but does not establish permission. Clearing the cookie creates a
different local user.

All table paths below start with `/api/table-sessions`:

| Method and path | Request and result |
| --- | --- |
| `POST` to the base path | Requires `requestId`; accepts optional observable `configuration` overrides and `bots`, each with `name` and `playingStrategy`. Returns the created Table Session ID and safe Participant bindings, without seating them. |
| `GET` to the base path | Lists only the authenticated user's owned Table Session identifiers. |
| `GET /:id` | Returns the committed participant-safe view, application-owned revisions, and safe bindings. |
| `POST /:id/seat-participant` | Requires `requestId`, `expectedPokerRevision`, a bound `participantId`, and a one-based `seat`; optional `buyIn` defaults to the configured amount. Buy-in limits are inclusive. |
| `POST /:id/set-trainer-configuration` | Requires `requestId`, `expectedSessionRevision`, and a complete `trainerConfiguration` containing `referenceStrategy` and boolean `liveAnalysis`. |
| `POST /:id/inspect-hand` | Accepts only `handId`; requires an authenticated owner, a completed Hand, and enabled Admin Mode. |
| `POST /:id/analysis/:requestId/retry` | Accepts an empty object. Reuses successful/active analysis or retries a failure with its original immutable inputs and seeds and a new execution attempt. This path ID identifies analysis work, not a poker mutation. |
| `GET /:id/live` | Earlier table-specific WebSocket endpoint, retained for existing transport consumers. |

Creation rejects hidden or unknown configuration fields and supplied
ownership/Participant identifiers. Seating rejects unexpected fields, unassigned
Participants, occupied/invalid seats, duplicate seating, and invalid buy-ins. See
[`validation.ts`](../apps/server/src/validation.ts) and
[`mutations.ts`](../apps/server/src/mutations.ts) for validation.

The Trainer uses the authenticated `GET /api/live` WebSocket with typed
`subscribe-table` and `unsubscribe-table` messages. Its full-view envelopes,
subscription authorization, revision ordering, status messages, and reconnect
rules are defined in [ADR-0017](adr/0017-bind-observability-with-participant-cash-game.md).

Game Configuration defaults and seating rules are documented in
[ADR-0025](adr/0025-document-standard-cash-game-rules.md). Current Strategy defaults
and analysis behavior are documented in
[ADR-0026](adr/0026-retain-numerical-trainer-analysis-independently-of-gameplay.md)
and [Simple Heuristic](specs/simple-heuristic.md). Existing stored Strategies and
captured analyses retain their original descriptors.

## Request fingerprints

Fingerprints are SHA-256 hex digests of the UTF-8 prefix followed immediately by
canonical JSON:

| Request family | Prefix | Canonical JSON input | Attempt scope |
| --- | --- | --- | --- |
| Table creation | `create-table-v1:` | Complete request contents excluding `requestId` | Authenticated user and `requestId` |
| Poker mutation | `poker-mutation-v1:` | `{ source, kind, contents }` | Table Session and `requestId` |
| Controller or Trainer configuration mutation | `controller-mutation-v1:` | `{ ownerUserId, kind, contents }` | Table Session and `requestId` |

For poker mutations, `source` is `human` or `bot`. `kind` is the command name;
`contents` is the complete request body excluding `requestId`. Expected revisions
and omitted versus explicit `buyIn` therefore affect the fingerprint.

[`canonical.ts`](../apps/server/src/canonical.ts) sorts object keys
lexicographically, preserves array order, and uses JSON serialization for scalars.
Creation and mutation callers are in
[`creation.ts`](../apps/server/src/creation.ts) and
[`mutations.ts`](../apps/server/src/mutations.ts).

Matching retries return the original small outcome; changed contents return
`request-id-conflict`. Current views are read separately. The acceptance,
revision, and retained-outcome rules are defined in
[ADR-0016](adr/0016-separate-semantic-and-durable-authority.md),
[ADR-0018](adr/0018-wrap-poker-records-in-a-backend-aggregate.md), and
[ADR-0020](adr/0020-remember-definitive-mutation-outcomes.md).

## Unknown-COMMIT resolution

[`AcceptanceTransactions`](../apps/server/src/db/acceptance.ts) wraps creation,
poker mutations, controller changes, definitive rejections, and Bot Retry
acknowledgements in real `pg` transactions. Before target COMMIT, an independent
bounded pool writes an `acceptance_attempts` journal entry containing attempt
scope, versioned fingerprint, decimal `xid8`, and an optional created Table Session
hint. It stores no candidate cards, seed, or game; the hint has no foreign key to
the target's uncommitted row.

Resolution uses a fresh primary READ COMMITTED `pg_xact_status(xid8)` statement,
followed by a separate definitive-outcome read:

- `committed`: require the matching stored outcome. For an existing Table Session,
  reload the game, both revisions, controllers, and provenance together inside
  its existing FIFO, then publish the current complete safe view.
- `aborted`: retain a `noncommit` journal tombstone and return `commit-not-applied`.
  Checking that old request ID never executes the attempt again, including after
  restart. Deliberate resubmission requires a new request ID; Bot orchestration
  creates a fresh evaluation identity.
- `in progress`, NULL, query failure, or a committed transaction with no matching
  outcome: remain unresolved. An absent processed-request row alone never proves
  abort.

Lost COMMIT confirmation reports `commit-outcome-unknown`; the affected Table
Session pauses submissions with `session-recovering`. Creation is scoped by user
and request ID before a Table Session ID is known, and unresolved creation gates
further creation for that user. Other users and independent Table Sessions can
continue. An ordinary pre-COMMIT failure reports `persistence-unavailable` with no
definitive outcome and preserves explicit same-ID retry behavior.

Startup loads recovery gates before restoring sessions or resuming Bots. HTTP
reads, initial live snapshots, and transient `table-status` feedback expose
recovery while preserving confirmed gameplay facts. Shutdown invalidates waiting
callbacks before HTTP drains. See
[M1-15 implementation evidence](specs/m1-15-implementation.md) for the recovery
verification and [local development](local-development.md#recovery-browser-fixture)
for the fixture recipe.

## Computation and inspection

The [JobRunner](../apps/server/src/job-runner.ts) defaults to two active jobs,
sixteen queued jobs, and a ten-second logical timeout. Running work retains
capacity until it actually settles. Arbitrary CPU backends require an isolated
execution adapter because timers cannot preempt synchronous JavaScript.
[ADR-0019](adr/0019-route-computation-through-one-job-runner.md) defines scheduling,
immutable inputs, and result validity.

Inspection capability comes from the current WebSocket connection; a delayed
HTTP/cache read cannot enable a previous server's Admin setting. Completed-Hand
inspection uses Research through the same JobRunner. Its visibility boundaries
are defined in [ADR-0021](adr/0021-expose-authoritative-facts-through-cash-game.md).
