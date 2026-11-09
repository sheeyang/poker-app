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
| `GET /api/join-links/:token` | What the link shows: `ownerName`, the public `configuration` and `options`, `placesTaken` (of the table's 20 places, see `table-full` below), and whether the Guest `alreadyJoined`. 404 `invalid-join-link` for an unknown, malformed or replaced token. |
| `POST /api/join-links/:token/join` | Requires only `requestId`: the joiner has not seen the table, so there is no expected revision. Joins the Guest as one unseated Participant under their stored display name and returns `{ ok, tableSessionId, participantId, pokerRevision, sessionRevision }`. Joining again, with any request ID, returns the same Participant without another commit, and a Guest who left rejoins as that Participant under the original name. |

Join rejections: 404 `invalid-join-link`; 400 `display-name-required`; 409
`name-taken` (ignoring case, among all Participants of the table, Bots and departed
Participants included); 409 `table-full` (all 20 places are taken: by the joined humans, by
the Bots the owner has not removed, and by the Table Owner, whose place is held after they
leave so that they can always return); 403
`guest-removed` (the Table Owner removed this Guest: it also answers the preview, and holds for every Join Link the table has ever had); 409 `request-id-conflict`; 429 `rate-limited` (see [Public hosting safeguards](#public-hosting-safeguards)). Like creation, definitive rejections are
remembered per request ID, so retry with a new one after fixing the cause. A
Participant's name is fixed when they join. Joining is a CashGame `join-table`
command, so it advances both revisions and the Participant observes from that point.

All table paths below start with `/api/table-sessions`:

| Method and path | Request and result |
| --- | --- |
| `POST` to the base path | Refused with 409 `table-limit-reached` while the Guest owns 10 tables that each have a seated human (not remembered, see [Public hosting safeguards](#public-hosting-safeguards)); 429 `rate-limited` when the address is over its limit. Requires `requestId`; accepts optional `mode` (`practice`, the default, or `online`, fixed for the table's life), observable `configuration` overrides, `options` (`actionTimeLimitSeconds` of 15, 30 or 60, and `allowLiveAnalysis`) and `bots`, each with `name` and `playingStrategy`. An Online Table defaults to a 30 second limit and always has one; a Practice Table defaults to none (`null`). Both default to Live Analysis allowed. Creates the table and returns its Table Session ID and safe Participant bindings, without seats. At an Online Table the owner joins unseated, and every Participant name, Bots included, must differ ignoring case (`name-taken`). A table's limit is enforced through Action Deadlines (see [Play timing](#play-timing)). |
| `GET` to the base path | Returns `{ tables: [{ tableSessionId, mode, left?, seatCount, stakes, playState }] }`: the tables the Guest owns, even after leaving them, plus the tables where the Guest's Participant is joined. An owned table the Guest has left carries `left: true`. Each table's public facts come with it, so a table the Guest has left still shows them: `stakes` (`smallBlind`, `bigBlind`, `ante`) and `playState` (`status`, `completedHands` at the table, `seatedParticipants`, and `viewerStack` while the Guest's own Participant has a Seat). They are omitted only for a table that cannot be restored. |
| `POST /:id/rejoin-table` | Table Owner only: returns the owner to a table they left, without the Join Link, as the same Participant. Requires only `requestId`. Anyone else, left or not, receives 404 `not-found`; a Guest who left a table they do not own rejoins through its Join Link. Same outcome and rejections as a join, except that the owner's held place means the table is never full for them. |
| `GET /:id` | Returns the committed participant-safe view for the Guest's own Participant: `mode`, `options`, `viewerParticipantId` and `ownerParticipantId`, application-owned revisions, safe bindings, and that Participant's own `trainerConfiguration`. Only the Table Owner of an Online Table also receives its `joinToken`. At an Online Table `inspection.adminMode` is always `false`. |
| `POST /:id/seat-participant` | Requires `requestId`, `expectedPokerRevision`, a bound `participantId`, and a one-based `seat`; optional `buyIn` defaults to the configured amount. Buy-in limits are inclusive. |
| `POST /:id/set-sitting-out`, `/stand-up-participant`, `/leave-table` | Each requires `requestId`, `expectedPokerRevision` and a `participantId` (and `sittingOut` for the first). A human may name only their own Participant. Between Hands they apply at once. During a Hand they are recorded to apply after it and answer `{ ok, ..., afterHand: true }`, see [After-Hand requests](#after-hand-requests). `leave-table` stands the Participant up first if seated, then ends their membership: the table leaves their saved list (unless they own it) and a place is freed. Naming a Bot is 400 `participant-not-human`. A response without `afterHand` means the change has been applied. |
| `POST /:id/move-participant`, `/top-up-to` | Between Hands only: 400 `active-hand` during a Hand, and until its payout phase ends. They are never deferred. |
| `POST /:id/remove-participant` | Removal. Table Owner only (403 `table-owner-required` for anyone else, themselves included). Requires `requestId`, `expectedPokerRevision` and the `participantId` of a joined human. 400 `cannot-remove-owner` for the owner and `participant-not-human` for a Bot; 400 `participant-not-joined` for a human who has already left or been removed. Between Hands it applies at once: the Guest stands up (cashing out), leaves the table, and their membership becomes `removed`. During a Hand, seat or not, it is an After-Hand Request (`change: 'remove'`, answering `afterHand: true`) that applies when the payout phase ends, see [After-Hand requests](#after-hand-requests). A removed Guest can no longer read the table or join it again, through any Join Link; it leaves their saved list. |
| `POST /:id/replace-join-link` | Table Owner only, Online Tables only (400 `join-link-unavailable` at a Practice Table). Requires `requestId` and `expectedSessionRevision`. Stores a new token in the aggregate's `joinToken` in the same transaction, so the previous link stops resolving at once (404 `invalid-join-link`); the acknowledgement carries no link, the owner reads the new `joinToken` from the view (and the live update). Joined Participants are untouched. Rate limited, see [Public hosting safeguards](#public-hosting-safeguards). |
| `POST /:id/add-bot`, `/remove-bot` | Table Owner only, either mode, at any time. Add a Bot (seated at once, dealt in from the next Hand) or remove one (after a Hand in progress). See [Owner controls](#owner-controls-bots-and-table-options). |
| `POST /:id/set-table-options` | Table Owner only, Online Tables only, between Hands. Requires `requestId`, `expectedSessionRevision` and a non-empty partial `options` (`actionTimeLimitSeconds`, `allowLiveAnalysis`, `allowSeatChanges`). See [Owner controls](#owner-controls-bots-and-table-options) and [Allow Live Analysis](#allow-live-analysis). |
| `POST /:id/set-trainer-configuration` | Requires `requestId`, `expectedSessionRevision`, and a complete `trainerConfiguration` containing `referenceStrategy` and boolean `liveAnalysis`. Changes only the requesting Guest's own Participant. |
| `POST /:id/analysis` | Requires `decisionId`, the requesting Guest's own current or accepted decision (400 `decision-unavailable` otherwise), and an optional `live: true` that schedules it as Live Analysis. Returns the analysis state (see [ADR-0026](adr/0026-retain-numerical-trainer-analysis-independently-of-gameplay.md)). Analysis of the current decision before it is accepted is Live Analysis, `live` or not: 403 `live-analysis-disallowed` when its Action Window captured Allow Live Analysis as off. |
| `POST /:id/inspect-hand` | Accepts only `handId`; requires Table Ownership, a completed Hand, and enabled Admin Mode. Always 403 `unavailable-at-online-tables` at an Online Table. |
| `POST /:id/analysis/:requestId/retry` | Accepts an empty object. Reuses successful/active analysis or retries a failure with its original immutable inputs and seeds and a new execution attempt. This path ID identifies analysis work, not a poker mutation. |
| `POST /:id/start-hand` | Table Owner only, at Practice Tables only: 403 `unavailable-at-online-tables` at an Online Table, where the server deals (see [Automatic Dealing](#automatic-dealing-at-online-tables)). Accepted once the previous Hand's payout phase has ended (409 `payout-phase-not-ended` before), see [Play timing](#play-timing). |
| `POST /:id/retry-bot` | Table Owner only, at Practice Tables only: an Online Table retries a failed Bot decision itself, so the owner receives 403 `unavailable-at-online-tables` there. |
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
  Participant-naming kind, `leave-table` included. The one exception is the
  owner's Removal (`remove-participant`), which exists to name another human.
- Dealing (`start-hand`), `set-button`, adding and removing Bots, managing a Bot (seating,
  Stand Up, moving, sitting out, top-ups, `set-playing-strategy`, `retry-bot`),
  `set-table-options`, completed-Hand inspection, Removal and replacing the Join Link
  require Table Ownership. Other
  Participants receive 403 `table-owner-required`. At an Online Table Dealing and
  `set-button` are refused even to the owner (403 `unavailable-at-online-tables`):
  Automatic Dealing deals each Hand and moves the button.

At a Practice Table the owner is the only human, so neither applies there. Acting
for a Bot remains the definitive rejection 403 `actor-not-authorized`.

Analysis Results, scores and summaries belong to the Participant whose decisions
they analyze. Each one uses that Participant's own Reference Strategy, and only
that Participant's Human Controller can capture, read or retry it or receive its
`analysis-update`. Its inputs are the Participant's own observable view at the
original decision (`getView({ at })`), so later streets, showdown reveals and later
Hands never reach it. Responses carry no game view, cards, deck or master seed, only
the derived evaluation and selection seeds that reproduce them.

The Persisted Table Session is version 2. It records the table `mode`, and each
human binding's Guest, `membership` (`joined`, `left` or `removed`) and Trainer
configuration, the table `options`, an Online Table's `joinToken`, and the
`pendingChanges` (after-Hand requests, empty by default). Version-1 records load as Practice Tables whose human takes the
table-level Trainer configuration, and are rewritten at their next commit. Each version names one
format: a version-2 row that lacks part of it fails restoration (503 `record-restoration-failed`)
rather than receiving defaults ([ADR-0032](adr/0032-extend-table-sessions-for-shared-online-play.md)
on ADR-0014). The
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
[`validation.ts`](../apps/server/src/validation.ts),
[`permissions.ts`](../apps/server/src/permissions.ts) (who may ask for what) and
[`mutations.ts`](../apps/server/src/mutations.ts) for validation, and
[`rejections.ts`](../apps/server/src/rejections.ts) for the HTTP status of each rejection.

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
street dealt, and a 2 s `payout` phase when the Hand completes. At an Online
Table a 3 s `pause` phase, the pause between Hands of Automatic Dealing, follows
the payout. An all-in runout
is one accepted action, so it schedules the showdown, then every remaining
street, then the payout (and, online, the pause); a river showdown schedules the
showdown and the payout; a Hand won by folds has only the payout. For the showdown and the
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

Under the table's Action Time Limit (optional at a Practice Table, always present
at an Online Table), each human Action Window also carries its Action Deadline,
`deadlineAt` = `opensAt` plus the limit. Bot windows never have one. A human `act` that the
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
decisions the human misses in that Hand time out too. At a Practice Table the
human is never sat out, and the next Hand waits for their Deal. At an Online
Table the commit of each server-played Timeout Action also records a `sit-out`
after-Hand request for its Participant (see below), so they are sat out once
the Hand's payout phase ends, connected or not; resuming is their own
`set-sitting-out` to `false`. A deadline that expired while the server was down
plays its Timeout Action at startup, before any request is served.

### Allow Live Analysis

Allow Live Analysis (`options.allowLiveAnalysis`) is an Online Table option, on by
default, in every Participant's view. The owner changes it between Hands with
`set-table-options`. Each human Action Window captures it when it opens: a window
opened while it was off carries `liveAnalysisDisallowed: true`, persisted with the
schedule and kept through restarts. Live Analysis of that decision (any `analysis`
request for the current decision before it is accepted) is then refused with 403
`live-analysis-disallowed`, so a change applies from the next decision. Post-action
analysis is not affected: an accepted decision, a Timeout Action included, is still
analyzed automatically, scored, and counted in Hand and Session summaries. A Practice
Table keeps the option it was created with (on unless the creation request turned it off).

### After-Hand requests

A Hand lasts until its payout phase ends, not until its last decision. During it
([`after-hand.ts`](../apps/server/src/after-hand.ts)), a human's own `set-sitting-out`
(to `true`), `stand-up-participant` and `leave-table` (when seated) are not applied:
they are recorded in the Persisted Table Session as `pendingChanges`, one
`{ participantId, change }` per Participant (`sit-out`, `stand-up` or `leave-table`, and
the owner's Removal, `remove`),
and every complete view carries them, so everyone at the table sees "leaving after
this hand". Only the session revision advances; the acknowledgement carries
`afterHand: true`. A stronger request replaces a weaker pending one
(`sit-out` < `stand-up` < `leave-table` < `remove`, `afterHandRequestStrength` in contracts); a weaker or
equal request, with any request ID, changes nothing. An unseated Participant's
`leave-table` applies at once, as it needs no Seat. The owner's management of a Bot
is deferred the same way for two requests: `set-sitting-out` (to `true`) and
`remove-bot` for a seated Bot (see [Owner controls](#owner-controls-bots-and-table-options)).
Every other management during a Hand is refused (`active-hand`), and so are moves,
top-ups, Stand Up and resuming.

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

Removal is the strongest pending change (`sit-out` < `stand-up` < `leave-table` <
`remove`): a Guest's own later request to leave or stand up is acknowledged and changes
nothing, so nothing a Guest asks for undoes it. A Removal during a Hand waits for the
Hand whether or not the Guest is seated, and survives a restart like any pending change.
When it applies, the Guest stands up and leaves the table in the same commit as every
other pending change, and their binding becomes `removed` (the membership index follows
in that transaction).

A Guest whose Participant leaves or is removed receives one `table-membership-ended` live
message (`reason: 'left'` or `'removed'`) on their subscription, then no more updates for
that table.

### Owner controls: Bots and table options

The Table Owner fills and tunes the table without waiting for a pause, at either table
mode. None of this gives the owner any control over, or sight of, another human.

- **`POST /:id/add-bot`** adds a Bot at any time, even during a Hand. It is a poker
  mutation: `requestId`, `expectedPokerRevision`, `name`, `playingStrategy`, and optionally
  `seat` and `buyIn`. In one commit it binds a new Bot Participant and seats it (CashGame
  `seat-participant`) at the named open Seat, or the lowest open one, with the buy-in named
  (the table's default otherwise). Hand participants are frozen, so a Bot added during a
  Hand is dealt in from the next one, with no missed blind. The name follows the rules for
  every Participant's name, a Guest's display name included (trimmed, 1-20 letters, digits,
  spaces and basic punctuation, so no invisible character can disguise a taken name; Bots
  named at creation follow them too), and must differ from every other Participant's,
  ignoring case, departed ones included (409 `name-taken`); other rejections are 400
  `invalid-bot-name`, `unsupported-strategy`, `no-empty-seat` and CashGame's `invalid-buy-in`,
  `seat-occupied` and `invalid-seat`. An Online Table whose 20 places are all taken (see
  `table-full` under [Join Links](#join-links)) takes no more Bots: 409 `table-full`. A Guest
  who is not the owner receives 403 `table-owner-required`.
- **`POST /:id/remove-bot`** removes a Bot (`requestId`, `expectedPokerRevision`,
  `participantId`). The Bot stands up, cashing out, and leaves the table; its binding stays
  marked `removed` so its name stays taken and the Hands it played keep their names. A
  seated Bot is removed after a Hand in progress (an After-Hand Request, `change: 'remove'`,
  acknowledged with `afterHand: true`); a Bot without a Seat goes at once. Naming a human is
  refused (403 `not-your-participant`, 400 `participant-not-bot` for the owner's own
  Participant), and a removed Bot cannot be seated, managed, retuned or removed again (400
  `bot-removed`).
- The owner's other Bot management is the existing mutations, owner-only: `set-playing-strategy`
  (any time), `top-up-to` and `stand-up-participant` and resuming (between Hands), and
  `set-sitting-out`, which during a Hand is an After-Hand Request like a human's own. At an
  Online Table a Bot that sat out after a failure is resumed with `set-sitting-out: false`.
- **`POST /:id/set-table-options`** changes an Online Table's options between Hands. It is
  the application path (`configure`): `requestId`, `expectedSessionRevision` and
  `options`, a non-empty partial object of `actionTimeLimitSeconds` (15, 30 or 60),
  `allowLiveAnalysis` and `allowSeatChanges` (booleans). Anything else is 400
  `invalid-table-options`. Owner only (403 `table-owner-required`); 403
  `unavailable-at-practice-tables` at a Practice Table, which keeps the options it was
  created with; 400 `active-hand` while a Hand is played or its payout phase shown. An option
  set to its current value is acknowledged without a commit. `allowSeatChanges` is the one
  option CashGame owns: it runs the `set-seat-changes` command in the same transaction (one
  poker revision step, `seat-changes-changed` in the live update's `presentationEvents`), so the
  Observable Game Configuration always shows the current value; the others change the
  aggregate's `options` only. Every request advances the session revision once. Everyone at
  the table sees the new options in their next view and live update. Changing an option does
  not disturb a running Next-Hand Countdown: the Hand it deals uses the new Action Time Limit.
- **Who has left.** Every complete view lists `departedParticipantIds` once anyone has
  left: humans who left or were removed, and removed Bots. It is public and carries no reason.

### Automatic Dealing at Online Tables

An Online Table never accepts Deal: the server deals
([`automatic-dealing.ts`](../apps/server/src/automatic-dealing.ts)). An Eligible
Participant is seated with chips, not sitting out, and either a Bot or a connected
human. The table can deal while at least two Eligible Participants remain, at least
one of them human.

- **Announcing.** Between Hands, once the last Hand's payout phase and pause have
  ended and its after-Hand requests are applied, the server announces a Next-Hand
  Countdown if the table can deal: `schedule.nextHandCountdown` =
  `{ startsAt, endsAt, durationMs }`, 5 s. It is a committed schedule change (a
  session revision step, delivered as a complete `table-update`). Before the first
  Hand there is no pause, so the countdown is announced as soon as the table can
  deal. Otherwise none is announced, and any later commit or connection change that
  lets the table deal announces one.
- **Expiry.** When the countdown ends, eligibility is rechecked in one committed
  transition: every seated human who is not sitting out and is still disconnected
  is sat out (`set-sitting-out`), then the Hand starts if the table can still deal;
  otherwise the countdown is cancelled. A disconnect during the countdown does not
  cancel it. The deal schedules the Hand's deal phase and first Action Window like
  any Hand start. Nobody is resumed automatically: resuming is always the human's
  own request.
- **Request IDs.** The announcement is `countdown:<session revision>`, a deal
  `deal:<Hand ID>` (from the Hand sequence, such as `deal:hand-3`), and a
  cancellation `no-deal:<session revision>`, so timers, retries and restarts resolve
  to one outcome. As for Timeout Actions, only an attempt proven never to have
  committed retires its ID for `:2`, `:3`…, and work that could not be saved is
  tried again a second later.
- **Restarts.** A persisted countdown survives a restart. One that expired during
  the outage runs its recheck at startup, before any request is served; as every
  human then counts as disconnected, the seated humans are sat out and nothing is
  dealt (fairer outage handling belongs to M9).

**Connection status.** A human is connected while at least one live connection of
their Guest (`/api/live` subscription or the table socket) is subscribed to the
table. It is public and transient: never persisted, no revision. Every view of an
Online Table carries `connectedParticipantIds`, and each change is sent to everyone
subscribed as `{ type: 'table-presence', tableSessionId, connectedParticipantIds }`.
After a restart every human counts as disconnected until they reconnect. A human
who disconnects mid-Hand stays in it, and their Action Deadline keeps running.
Practice Tables have one human, so their views carry no connection status.

**Bot failures.** At an Online Table a failed Bot decision (a Strategy error or
timeout, an invalid action, or an action that could not be saved) is retried once with identical inputs and seeds. If the retry fails too, a
`table-status` with `phase: 'failed'` goes to everyone at the table, and the server
plays the Bot's Timeout Action (`timeout:<decisionId>`, source `server`), which also
records a `sit-out` after-Hand request for the Bot. The failure stays shown until
the Hand it happened in is over. The owner resumes the Bot with `set-sitting-out`.
Practice Tables keep explicit Retry and Playing Strategy recovery.

The Trainer estimates the server clock from `serverTime` (the least-delayed of
recent views), shows hole cards, each street, the opponents' hands at showdown
and the result from their phase's start, enables Deal when the payout phase
ends, and enables action controls only inside its own Action Window and before
its Action Deadline, whose countdown it shows to everyone. At an Online Table it
also shows the Next-Hand Countdown (or why none is running), who is disconnected,
pending sit-outs, a Return to play control and Bot failures. Elapsed phases are
skipped, and presentation never sends or delays a request.

Game Configuration defaults and seating rules are documented in
[ADR-0025](adr/0025-document-standard-cash-game-rules.md). Current Strategy defaults
and analysis behavior are documented in
[ADR-0026](adr/0026-retain-numerical-trainer-analysis-independently-of-gameplay.md)
and [Simple Heuristic](specs/simple-heuristic.md). Existing stored Strategies and
captured analyses retain their original descriptors.

## Public hosting safeguards

The hosted product is open to the public, so the server limits what one address and one
Guest can ask of it.


**Client addresses.** The `trustedProxies` server option (environment `TRUSTED_PROXIES`,
comma-separated addresses or CIDR ranges) names the reverse proxy in front of the server.
Forwarding headers such as `X-Forwarded-For` are believed only on a connection from one of
those addresses, and `request.ip` is then the client's address; from any other connection
they are ignored, so a client cannot choose its own address. With none named, no proxy is
trusted. The production stack names Caddy alone: `deploy/compose.yaml` gives Caddy a fixed
address on the Compose network and passes it as `TRUSTED_PROXIES`, and Caddy replaces any
`X-Forwarded-For` a client sends with the address it saw.

**Per-IP rate limits** ([`rate-limit.ts`](../apps/server/src/rate-limit.ts), the `rateLimits`
server option; environment `POKER_RATE_LIMITS`, on by default in production only). A sliding
window per kind and address; every request counts, whatever its outcome, and a refused
request is not recorded, so waiting out the stated time is always enough. Defaults, per
address and 10 minutes:

| Kind | Routes | Default limit |
| --- | --- | --- |
| `creation` | `POST /api/table-sessions` | 10 |
| `joining` | `POST /api/join-links/:token/join`, `POST /:id/rejoin-table` | 30 |
| `join-link-replacement` | `POST /:id/replace-join-link` | 10 |

A refusal is HTTP 429 with a `Retry-After` header (seconds) and
`{ ok: false, rejection: { code: 'rate-limited', message } }`; the message says how long
to wait. The limit is checked before authentication and is never remembered with a request ID.

**Tables per Guest.** Creation answers 409 `table-limit-reached` while the Guest owns 10
tables (`seatedTableLimit` in contracts) that each have at least one seated human, the owner
or another Guest. Tables without a seated human, such as an Online Table where everyone is
watching, do not count. The count follows the committed state of each loaded table, so
standing up or leaving frees a place at once and the limit survives a restart. It is judged
only for a creation that has not happened yet and the refusal is not remembered: retrying
a creation that succeeded returns its stored outcome, and the same request ID goes through
once a place is free.

## Request fingerprints

Fingerprints are SHA-256 hex digests of the UTF-8 prefix followed immediately by
canonical JSON:

| Request family | Prefix | Canonical JSON input | Attempt scope |
| --- | --- | --- | --- |
| Table creation | `create-table-v1:` | Complete request contents excluding `requestId` | Authenticated user and `requestId` |
| Joining through a Join Link | `join-table-v1:` | `{ userId }` | Table Session and `requestId` |
| The owner returning to their table | `rejoin-table-v1:` | `{ userId }` | Table Session and `requestId` |
| Applying after-Hand requests (server-initiated, request ID `after-hand:<session revision>`) | `after-hand-v1:` | `{ changes }`, the pending changes | Table Session and `requestId` |
| Automatic Dealing (server-initiated, request IDs `countdown:<session revision>`, `deal:<Hand ID>`, `no-deal:<session revision>`) | `next-hand-v2:` | `{ sessionRevision, step }`, where `step` is `announce`, or `expire` with `sittingOut` (the disconnected humans sat out) and `deal` | Table Session and `requestId` |
| Poker mutation (`add-bot` and `remove-bot` included) | `poker-mutation-v1:` | `{ source, kind, contents }` | Table Session and `requestId` |
| Controller, Trainer configuration, Join Link replacement or table options mutation | `controller-mutation-v2:` | `{ userId, kind, contents }`, where `userId` is the requesting Guest | Table Session and `requestId` |

For poker mutations, `source` is `human`, `bot`, or `server` for the scheduler's
own Timeout Actions (a human's, and an Online Bot's after its retry failed). `kind` is the command name;
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
capacity until it actually settles. Bot decisions have one more running slot that
no other work may use, and are admitted however full the queue is, so analysis
never delays or refuses one: a Bot decision never fails for capacity. Arbitrary CPU backends require an isolated
execution adapter because timers cannot preempt synchronous JavaScript.
[ADR-0019](adr/0019-route-computation-through-one-job-runner.md) defines scheduling,
immutable inputs, and result validity.

Inspection capability comes from the current WebSocket connection; a delayed
HTTP/cache read cannot enable a previous server's Admin setting. Completed-Hand
inspection uses Research through the same JobRunner. Its visibility boundaries
are defined in [ADR-0021](adr/0021-expose-authoritative-facts-through-cash-game.md).
