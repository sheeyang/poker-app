# M1-05: Play heads-up Check and Call through showdown

## What to build

A human facing the current decision can Check or Call when legal. Accepted actions progress the same CashGame through every betting street and, when more than one live hand remains, reveal and settle a showdown. The Playground's complete views show the current board, actor, contributions, and final stacks without requiring dealer commands.

M1 scope; apply accepted ADRs 0011, 0012, 0015, 0017, 0021, 0025. This is a vertical slice of the playable foundation, not an invitation to implement later Trainer, product UX, replay tooling, Solver, or simulation milestones.

## Acceptance criteria

- [ ] Check is legal only when nothing is owed, and Call commits the owed amount or remaining stack when smaller. Folded/all-in Participants receive no betting turns. Heads-up postflop action begins with the non-button.
- [ ] Use one legality calculation for observable actions and act validation. The Playground only submits the human's normal ConcreteAction through the authenticated revisioned queue; trusted acceptance fixtures may drive the other controller without introducing a user-facing impersonation feature.
- [ ] Round closure requires every remaining Participant able to act to satisfy action/matching requirements. A successful act atomically performs street-wager reset, burn, board deal, next actor, required reveal, payout, and completion as applicable.
- [ ] Burn one and deal three for flop, burn one/deal one for turn, and burn one/deal one for river from the same authoritative deck; do not burn/deal after an earlier fold completion. Burn identities remain hidden in views and presentation events.
- [ ] At river showdown reveal all remaining live hands automatically. Rank the strongest five-card hand from seven cards with zero, one, or two hole cards; compare complete category/kicker ranks, including the ace-low wheel, no K-A-2-3-4 wraparound, and no suit tiebreak.
- [ ] Derive and settle the matched pot, return unmatched excess, support equal-contribution ties, and conserve integer chips. Expanded layered pots/odd-chip cases are covered by ticket 8 without introducing a second mutable pot source now.
- [ ] The Playground adds Check/Call controls, safe community cards and street transitions, public showdown cards, and final stack/pot outcomes. Presentation events never control progression or require an animation to finish.
- [ ] Each added action remains recorded/restorable using normal command semantics; current and earlier immutable participant views cannot mutate live state or acquire later reveals.
- [ ] Known-seed engine fixtures and real server/database tests verify heads-up order, action matching, automatic 3/1/1 progression/burns, serialized hidden-card safety, showdown completion, tied ranks, atomic rejection, and conservation. Focused exported ranking fixtures cover all nine categories and kicker/board-playing edge cases.

## Blocked by

- Draft ticket 03: Deal a heads-up Hand and settle a fold.

