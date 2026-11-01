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

Admin Mode is never available at an Online Table, and ownership never transfers. Each human manages only their own Participant: they can sit down, change Seat, sit out, resume, top up, rebuy, Stand Up, and Leave Table. Sitting out and leaving requested during a Hand apply after it. Chips are free within the table's buy-in limits. Public hosting adds per-IP rate limits, a cap on tables with seated humans per Guest, limits on name length and characters, and a cap of 20 joined Participants per Online Table.

## Play timing

Every table uses server-owned Presentation Phases for the deal, street reveals, showdown, and payout. An Action Window opens only after the preceding phase ends. When a table has an Action Time Limit, a human's Action Deadline is exact: actions arriving after it are rejected, and the server submits the Timeout Action, which is scored as the human's own decision. Bots have no Action Deadline, so computation time is never cut short. Complete views carry the current schedule. Clients reveal already-received information at its phase timestamps and skip elapsed phases on reconnect. Animation, analysis, and client speed never alter a schedule.

A Practice Table deals each Hand explicitly, accepting Deal as soon as the payout phase ends. Its Action Time Limit is optional and off by default. A practice human who times out is not sat out, and Deal resumes a human who sat out by choice.

An Online Table always has an Action Time Limit and Automatic Dealing. After the payout phase and the pause between Hands, a Next-Hand Countdown starts the next Hand if at least two Eligible Participants remain, at least one of them human. Otherwise the countdown is cancelled, and a fresh one is announced once the condition holds again. A disconnected human stays in the current Hand, and their deadline continues. A timeout, or a disconnection still in effect when the countdown expires, sits the human out after the Hand; returning requires an explicit resume.

Active deadlines and schedules persist. After a restart, an Action Deadline that expired during the outage resolves as a Timeout Action exactly once before further actions are accepted. Recovery never duplicates Timeout Actions, payouts, or Hand starts. Fairer handling of Action Deadlines and Next-Hand Countdowns that expire during an outage belongs to M9 — Release preparation.

## Revisions to earlier decisions

- **[ADR-0018](0018-wrap-poker-records-in-a-backend-aggregate.md).** Human decisions wait for reconnection only when the table has no Action Time Limit, and Online Tables deal automatically.
  - An Online Bot failure is retried once with the same inputs. If the retry also fails, the server submits the Timeout Action for the Bot, sits the Bot out after the Hand, and shows the failure to everyone at the table.
  - Practice Tables keep ADR-0018's Bot-failure policy.
- **[ADR-0025](0025-document-standard-cash-game-rules.md).** CashGame accepts seating during an active Hand. The newcomer is dealt in from the next Hand, because Hand participants remain frozen, and no missed-blind obligation applies. The engine's `leave-participant` command becomes `stand-up-participant`, matching Stand Up. CashGame also records when a Participant joins and leaves the table, because ADR-0017 makes it derive what each Participant has observed since joining. A joined Participant, seated or not, observes public facts from that point, including the rest of a Hand in progress.
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
