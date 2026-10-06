# M1-08: Run out all-ins and settle main, side, and split pots

## What to build

When Participants commit their remaining stacks, CashGame resolves outstanding decisions, reveals required live hands, runs out the board when betting is finished, and awards each derived pot correctly. The Playground shows authoritative pot eligibility, returned chips, payouts, and resulting stacks. This ticket adds all-in settlement behavior across existing safe requests and durable records.

M1 scope; apply accepted ADRs 0011, 0012, 0017, 0021, 0025. This is a vertical slice of the playable foundation, not an invitation to implement later Trainer, product UX, replay tooling, Solver, or simulation milestones.

## Acceptance criteria

- [ ] A genuine all-in may Bet/Raise below the full minimum or make a short Call. Describe a sole legal short-all-in amount as one Bet/Raise size rather than an inverted interval or new action type; no ordinary below-minimum wager is accepted.
- [ ] A single short all-in changes outstanding call amounts without counting as a full raise or reopening prior closed betting by itself. Participants who have not closed their action retain legal opportunities; cumulative participant-specific reopening is completed and stressed by ticket 9.
- [ ] Resolve all outstanding Call/Fold decisions before automatic runout. When no further betting decision is possible, reveal every remaining live hand and use exactly the normal burn-before-flop/turn/river sequence; actions/dealer steps are not requested separately.
- [ ] Derive pots solely from contribution layers. Folded chips remain, folded Participants cannot win, and each live Participant is eligible only for layers covered by their contribution.
- [ ] Return unmatched excess to its contributor instead of constructing a one-Participant side pot. Contributions 100/300/300 yield pots of 300 and 400; contributions 100/300 yield a pot of 200 and a return of 200.
- [ ] Settle every main/side pot independently by the shared best-five ranking. Ties split in integer units; remaining odd chips go clockwise from button among tied winners independently for each pot. Lone-live-hand settlement retains fold-win privacy.
- [ ] The complete atomic transition conserves chips across contributions, returns and payouts, records one accepted action, and produces safe committed views/events with no future/deck/burn leakage.
- [ ] The Playground represents all-in status, pot layers/eligibility, runout/showdown, returns/payouts and zero-stack next-Hand ineligibility from server views. If ticket 4 has landed, verify actual-play zero-stack rebuys and the next explicit Hand using those controls.
- [ ] Public engine and real server/database tests cover short calls/bets/raises, all-in from ante/blind, unequal caps, folded contributors, outstanding calls, tied main/side winners, per-pot odd chips, early folds, deterministic runout, zero stacks and complete conservation.
- [ ] Do not change the public ConcreteAction contract, introduce an independent pot ledger/rules engine, auto-start another Hand, or add voluntary show/muck choices.

## Blocked by

- Draft ticket 07: Play multiway Hands with antes and correct position.

