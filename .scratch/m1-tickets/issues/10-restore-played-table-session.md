# M1-10: Resume a played Table Session after server restart

## What to build

After playing and managing Participants across several Hands, the local user restarts the server and reopens the same Table Session. The server reconstructs the committed CashGame from seed and accepted commands, restores its application aggregate separately, and returns the same current safe view and legal next decision. No fresh game, duplicate setup, or earlier hidden-information leak is created.

M1 scope; apply accepted ADRs 0011, 0014–0018, 0021, 0025. This is a vertical slice of the playable foundation, not an invitation to implement later Trainer, product UX, replay tooling, Solver, or simulation milestones.

## Acceptance criteria

- [ ] Persist only replay-input poker records: version-1 schema/engine metadata, complete authoritative configuration, and ordered accepted commands covering setup, seating, leaving, movement, sitting out, top-ups, button changes, starts, and actions.
- [ ] Do not add durable live-engine snapshots, private mutable state, shuffled decks, derived Hand seeds, card traces, burns, RNG state, rejected commands, or events as another poker authority.
- [ ] fromRecord validates format/supported versions/configuration, reconstructs a temporary game by normal command semantics, checks complete final invariants, and returns complete success or structured restoration failure. Malformed or rejected suffixes never return a usable prefix.
- [ ] Successful restoration reproduces cards, stacks, contributions, derived pots, table/button/actor/street facts, HandId/DecisionId, accepted record, regenerated events, and deterministic continuation across future Hands.
- [ ] Restore committed pokerRevision/sessionRevision, ownership, human bindings, and controller descriptors from the backend aggregate without injecting revisions or Strategy concepts into CashGame. Restore accepted Bot actions directly as poker commands when that feature lands.
- [ ] ParticipantCashGame supplies immutable historical views at DecisionId using the original visible configuration/state/history. Join, absence, movement, leave/rejoin, and a new seat occupant preserve only the correct stable Participant's legally observed information.
- [ ] Later showdown or privileged reveals cannot change original decision snapshots, and historical input does not contain backend revisions, hidden configuration, unrevealed cards, raw events, or game/facade objects.
- [ ] The Playground can reopen an existing owned session and displays the confirmed current state after restart, including an unchanged human decision or between-Hand state; no Reset Table or automatic next-Hand start is introduced.
- [ ] Public engine tests round-trip complete multi-Hand sequences using the commands currently delivered, compare current/historical snapshots and subsequent deterministic continuation, verify detached/immutable records and forks, and reject malformed metadata/configuration/commands without a usable prefix. New poker behaviors extend this same record/restoration test harness in their own tickets.
- [ ] Real PostgreSQL-backed restart tests verify the exact durable aggregate, identity bindings and revisions, authorization on reopen, rejected-record handling, safe serialized current view, and continuing normal play/top-up/new explicit Hands after restoration. At this slice, use accepted seating/management and heads-up fold sequences; later action slices add their replay fixtures as they land. Pre-release compatibility changes need no old-version replay or migration guarantee.

## Blocked by

- Draft ticket 04: Manage seats, button, top-ups, and rebuys between Hands.

