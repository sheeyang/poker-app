# Extend Table Sessions for Shared Online Play

[M4 — Shared gameplay foundation](../milestones.md#m4--shared-gameplay-foundation) opens the hosted product to the public and lets humans play each other. Every Table Session is created as either a Practice Table, where one human plays only against Bots, or an Online Table, which Guests join through its Join Link. The mode is fixed at creation and is never inferred from how many humans are seated. Practice keeps the existing Trainer flow, while Online Tables are always timed and automatically dealt. This replaces the earlier M4 plan of one manually provisioned Table Session with two secret per-Participant links. Accounts, lobbies, and matchmaking remain unscheduled.

ADR-0012's atomic CashGame operations and ADR-0017's participant-safe projections and historical visibility boundaries remain requirements. Presentation timing, deadlines, and scheduling belong to the server application, not to CashGame.

## Access and authority

A Guest is a browser identity with a display name, entered before the Guest first creates or joins a table. Anyone may create a table. Joining an Online Table makes the Guest an unseated Participant who observes only public table information. Its Observable Session History begins when the Guest joins, and the Guest takes an empty Seat when ready. A Participant's name is fixed when they join and is unique within the table, ignoring case. A returning Guest keeps the same Participant. Control requires being a Participant's Human Controller, which means its bound Guest. Controlling a Participant from more than one device waits for accounts.

Table Ownership manages table options and Bots. It never grants control over, management of, or private information about another human Participant. At an Online Table the owner can do the following:

- Change the Action Time Limit length, Allow Live Analysis, and seat-change permission between Hands.
- Manage Bots, including their Playing Strategies and stacks.
- Replace the Join Link.
- Remove a human. Removal applies after any current Hand and prevents that Guest from joining again.

Admin Mode is never available at an Online Table, and ownership never transfers. Each human manages only their own Participant: they can sit down, change Seat, sit out, resume, top up, rebuy, Stand Up, and Leave Table. Sitting out and leaving requested during a Hand apply after it. Chips are free within the table's buy-in limits. Public hosting adds per-IP rate limits, a cap on tables with seated humans per Guest, limits on name length and characters, and a cap of 20 Participants per Online Table. The cap counts Bots, since a Participant is a human or Bot. One of the 20 places stays held for a Table Owner who has left, so they can always return from their saved tables to manage the table. Bot names follow the same name rules as Guests' display names.

## Play timing

Every table uses server-owned Presentation Phases for the deal, street reveals, showdown, and payout. An Action Window opens only after the preceding phase ends. When a table has an Action Time Limit, a human's Action Deadline is exact: actions arriving after it are rejected, and the server submits the Timeout Action, which is scored as the human's own decision. Bots have no Action Deadline, so computation time is never cut short. Complete views carry the current schedule. Clients reveal already-received information at its phase timestamps and skip elapsed phases on reconnect. Animation, analysis, and client speed never alter a schedule.

A Practice Table deals each Hand explicitly, accepting Deal as soon as the payout phase ends. Its Action Time Limit is optional and off by default. A practice human who times out is not sat out, and Deal resumes a human who sat out by choice.

An Online Table always has an Action Time Limit and Automatic Dealing. After the payout phase and the pause between Hands, a Next-Hand Countdown starts the next Hand if at least two Eligible Participants remain, at least one of them human. Otherwise the countdown is cancelled, and a fresh one is announced once the condition holds again. A disconnected human stays in the current Hand, and their deadline continues. A timeout, or a disconnection still in effect when the countdown expires, sits the human out after the Hand; returning requires an explicit resume.

Active deadlines and schedules persist. After a restart, an Action Deadline that expired during the outage resolves as a Timeout Action exactly once before further actions are accepted. Recovery never duplicates Timeout Actions, payouts, or Hand starts. Fairer handling of Action Deadlines and Next-Hand Countdowns that expire during an outage belongs to M9 — Release preparation.

Two details of these rules are accepted as built:

- **The table cap counts loaded tables.** The cap of 10 owned tables with a seated human is computed from the tables the server has loaded. Every table loads at startup, and the membership index holds no seating, so this is the current committed state of every restorable table. A table that cannot be restored does not count.
- **The Next-Hand Countdown is a 5-second server constant.** It is announced only when the table can deal: after the payout phase, the 3-second pause and the after-Hand transition, and only while at least two Eligible Participants, one of them human, remain. Each announced countdown records the duration used, as Presentation Phases do.

## Revisions to earlier decisions

- **[ADR-0018](0018-wrap-poker-records-in-a-backend-aggregate.md).** Human decisions wait for reconnection only when the table has no Action Time Limit, and Online Tables deal automatically.
  - An Online Bot failure is retried once with the same inputs. If the retry also fails, the server submits the Timeout Action for the Bot, sits the Bot out after the Hand, and shows the failure to everyone at the table.
  - Practice Tables keep ADR-0018's Bot-failure policy.
  - **Revisions count committed transitions, not commands.** `pokerRevision` advances once for each committed poker transition, and some transitions hold several accepted CashGameCommands. Deal with the dealing human's resume, Stand Up then Leave Table (and Removal), the one after-Hand transition that applies every pending request, and a countdown expiry that sits out disconnected humans and then deals each commit together. Each is one step, so no client sees a state in between and one expected revision covers it. `sessionRevision` still advances once per committed change. Creation records the commands it makes: an Online Table starts at poker revision 1 (the owner's join) and session revision 0.
  - **Joining carries no expected revision.** A join through a Join Link, and the owner's return to a table they left, carry a request ID but no `expectedPokerRevision`, because the joiner has not seen the table. Request idempotency is unchanged. The server judges the join against the table's current state (`table-full`, `name-taken`, `guest-removed`), and joining again returns the Guest's existing Participant.
