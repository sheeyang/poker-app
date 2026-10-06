# M1-07: Play multiway Hands with antes and correct position

## What to build

The Table Owner configures a supported multiway table and the human plays the same Fold/Check/Call/Bet/Raise path against multiple seated Participants. CashGame handles participant eligibility, antes, blind positions, clockwise dealing, and action order, with the Playground rendering its complete safe view.

M1 scope; apply accepted ADRs 0012, 0017, 0025. This is a vertical slice of the playable foundation, not an invitation to implement later Trainer, product UX, replay tooling, Solver, or simulation milestones.

## Acceptance criteria

- [ ] Start and play Hands with any eligible participant count from 2 up to configured capacity, capped at 9; configured capacity and occupied eligible seats remain distinct. Preserve the already-supported heads-up exception.
- [ ] For three or more Participants, small blind is immediately clockwise from button and big blind next; preflop action starts with the next eligible actor after big blind, and postflop with the first live actor clockwise after button.
- [ ] Deal one card at a time in two clockwise passes, starting left of the button multiway and with the button heads-up. Empty, sitting-out, folded, and all-in positions are handled according to their distinct eligibility/turn roles.
- [ ] Apply conventional equal per-player antes before blinds as min(ante, remainingStack). Ante chips enter contribution/pot accounting but never reduce the amount needed to call the preflop blind; a short contribution preserves the Participant as all-in in the Hand.
- [ ] Forced blind contributions are capped by the remaining stack without redefining configured blind sizes. Determine Hand seats/button/blinds before collecting antes or blinds.
- [ ] Betting traversal and matching requirements apply to every live actor rather than assuming exactly two players; reuse the existing legality, street progression, and accepted-command path.
- [ ] The Playground displays all configured seats, public contributions, antes, button/blinds, actor and legal human controls from participant-safe DTOs; no opponent private cards or burn identities leak.
- [ ] Seeded engine and real server/database fixtures verify two/three/nine-Participant boundaries, sparse seating, sitting out, ante-vs-wager accounting, short forced bets, correct clockwise positions, move/leave button continuity where the management branch is available, conservation, and rejection atomically.

## Blocked by

- Draft ticket 06: Play exact Bet-to and Raise-to sizes.

