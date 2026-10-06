# M1-06: Play exact Bet-to and Raise-to sizes

## What to build

The human enters an exact total street commitment for a Bet or Raise, sees its current legal bounds, and completes a Hand using ordinary no-limit wagering. CashGame determines legality and all resulting chip/betting transitions; the client formats and submits intentions rather than calculating its own poker rules.

M1 scope; apply accepted ADRs 0009, 0012, 0017, 0025. This is a vertical slice of the playable foundation, not an invitation to implement later Trainer, product UX, replay tooling, Solver, or simulation milestones.

## Acceptance criteria

- [ ] Bet opens wagering and Raise increases an existing wager. betTo/raiseTo are exact representable integer total street commitments after acting, not additional chips or pot fractions.
- [ ] Accept arbitrary legal interior integer sizes, not just Policy endpoints or global sizing buckets. Full opening bet minimum is the big blind; a full raise increases the wager by at least the last full-bet/full-raise increment, initially the big blind preflop.
- [ ] The shared legality calculation describes inclusive integer minimum/maximum bounds and validates the same choices against the current game. It must not emit an inverted interval, enumerate every amount, or describe a below-minimum non-all-in size as legal.
- [ ] Track prior action completion, full raise size, current commitments, actor order, and reopened betting. Wrong actor, illegal type, invalid/fractional/overflowing amount, under-minimum non-all-in, and action without reopening return structured atomic rejection.
- [ ] Contributions and stacks update in the same isolated draft; acted state and outstanding call requirements correctly delay round closure. All-in is represented by an ordinary Bet, Raise, or Call rather than an extra action type, with expanded short-all-in behavior in tickets 8–9.
- [ ] The Playground distinguishes Bet-to and Raise-to, explains total current-street commitment, shows legal bounds, and handles stale/rejected size submissions by refreshing the complete committed view. No separate browser legality implementation is introduced.
- [ ] Existing durable command, fingerprint, revision, export/restoration, safe-view, and commit-before-publication guarantees apply to every sized action.
- [ ] Engine and real HTTP/PostgreSQL fixtures exercise legal minimum, maximum and interior sizes, multiple full raises, street reset, chip conservation, projected-versus-submitted legality, stale sizing, and failed command immutability through a completed Hand.

## Blocked by

- Draft ticket 05: Play heads-up Check and Call through showdown.

