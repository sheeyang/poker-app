# M1-06 implementation evidence

CashGame accepts exact representable integer `betTo` and `raiseTo` totals for
the current street. A Bet opens wagering; a Raise increases the current price.
The opening full minimum is the big blind. Preflop starts with the big blind
as the full increment; each full Bet or Raise sets the next full increment.
The participant's prior action price controls whether betting has reopened.
Outstanding matching requirements keep the round open after a raise, and a
new street resets wagers, prior action completion, and the full minimum.

Participant views and `act()` validation use the same private legality
calculation. Bet/Raise descriptions contain inclusive minimum/maximum integer
bounds. A participant unable to reach the full minimum receives only their
genuine all-in total as a singleton interval. Non-all-in amounts below the
minimum are rejected. No sizing buckets or enumerated amount lists are used.
The maximum includes the actor's existing street wager and remaining stack;
submission transfers only the difference from the existing wager. Sized
actions use the existing isolated draft, invariant checks, and accepted
command record. Wrong actors, wrong action types, malformed/fractional/unsafe
amounts, closed raising, and out-of-bounds totals leave the full game unchanged.

The Playground renders Bet-to or Raise-to from the current engine description,
with a labeled native integer input and the server's exact bounds. Its help
explains total commitment including chips already wagered. The field resets
for each decision and pending commands retain their original amount and
request identity. Rejections invalidate the complete committed view through
the existing refresh path. The client introduces no poker legality rules.

The shared durable mutation FIFO already handles sized actions through
CashGame. M1-11's safe publication mapping explicitly projects `betTo` and
`raiseTo`; the integrated tests verify these serialized events and views after
confirmed COMMIT, including trusted Bot submissions. Stored retries neither
reapply chips nor republish presentation events. The HTTP/WebSocket ordering
guard and separate transient status channel remain intact.

Validation completed across 7–8 October 2026 before integration:

- The first public CashGame test failed because Raise was absent, then passed
  after the sized-action implementation. Independently worked totals lock
  preflop raises 53, 100, and 147, with subsequent full minimums 86, 147,
  and 194. A flop Bet of 31 resets to a turn minimum of 20. Using the existing
  independent `heads-up-fixture` deck, Bob's club flush wins the 356-chip pot;
  final stacks are 822/1178. Replay returns identical facts and participant views.
- Engine fixtures cover both Bet/Raise inclusive minimum and maximum sizes,
  arbitrary interior totals, genuine single-size short all-ins, multiple full
  raises, a prior caller's closed raising after a single short all-in, street
  reset, conservation, atomic malformed/illegal rejection, and a controlled
  draft defect after a sized contribution.
- Real HTTP/PostgreSQL fixtures cover Bet minimum 20 and maximum 980, Raise
  minimum 40 and maximum 1000, interior sizes, full-raise bounds, stale sizing,
  fingerprint conflicts, matching success/rejection retries after later play,
  rollback, held COMMIT, completion, and server restart. No normal HTTP route
  can act as a Bot. Exact Bet/Raise wire events are independently checked over
  a real WebSocket; working sizes stay unpublished before COMMIT and a retry
  emits no duplicate event.
- `pnpm check` passed with 126 tests in 16 files, all workspace type checks,
  both production builds, and dependency boundary checks. The final additional
  Bet endpoint cases also passed at the real HTTP seam. M1-11 was integrated
  from `implement/m1` at `6e34b81` before completion.
- Named Chrome session `poker-m1-06` exercised the actual Playground on
  isolated ports 3006/5176 against a unique PostgreSQL schema. The human
  entered Raise-to 53, then Bet-to 37, checked to showdown, and reconnected.
  Final revisions were 12/12, board `3h 4c 4h 5d 9d`, stacks 910/1090, and
  the settled pot was 180. Bot cards stayed hidden before showdown. The native
  field rejected a below-minimum 19. The browser reported no console errors.
- Full-page desktop 1280px and emulated mobile 390px captures were inspected.
  Mobile document width equaled its viewport. Impeccable's mechanical detector
  returned no findings. A browser field-name notice was corrected by naming
  the sized input. Captures are preserved outside the ticket worktree under
  the task's visualization directory as `m1-06-raise-desktop.png`,
  `m1-06-raise-mobile.png`, and `m1-06-completed-desktop.png`.
- The isolated Chrome bridge, server, and Vite process stopped. The browser
  fixture dropped its unique schema, and ports 3006/5176 are free.

The repeatable browser fixture is
`apps/server/test/fixtures/sizing-browser.ts`. Run it with a real
`TEST_DATABASE_URL`, then point the Playground's `POKER_API_TARGET` to port
3006 and start Vite on 5176. Create a table with one Bot, seat both participants,
and start the first Hand. The fixture drives only Bot Call/Check intentions
through the captured internal controller capability and real mutation queue.
It adds no HTTP Bot bypass. Evaluate the function in
`scripts/smoke-sizing-browser.js` through chrome-devtools-axi after setup;
on Windows, join its non-comment lines with spaces before passing the
expression. Typing `stop` in the fixture terminal closes it and drops its
schema. Automatic Strategy work remains M1-12.

Multiway forced-bet boundaries, expanded all-in settlement, and cumulative
short-all-in reopening retain their planned M1-07/M1-08/M1-09 tickets. This
slice preserves the existing participant management, stable identity,
observer-presence history, and deterministic records.
