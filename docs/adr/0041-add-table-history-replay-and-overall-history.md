---
status: accepted
---

# Add Table History, Replay, and Overall History

M6 lets a Guest study past play: replay completed Hands, reanalyze their own decisions under a chosen Strategy, compare Strategies on the same decision, and summarize scores across every table they have played. It builds on [ADR-0006](0006-treat-analysis-as-derived-data.md)'s derived analysis, [ADR-0021](0021-expose-authoritative-facts-through-cash-game.md)'s replay and counterfactual rules, and [ADR-0040](0040-cover-the-whole-table-session-in-observable-session-history.md)'s whole-session history. All of it is part of the Trainer; the Research Lab still begins with M11's simulations.

## Table History

- **It belongs to the table.** Table History is every completed Hand of a Table Session, at both table modes. Anyone who has been a Participant there may read all of it, read-only: after a Leave Table or Removal, Hands completed after they left included, and at a Closed Table. This replaces [ADR-0035](0035-close-idle-online-tables-and-load-tables-only-while-needed.md)'s "cannot be opened until replay arrives in M6": a Closed Table opens into its Table History, never into play.
- **Each viewer sees their participant-safe view**: public information for every Hand, plus their own hole cards and decisions in the Hands they were dealt. Hands they were not dealt into are replay-only, with no analysis.
- **Study outlasts play.** A former Participant may still request reanalysis, summaries and Counterfactual Comparisons of their own decisions after leaving and at a Closed Table. Analysis is derived data and never mutates the table. Closing a table blocks play, not study.
- **Hands carry the table-wide number** ("Hand 37"), the same for every viewer.
- **Each completed Hand records the server time it completed**, in the Persisted Table Session rather than the poker record. Hands completed before this change stay undated.

## Replay

- **Replay Steps** come before each decision (any actor's, the viewer seeing only public information for others), after each street reveal including every all-in runout street, and at the Hand's result. The engine's historical projection gains these post-transition points; the client never reconstructs them.
- **Motion.** Stepping forward plays that transition with M5's choreography, timed by the client, because replay has no server time to follow. Stepping back plays the same step's cues in reverse. Jumps, and steps back across a deal, render instantly. A new step input snaps any playing motion to its end state.
- **Table History is its own screen.** Opening it from a live table navigates away from play. If an Action Window opens for the viewer meanwhile, a persistent bar offers the way back; the Action Deadline never pauses. [ADR-0028](0028-introduce-the-product-trainer-interface.md)'s in-table review of the latest completed Hand remains and links into Table History.

## Trainer Configuration belongs to the Guest

- A Guest's Reference Strategy and Live Analysis setting form one Trainer Configuration, chosen once in their settings and used at every table, in review and in every summary. An Online Table's Allow Live Analysis can still refuse Live Analysis. This replaces ADR-0032's per-Participant configuration: a summary across tables needs one Strategy, and a per-table setting cannot supply it.
- Analysis already requested keeps the Strategy it captured. Changing the configuration refreshes the analysis panels in the Guest's other open tabs.
- Existing Guests start from the default configuration. Nothing recorded which table's configuration changed last, and [ADR-0014](0014-allow-pre-release-record-breaking-changes.md) allows the reset.
- Live Analysis defaults to on, as the code already does; [ADR-0026](0026-retain-numerical-trainer-analysis-independently-of-gameplay.md)'s "defaults to off" is amended.

## Counterfactual Comparison

- **Only the viewer's own decisions.** Their frozen participant-safe inputs are the only ones a viewer may supply. Opponents' and Bots' decisions are not reanalyzed.
- **The Reference Strategy is always the first column**, and up to 3 more of the supported Strategies may be added. The choice lives in the view's address only; it is never saved and never changes the Trainer Configuration.
- **It extends to summaries.** The same decision set can be summarized side by side under each compared Strategy.

## Overall History

- **Overall History** is every Table History a Guest can read, reached from a History tab beside Practice and Online. It lists only Hands the Guest was dealt into. Each table's Table History opens from the table and from its saved-tables row.
- **Filters**: street, Position, action type, table mode, completion date, the pot in big blinds before the decision, and Decision Score and Action Rank Score ranges. Non-score filters apply at once. A score filter waits until every analysis in the filtered set has succeeded, and until then shows the summary's Analyzing or Error state, so a partial result never passes as complete. A filtered decision opens at its Replay Step.
- **Breakdowns**: Score Summaries by one dimension at a time (street, Position, action taken, table mode), each a separate Score Summary over its declared decision set. Arbitrary combinations come from filtering first.
- **Bulk reanalysis** runs under a new `history-analysis` JobRunner purpose at priority 3; `simulation` moves to 4, below it. Each Guest has at most 8 `history-analysis` jobs outstanding, and the rest are submitted as those finish. This amends [ADR-0019](0019-route-computation-through-one-job-runner.md)'s purposes and priorities, and the per-Guest bound replaces its queue capacity for this purpose alone. Live and post-action analysis keep priorities 1–2. A progress count ("Analyzing 340 / 2,000") covers the whole set, and the summary stays complete only when every analysis has succeeded.
- **Score ranges narrow summaries too.** A Score Summary over a set with a score filter, and each of its buckets, waits for every analysis of the set the other filters admit under its own Strategy, then covers the decisions the ranges admit. Its decision count is unknown until then.
- **Progress travels on the user channel, and nothing polls ([ADR-0026](0026-retain-numerical-trainer-analysis-independently-of-gameplay.md)'s rule holds).** Every Score Summary request reports how many of its required analyses have succeeded, out of the total: an Overall History summary, the score-filtered list, and a table's Hand, Session and Table History summaries. While one is pending, its count is sent as a `progress` message on the Guest's user channel: at most one a second per Guest, the first change at once and later ones coalesced, carrying the latest running count of every pending request of theirs (`{ resource, requestId, succeeded, total }`) and nothing else. A Guest hears progress and notices for their own requests only. Progress is never stored, and a message carries counts, never results. Every request that publishes progress also publishes a completion or failure notice, so a panel can never wait on progress alone; results still refresh over HTTP after a notice, once on a reconnect, and when a Retry or a read shows the request pending again. The client ignores progress for a request held as complete or failed, and never lowers a pending count. The web app reads nothing on a timer.

## Privileged inspection is development-only

[ADR-0021](0021-expose-authoritative-facts-through-cash-game.md)'s Admin Mode reveal is not available in the hosted product, Practice Tables included. The inspect-Hand route stays server-only for development and tests, `POKER_ADMIN_MODE` defaults to off, and development runs turn it on. M6 builds no inspection screen. It returns as an admin capability when accounts exist, and that admin may then inspect Online Tables.

## Out of scope

Sharing replays, exporting or importing Hands, cross-device history (which waits for accounts), and notes or tags on Hands.
