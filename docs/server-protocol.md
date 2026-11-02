# Server protocol reference

Concrete request formats and recovery mechanics for the current local server.
Canonical request/response types live in
[`packages/contracts/src/index.ts`](../packages/contracts/src/index.ts);
routes live in [`apps/server/src/server.ts`](../apps/server/src/server.ts).
See [the workspace map](architecture.md) for package responsibilities and
[local development](local-development.md) for running the server and its fixtures.

Hosted entrypoints expose `/healthz` for listener liveness and `/readyz` for
restored application readiness and the deployed Git revision. Application routes
return HTTP 503 during handoff; the frontend retains unresolved mutation attempts
on these transient failures. See
[ADR-0030](adr/0030-handoff-hosted-authority-after-listener-readiness.md) and the
[deployment guide](deployment_guide.md) for the hosted startup lifecycle.

## Identity and routes

`GET /api/identity` establishes an opaque server-issued `poker_local` cookie with
HttpOnly, SameSite=Strict, and path `/`. Retaining that cookie retains local
ownership after reload or server restart. Browser storage remembers the selected
Table Session but does not establish permission. Clearing the cookie creates a
different local user.

`GET /api/identity` also returns the Guest's `displayName` once set. `PUT
/api/display-name` with `{ displayName }` sets or edits it. Names are trimmed and
must be 1-20 characters of letters, digits, spaces and basic punctuation
(`. , ' - _ ! ? ( )`), with no control characters; otherwise the server answers
400 `invalid-display-name`. Table creation answers 400 `display-name-required`
until a name exists, and the human Participant takes the Guest's name at creation
and keeps it when the Guest later edits their name.