- **[ADR-0025](0025-document-standard-cash-game-rules.md).** CashGame accepts seating during an active Hand. The newcomer is dealt in from the next Hand, because Hand participants remain frozen, and no missed-blind obligation applies. The engine's `leave-participant` command becomes `stand-up-participant`, matching Stand Up. CashGame also records when a Participant joins and leaves the table, through two accepted commands (`join-table`, `leave-table`), because ADR-0017 makes it derive what each Participant has observed since joining. This was agreed while preparing M4's spec.
  - A joined Participant, seated or not, observes public facts from that point. That includes the rest of a Hand in progress, and its result if they are still joined when it completes. Their Observable Session History holds only what they observed while joined.
  - Leaving requires being unseated, and ends observation until the Participant rejoins with the same ParticipantId. Hands played after they left are never shown to them.
  - Seating a Participant who has not joined joins them implicitly, which covers Bots and the Practice human. Hole cards stay visible only to the Participant dealt them, until the rules reveal them.
- **[ADR-0015](0015-persist-seed-and-accepted-commands.md).** The seat-change permission is the one part of the Game Configuration that can change during a Table Session's life. A between-Hands `set-seat-changes` command changes it through the same accepted-command path as everything else, so the record replays it and the Observable Game Configuration always shows the current value. All other Game Configuration stays fixed.
- **[ADR-0014](0014-allow-pre-release-record-breaking-changes.md) and [ADR-0015](0015-persist-seed-and-accepted-commands.md).** M4 upgrades version-1 records when they are loaded, although ADR-0014 would allow discarding them. This keeps local and current hosted tables working.
  - A version-1 Table Session Record's `leave-participant` commands replay as `stand-up-participant`, one for one, with each Participant joined from their first seating. Records written since are version 2 and replay only the new names.
  - A version-1 Persisted Table Session loads as a Practice Table whose human takes the table-level Trainer configuration. It is rewritten as version 2 at its next commit.
  - This is the only version-specific replay. Each schema version names exactly one format: version 2 is the format M4 ships. Rows written by M4 development builds before that format was complete are not upgraded, as ADR-0014 allows. ADR-0014 still governs pre-release breaks, and the release-readiness decision still owns the compatibility policy, so this adds no compatibility guarantee.
- **[ADR-0019](0019-route-computation-through-one-job-runner.md).** Analysis never delays actions, Action Deadlines or dealing, so Bot decisions get a reserved slot. The JobRunner keeps one running slot beyond its shared concurrency for Bot decisions alone, and admits them whatever its queue holds; a table has at most one outstanding Bot decision. Without this, analysis filling the runner would make an Online Bot's decision fail for capacity twice and end in its Timeout Action and an after-Hand sit-out. Every other purpose keeps the bounded concurrency, queue and capacity error.
- **[ADR-0026](0026-retain-numerical-trainer-analysis-independently-of-gameplay.md).** The Reference Strategy, Live Analysis setting, Analysis Results, scores, and summaries belong to a Participant, not a Table Session, in both modes. Analysis authorization follows the Human Controller instead of Table Ownership. An Online owner may disallow Live Analysis; the setting is visible to everyone at the table and takes effect from the next decision. Post-action analysis and scoring always continue.
- **[ADR-0028](0028-introduce-the-product-trainer-interface.md).** Server Presentation Phases replace immediate complete-view presentation as the gameplay pace, while complete views remain the recovery authority. A Session summary tab in the analysis panel replaces the explicit end-of-session action. It covers the viewer's decisions in completed Hands against their current Reference Strategy.

## Considered options

- **Inferring timed play from seated humans.** Rejected: a Table Session's timing would change whenever a human sat down or stood up, and Practice would need a separate path for checking whether another human was present.
- **Per-Participant secret links on manually provisioned tables.** Rejected for a public product. Join Links leave Seat choice to players.
- **Action Deadlines for Bots.** Rejected: computation time should not be penalized, and failures are handled separately.
- **A hidden grace period after Action Deadlines.** Rejected so that the published deadline remains the true one.

## Consequences

- A Guest who loses the browser identity also loses control of their Participants.
- Removal can be bypassed by clearing browser storage until accounts exist. M9 owns this together with backups, name moderation, idle-table cleanup, and outage fairness.
