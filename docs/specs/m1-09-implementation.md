# M1-09 implementation evidence

The existing CashGame betting calculation already implements the accepted
ADR-0025 participant-specific reopening rule. `actedAtPrice` separates a
Participant's completed action from outstanding matching obligations; the
last full increment remains unchanged by short all-ins. Both the immutable
legal descriptions and current `act` validation use that calculation.
This ticket adds independent public conformance fixtures and a reproducible
real-server browser acceptance. No production rules change or client betting
logic was needed. No contrived failing test or speculative refactor was added.

## Independent command fixtures

The five-Participant fixture seats button E at 1, A at 2, B at 3, C at 4,
and D at 5, with 10/20 blinds and no ante. Initial stacks are A/C/E 1000,
B 170, and D 219/220/221. All match the 20-chip preflop wager. On the flop,
A Bet-to 100, B exhausts Raise-to 150, C Calls 150, and D exhausts
Raise-to 199/200/201. Unacted E retains Raise-to 299/300/301.

After E Folds, A faces 99/100/101 more chips. At 99 its options are only
Fold/Call. Equality reopens Raise-to 300, and above equality reopens
Raise-to 301. C, having acted at 150, remains closed when facing only
49/50/51 more if A Calls. Minimum minus one is rejected atomically;
the exact minimum is accepted. A's full raise reopens C. A later full
150-chip increment establishes the next exact minima 500 and 650.

A separate six-Participant fixture changes the full increment from 100
to 200 with Raise-to 350, followed by short all-ins to 450 and
549/550/551. The raiser C faces 199/200/201 and reopens only at equality,
with exact minimum 750/751. This checks that cumulative short increases
use the new full increment instead of the earlier opening size.

The checked-before-incomplete-opening fixture begins with A Check,
B all-in Bet-to 5, and an unacted deep C permitted to Raise-to 25.
If C Calls instead, A faces only 5 and cannot Raise. A five-Participant
variant adds short all-ins to 15 and 19/20/21; the prior Check reopens
only when the full 20-chip threshold is reached. The full increment
remains 20, so the reopened minima are 40/41. All-in and folded
Participants receive no turns; matching closes normally before another
street and eventual settlement.

The public engine fixtures use the independent `all-in-board-tie-5-30`
deck vector documented by [the prior milestone evidence](m1-08-implementation.md)
and generated independently by [all-in-board-ties.py](../fixtures/all-in-board-ties.py).
With clockwise A/B/C/D/E dealing, board `3s 8d 2c 5s Ah` lets A/B tie
with wheels. In the equality Call path, final stacks in seating-command
order E/A/B/C/D are 980/1280/350/780/0. At price 201 they are
980/1282/350/779/0. Literal outcomes accompany chip conservation after
every accepted action, one accepted command per action, detached fork
play, frozen decision history, and complete record restoration.

## Server and browser verification on 8 October 2026

Eleven new public CashGame/ParticipantCashGame tests and eight real
HTTP/WebSocket/PostgreSQL tests cover the above decisions. Server tests
control Bot intentions through `onControllerCommandsReady.submitAction`
and real mutation transactions. Creation alone uses a one-shot mock of
the external `node:crypto.randomBytes` boundary after establishing a real
identity; all identities and UUIDs retain normal entropy. There is no
state injection, database assertion side channel, public seed field, or
browser Bot impersonation route.

The serialized human descriptions agree with closed, exact minimum, and
singleton short-all-in acceptance. Real server tests preserve cards,
stacks, history, and both revisions on closed/below-minimum and stale
attempts; exact request retries retain their original outcome. A held
reopened Raise stays absent from HTTP and WebSocket views before commit;
rollback changes nothing. Completed sessions restore identically after
server restart. Earlier history physically retains only the observer's
cards and serialized views omit seed/deck/burn identities.

The Chrome session `poker-m1-09` used schema-isolated Fastify on 3009 and
the Playground proxy on 5179. Actual creation, seating, Call, Bet-to,
Raise-to, and Check controls completed the three boundary Hands:

| Last short price | Human Call | Human minimum Raise-to | Final revisions | Final stacks A/B/C/D/E |
| --- | --- | --- | --- | --- |
| 199 | 99 | Closed | 22/22 | 1278/350/781/0/980 |
| 200 | 100 | 300 | 23/23 | 1480/350/580/0/980 |
| 201 | 101 | 301 | 23/23 | 1482/350/579/0/980 |

The independently recorded hex seed ending `00ba` yields board
`Qh Qc Ad 9c 6c`; A/B have queens and nines above the short hands.
The open paths also use C's full Raise-to 400/401 and the human's
Call of 100, then ordinary turn/river Checks. Native integer bounds,
atomic HTTP rejection from the same browser identity, stale revision,
rejected retry, history privacy, conservation, and reconnect all passed.
No next Hand started automatically.

An initial browser attempt completed the below/equality Hands before
Chrome reported `net::ERR_NO_BUFFER_SPACE` on another creation. The
isolated server health check stayed 200; the existing unconfirmed
creation controls resolved the attempt, and a complete rerun passed all
three cases. The browser also remained usable after viewport emulation
and a page refresh. This was environmental evidence, not a product RED.

One bounded capture pass checked the closed and equality decisions at
desktop 1280px and true mobile 390px. The fields, inclusive bounds,
Call costs, hidden-card statuses, and controls are readable; document
width equals each viewport. The incumbent UI required no change.
Screenshots live outside the worktree in the shared visualization root:
`m1-09-equality-desktop.png`, `m1-09-equality-mobile.png`,
`m1-09-closed-desktop.png`, and `m1-09-closed-mobile.png`.

Final `pnpm check` passed 188 tests in 24 files, all workspace type
checks, both production builds, and dependency boundaries. Frozen-lockfile
installation and `git diff --check` passed. The one mechanical Impeccable
scan of the incumbent Hand controls returned no findings. The final
browser console had no errors; expected 400/409 rejection requests were
verified during the acceptance script. The assigned browser bridge,
Fastify/schema fixture, and Vite process were stopped after verification.

## Reproduce

Run `pnpm install --frozen-lockfile` and `pnpm check` with the real
`TEST_DATABASE_URL` configured. Start
`apps/server/test/fixtures/reopening-browser.ts` with `PORT=3009`, then
Playground Vite with `POKER_API_TARGET=http://127.0.0.1:3009` on 5179.
Fetch and evaluate `scripts/smoke-reopening-browser.js` as a function in
the named Chrome session. Its default run completes all three cases;
`{ pausePrice: 199 }` or `{ pausePrice: 200 }` stops at the corresponding
committed human decision for screenshots. The fixture is test-only and
excluded from production. Type `stop` in its terminal to close it and
drop only its schema; stop the assigned Vite process and Chrome bridge.
