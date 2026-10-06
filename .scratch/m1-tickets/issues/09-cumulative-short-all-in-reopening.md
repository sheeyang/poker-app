# M1-09: Apply participant-specific reopening after short all-ins

## What to build

In a multiway Hand containing successive short all-ins, each Participant sees the correct Call/Fold/Raise opportunities for what they now face and what they previously did. The human can complete the decision through the same Playground controls, with no separate browser reopening logic.

M1 scope; apply accepted ADRs 0009, 0012, 0017, 0025. This is a vertical slice of the playable foundation, not an invitation to implement later Trainer, product UX, replay tooling, Solver, or simulation milestones.

## Acceptance criteria

- [ ] Track the applicable full-bet/full-raise threshold and each Participant's prior action/amount faced, rather than treating every short increase as an unconditional table-wide reopening.
- [ ] One sub-threshold all-in increases call cost without reopening previously closed action. Cumulative increases reopen a previously acted Participant only when the total increase they face reaches their applicable full-raise threshold.
- [ ] Participants whose betting has not closed retain their legal raise opportunities; folded/all-in Participants receive no turn. Different Participants can have different reopening rights at the same table state.
- [ ] Use the same internal calculation to produce frozen snapshot legal sizing descriptions and validate current act submissions, including exact boundary equality and a single short-all-in size.
- [ ] Respect matching/action requirements and last full increment through multiple short all-ins, another full raise, subsequent street closure, and eventual normal settlement.
- [ ] The Playground reflects participant-specific legal options/bounds from the committed view, shows new call costs, and rejects stale or closed-action Raise attempts atomically without altering cards, chips, history, or revisions.
- [ ] Independent seeded command fixtures cover one insufficient short increase, cumulative amounts just below/at/above threshold, Participants who acted at different wager levels, Participants yet to act, minimum/full raises after reopening, and final conservation.
- [ ] Real server/database tests drive the human decision in controlled multiway fixtures and verify actual serialized options agree with accepted/rejected exact sizes, request retry/stale behavior, and commit-before-visible results.

## Blocked by

- Draft ticket 08: Run out all-ins and settle main, side, and split pots.