Joining an Online Table uses its Join Link, an unguessable token distinct from the
Table Session ID (32 random bytes, base64url, found through a unique index on the
aggregate's `joinToken`). The web Trainer opens it at `/join/:token`. Both routes
need an established Guest identity (401 otherwise):

| Method and path | Request and result |
| --- | --- |
| `GET /api/join-links/:token` | What the link shows: `ownerName`, the public `configuration` and `options`, `joinedCount`, and whether the Guest `alreadyJoined`. 404 `invalid-join-link` for an unknown, malformed or replaced token. |
| `POST /api/join-links/:token/join` | Requires only `requestId`: the joiner has not seen the table, so there is no expected revision. Joins the Guest as one unseated Participant under their stored display name and returns `{ ok, tableSessionId, participantId, pokerRevision, sessionRevision }`. Joining again, with any request ID, returns the same Participant without another commit, and a Guest who left rejoins as that Participant under the original name. |

Join rejections: 404 `invalid-join-link`; 400 `display-name-required`; 409
`name-taken` (ignoring case, among all Participants of the table, Bots and departed
Participants included); 409 `table-full` (20 joined human Participants); 403
`guest-removed`; 409 `request-id-conflict`. Like creation, definitive rejections are
remembered per request ID, so retry with a new one after fixing the cause. A
Participant's name is fixed when they join. Joining is a CashGame `join-table`
command, so it advances both revisions and the Participant observes from that point.

All table paths below start with `/api/table-sessions`:

| Method and path | Request and result |
| --- | --- |
| `POST` to the base path | Requires `requestId`; accepts optional `mode` (`practice`, the default, or `online`, fixed for the table's life), observable `configuration` overrides, `options` (`actionTimeLimitSeconds` of 15, 30 or 60, and `allowLiveAnalysis`) and `bots`, each with `name` and `playingStrategy`. An Online Table defaults to a 30 second limit and always has one; a Practice Table defaults to none (`null`). Both default to Live Analysis allowed. Creates the table and returns its Table Session ID and safe Participant bindings, without seats. At an Online Table the owner joins unseated, and every Participant name, Bots included, must differ ignoring case (`name-taken`). A Practice Table enforces its limit through Action Deadlines (see [Play timing](#play-timing)); an Online Table's limit is stored and shown only until Automatic Dealing enforces it. |
| `GET` to the base path | Returns `{ tables: [{ tableSessionId, mode, left? }] }`: the tables the Guest owns, even after leaving them, plus the tables where the Guest's Participant is joined. An owned table the Guest has left carries `left: true`. |
| `POST /:id/rejoin-table` | Table Owner only: returns the owner to a table they left, without the Join Link, as the same Participant. Requires only `requestId`. Anyone else, left or not, receives 404 `not-found`; a Guest who left a table they do not own rejoins through its Join Link. Same outcome and rejections as a join (`table-full` included). |
| `GET /:id` | Returns the committed participant-safe view for the Guest's own Participant: `mode`, `options`, `viewerParticipantId` and `ownerParticipantId`, application-owned revisions, safe bindings, and that Participant's own `trainerConfiguration`. Only the Table Owner of an Online Table also receives its `joinToken`. At an Online Table `inspection.adminMode` is always `false`. |
| `POST /:id/seat-participant` | Requires `requestId`, `expectedPokerRevision`, a bound `participantId`, and a one-based `seat`; optional `buyIn` defaults to the configured amount. Buy-in limits are inclusive. |
| `POST /:id/set-sitting-out`, `/stand-up-participant`, `/leave-table` | Each requires `requestId`, `expectedPokerRevision` and a `participantId` (and `sittingOut` for the first). A human may name only their own Participant. Between Hands they apply at once. During a Hand they are recorded to apply after it and answer `{ ok, ..., afterHand: true }`, see [After-Hand requests](#after-hand-requests). `leave-table` stands the Participant up first if seated, then ends their membership: the table leaves their saved list (unless they own it) and a place is freed. Naming a Bot is 400 `participant-not-human`. A response without `afterHand` means the change has been applied. |
| `POST /:id/move-participant`, `/top-up-to` | Between Hands only: 400 `active-hand` during a Hand, and until its payout phase ends. They are never deferred. |
| `POST /:id/set-trainer-configuration` | Requires `requestId`, `expectedSessionRevision`, and a complete `trainerConfiguration` containing `referenceStrategy` and boolean `liveAnalysis`. Changes only the requesting Guest's own Participant. |
| `POST /:id/inspect-hand` | Accepts only `handId`; requires Table Ownership, a completed Hand, and enabled Admin Mode. Always 403 `unavailable-at-online-tables` at an Online Table. |
| `POST /:id/analysis/:requestId/retry` | Accepts an empty object. Reuses successful/active analysis or retries a failure with its original immutable inputs and seeds and a new execution attempt. This path ID identifies analysis work, not a poker mutation. |
| `POST /:id/start-hand` | Table Owner only, at Practice Tables only: 403 `unavailable-at-online-tables` at an Online Table, until Automatic Dealing exists. Accepted once the previous Hand's payout phase has ended (409 `payout-phase-not-ended` before), see [Play timing](#play-timing). |
| `GET /:id/live` | Earlier table-specific WebSocket endpoint, retained for existing transport consumers. |

## Authorization

Every table route and live subscription is authorized through the requesting
Guest's own human Participant, as its Human Controller. The Guest must be bound to
a joined Participant of that table, and must not have left or been removed. Every
view is projected for that Participant. Any other Guest receives the same 404
`not-found` as for a table that does not exist. Two requests are checked before
request idempotency, so a remembered outcome is replayed only to a requester
allowed to make that request:

- A request naming another human's Participant is rejected with 403
  `not-your-participant`, even from the Table Owner. This covers every
  Participant-naming kind, `leave-table` included.
- Dealing (`start-hand`), `set-button`, managing a Bot (seating, Stand Up, moving,
  sitting out, top-ups, `set-playing-strategy`, `retry-bot`) and completed-Hand
  inspection require Table Ownership. Other Participants receive 403
  `table-owner-required`.

At a Practice Table the owner is the only human, so neither applies there. Acting
for a Bot remains the definitive rejection 403 `actor-not-authorized`.

Analysis Results, scores and summaries belong to the Participant whose decisions
they analyze. Each one uses that Participant's own Reference Strategy, and only
that Participant's Human Controller can read or retry it or receive its
`analysis-update`.

The Persisted Table Session is version 2. It records the table `mode`, and each
human binding's Guest, `membership` (`joined`, `left` or `removed`) and Trainer
configuration, the table `options`, an Online Table's `joinToken`, and the
`pendingChanges` (after-Hand requests, empty by default). Version-1 records load as Practice Tables whose human takes the
table-level Trainer configuration, and are rewritten at their next commit. The
`table_memberships` index (Guest, table, Participant, status) is written in the
same transaction as every aggregate write that changes a membership (see
[`membership.ts`](../apps/server/src/membership.ts)). Startup backfills it for
version-1 records. It serves the saved-tables list and the authorization of
tables that are not yet loaded.

Creation rejects hidden or unknown configuration fields and supplied
ownership/Participant identifiers. Seating rejects unexpected fields, unassigned
Participants, occupied/invalid seats, duplicate seating, and invalid buy-ins.
Seating is accepted during an active Hand; the newcomer is dealt in from the
next Hand. See
[`validation.ts`](../apps/server/src/validation.ts) and
[`mutations.ts`](../apps/server/src/mutations.ts) for validation.

The Trainer uses the authenticated `GET /api/live` WebSocket with typed
`subscribe-table` and `unsubscribe-table` messages. Its full-view envelopes,
subscription authorization, revision ordering, status messages, and reconnect
rules are defined in [ADR-0017](adr/0017-bind-observability-with-participant-cash-game.md).

## Play timing

The server owns play timing ([ADR-0032](adr/0032-extend-table-sessions-for-shared-online-play.md)).
All of it reads one injectable clock, the `clock` server option
([`clock.ts`](../apps/server/src/clock.ts)), which defaults to system time.
Tests substitute a manually advanced clock.

Each accepted transition schedules its Presentation Phases
([`schedule.ts`](../apps/server/src/schedule.ts)), in the order of the
transition's events: a 1.5 s `deal` phase when a Hand starts, a 2 s `showdown`
phase when the remaining hands are turned up, a 1 s `street` phase for each
street dealt, and a 2 s `payout` phase when the Hand completes. An all-in runout
is one accepted action, so it schedules the showdown, then every remaining
street, then the payout; a river showdown schedules the showdown and the
payout; a Hand won by folds has only the payout. For the showdown and the
payout, `street` is the street the Hand had reached. Each phase starts when the
previous one ends, or at the commit. The schedule is persisted in the Persisted
Table Session in the same transaction as that commit; phases are never poker
commands. It holds the current Hand's phases (`kind`, `handId`, `street`,
`startsAt`, `endsAt`, `durationMs`) and the current decision's `actionWindow`
(`participantId`, `decisionId`, `opensAt`), which opens when the last phase ends.
Every complete view and `table-update` carries this `schedule` and the
`serverTime` at which it was produced, in milliseconds since the Unix epoch.
Once no betting decision remains, the view and update that arrive already hold
the complete result; the schedule says when each step of it is presented.

An `act` for the window's Participant received before `opensAt` is rejected with
409 `action-window-not-open`; a human request is judged by the time the server
received it. A `start-hand` (Deal) received before the latest Hand's payout phase
ends is rejected with 409 `payout-phase-not-ended`, and accepted from that
instant. At a Practice Table Deal also ends the dealing human's voluntary
sit-out, as `set-sitting-out` then `start-hand` in one commit (one revision
step); if the Hand cannot start, neither takes effect. A Bot's decision is
requested only once its window opens: the server wakes the table at `opensAt`
and at the end of the payout phase, including after a restart, which restores
the persisted schedule unchanged. A table written before scheduled play restores
its current decision with a window open since time 0, and has no payout phase to
wait for.

Under a Practice Table's Action Time Limit, each human Action Window also carries
its Action Deadline, `deadlineAt` = `opensAt` plus the limit. Bot windows never
have one, and an Online Table's limit is not enforced yet. A human `act` that the
server receives after `deadlineAt` is rejected with 409 `action-deadline-passed`,
both while the Timeout Action is still due and after it has applied (a late act
that expected the timed-out decision's revision); one received at `deadlineAt` is
on time and is never displaced. From the first millisecond after the deadline, the
server plays the Timeout Action: Check when it is legal, otherwise Fold, as an
ordinary accepted `act` for that Participant. Its request ID is
`timeout:<decisionId>`, and its fingerprint source is `server`, so timers,
retries and restarts resolve to one outcome. Only an attempt proven never to have
committed is followed by a further derived ID (`timeout:<decisionId>:2`, and so
on); one that could not be saved is tried again a second later. A Timeout Action
is the human's own decision: it starts automatic post-action analysis and counts
in Decision Scores, Action Rank Scores and Hand and Session summaries. Later
decisions the human misses in that Hand time out too. The human is never sat out,
and the next Hand waits for their Deal. A deadline that expired while the server
was down plays its Timeout Action at startup, before any request is served.

### After-Hand requests

A Hand lasts until its payout phase ends, not until its last decision. During it
([`after-hand.ts`](../apps/server/src/after-hand.ts)), a human's own `set-sitting-out`
(to `true`), `stand-up-participant` and `leave-table` (when seated) are not applied:
they are recorded in the Persisted Table Session as `pendingChanges`, one
`{ participantId, change }` per Participant (`sit-out`, `stand-up` or `leave-table`),
and every complete view carries them, so everyone at the table sees "leaving after
this hand". Only the session revision advances; the acknowledgement carries
`afterHand: true`. A stronger request replaces a weaker pending one
(`sit-out` < `stand-up` < `leave-table`, `changeStrength` in contracts); a weaker or
equal request, with any request ID, changes nothing. An unseated Participant's
`leave-table` applies at once, as it needs no Seat. A Bot's management during a Hand
is still refused (`active-hand`), and so are moves, top-ups and resuming.

When the latest Hand's payout phase ends, the server applies every pending change in
one committed transition: all the engine commands (Stand Up, sitting out, Leave Table)
and the cleared list commit together, as one poker revision step and one session
revision step, and a Leave Table also marks the binding `left`, which the membership
index follows in the same transaction. The step runs from the table's wake-up at the
end of the payout phase (including after a restart, for a Hand that ended during the
outage) and at the start of every human request, so a Deal can never be accepted
ahead of it. A Deal that arrives before the wake-up still finds the changes applied,
and names a poker revision they have made stale (409 `stale-poker-revision`). The
transition's request ID is derived from the session revision (`after-hand:<n>`), so
it applies once however often it is retried. The pause between Hands of Automatic
Dealing begins after this transition.

A Guest whose Participant leaves receives one `table-membership-ended` live message
(`reason: 'left'`; Removal will use `'removed'`) on their subscription, then no more
updates for that table.

The Trainer estimates the server clock from `serverTime` (the least-delayed of
recent views), shows hole cards, each street, the opponents' hands at showdown
and the result from their phase's start, enables Deal when the payout phase
ends, and enables action controls only inside its own Action Window and before
its Action Deadline, whose countdown it shows. Elapsed phases are skipped, and
presentation never sends or delays a request.

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
| Joining through a Join Link | `join-table-v1:` | `{ userId }` | Table Session and `requestId` |
| The owner returning to their table | `rejoin-table-v1:` | `{ userId }` | Table Session and `requestId` |
| Applying after-Hand requests (server-initiated, request ID `after-hand:<session revision>`) | `after-hand-v1:` | `{ changes }`, the pending changes | Table Session and `requestId` |
| Poker mutation | `poker-mutation-v1:` | `{ source, kind, contents }` | Table Session and `requestId` |
| Controller or Trainer configuration mutation | `controller-mutation-v2:` | `{ userId, kind, contents }`, where `userId` is the requesting Guest | Table Session and `requestId` |

For poker mutations, `source` is `human`, `bot`, or `server` for the scheduler's
own Timeout Actions. `kind` is the command name;
`contents` is the complete request body excluding `requestId`. Expected revisions
and omitted versus explicit `buyIn` therefore affect the fingerprint.

[`canonical.ts`](../apps/server/src/canonical.ts) sorts object keys
lexicographically, preserves array order, and uses JSON serialization for scalars.
Creation and mutation callers are in
[`creation.ts`](../apps/server/src/creation.ts) and
[`mutations.ts`](../apps/server/src/mutations.ts).

Matching retries return the original small outcome; changed contents return
`request-id-conflict`. Current views are read separately. Table request IDs are
scoped to the Table Session, so all of its Guests share them. A Guest who reuses
another Guest's request ID receives `request-id-conflict`, never that Guest's
outcome. The acceptance,
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
