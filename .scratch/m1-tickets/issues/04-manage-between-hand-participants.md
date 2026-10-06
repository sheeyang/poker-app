# M1-04: Manage seats, button, top-ups, and rebuys between Hands

## What to build

After a completed Hand, the Table Owner uses the Playground to manage Participants and prepare the next deal: move to a free seat when enabled, sit out/return, leave/cash out and reseat, select an eligible button, or top up to a target stack. Every permitted change follows the same engine-command and durable-acceptance path as seating.

M1 scope; apply accepted ADRs 0012, 0015, 0017, 0018, 0020, 0025. This is a vertical slice of the playable foundation, not an invitation to implement later Trainer, product UX, replay tooling, Solver, or simulation milestones.

## Acceptance criteria

- [ ] Expose leaveParticipant, moveParticipant, setSittingOut, topUpTo, and setButton through owner-authorized safe requests and Playground controls; every successful poker operation appends exactly one accepted command and advances both server revisions once.
- [ ] Reject membership/seat/sitting-out/button/external-stack changes during an active Hand. Expected rejection, stale submission, request reuse, or persistence rollback cannot partially alter identity, seats, stacks, histories, or revisions.
- [ ] Movement requires an unoccupied valid seat and enabled allowSeatChanges. Sitting out affects next-Hand eligibility without removing the Participant registry. Do not implement missed-blind obligations, blind debt, or seat-change penalties.
- [ ] Leaving cashes out the permitted stack; rejoining uses a valid buy-in and the same ParticipantId. Moving, leaving, and rejoining preserve prior legally observed history, and a new seat occupant inherits none of another Participant's observations.
- [ ] topUpTo means target resulting stack rather than an increment, must exceed the current stack, and must not exceed maximumBuyIn. A zero-stack rebuy must satisfy minimumBuyIn; a positive-stack top-up may remain below it. A positive stack below minimum remains eligible.
- [ ] Do not permit a seated Participant to withdraw chips or lower a stack through top-up. Conservation fixtures account explicitly for accepted external buy-ins, top-ups, and cash-outs.
- [ ] After completion the button advances clockwise from the previous button seat, even if its occupant leaves, skipping empty/sitting-out/zero-stack seats. An explicit between-Hand setButton to an eligible occupied seat overrides the next position.
- [ ] Default and disabled seat-change configurations, leaving/reseating, sitting-out eligibility, button override/rotation, and target-stack feedback are demoable through the Playground and replayable accepted commands.
- [ ] Public engine and real server/database tests cover boundaries, stable identity and observations, external chip conservation, active-Hand rejection, owner authorization, and idempotent success/rejection. Later all-in fixtures extend this coverage to a zero stack created by actual play.

## Blocked by

- Draft ticket 03: Deal a heads-up Hand and settle a fold.

