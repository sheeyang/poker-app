---
status: accepted
---

# Cover the Whole Table Session in Observable Session History

[ADR-0017](0017-bind-observability-with-participant-cash-game.md) and [ADR-0032](0032-extend-table-sessions-for-shared-online-play.md) start a Participant's Observable Session History when they join, so two Participants at one table hold different histories. M6's Table History has to show every completed Hand to anyone who has been at the table, so that boundary would leave Table History and Observable Session History disagreeing. We now give every Participant the whole Table Session's history instead: public information for every Hand, Hands from before they joined included, plus their own hole cards in the Hands they were dealt.

## Decisions

- **One public history per table.** Every Participant, player or Bot, sees the same public history of every Hand, whenever they joined. Only their own hole cards differ.
- **Policies read it too.** A Bot that joins late, and every Reference Strategy evaluation, gets the whole session's history, which is the same history the Trainer shows.
- **Someone who joins mid-Hand** sees that Hand's earlier public actions.
- **Nothing hidden becomes visible.** Unrevealed hole cards, burn cards and deck order stay hidden in every Hand. A showdown reveal is public in the Hand where it happened, and never exposes facts from earlier points in that Hand.

## Considered options

- **Keep the join-time boundary, and make Table History a separate wider projection.** Rejected because the Trainer would show a history that Policies and Participant Statistics cannot see, so the same table would carry two "histories".

## Consequences

- Supersedes the when-joined boundary in ADR-0017, in ADR-0032's joining rules, and in [ADR-0025](0025-document-standard-cash-game-rules.md)'s amendment. Stable Participant identity, participant-safe projection, and the rule that later reveals never expose earlier hidden facts all stand.
- M8's Participant Statistics are the same for every viewer of a Table Session.
- Every Reference Strategy Evaluation's frozen input changes, so cached analyses stop matching and are recomputed on the next request. [ADR-0014](0014-allow-pre-release-record-breaking-changes.md) allows this before release. Bot actions already recorded are replayed as accepted commands, never re-decided.
