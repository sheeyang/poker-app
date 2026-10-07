# M1-04 implementation evidence

M1-04 adds between-Hand Participant management through CashGame, the shared
durable server mutation path, and Playground controls. Leaving cashes out the
complete stack, movement follows allowSeatChanges, sitting out changes playing
eligibility, topUpTo adds chips to a target resulting stack, and an eligible
setButton overrides the next automatic rotation.

Accepted commands preserve stable ParticipantIds. Current seating, stacks, and
button choices never rewrite frozen completed-Hand facts. Hand observers include
every seated Participant, including sitting-out and zero-stack Participants.
Completed history follows the observer's identity, retains observations across
leaving/rejoining, and excludes Hands played during an absent interval. M1-10
extends this minimal completed-Hand history to full frozen decision views.

Validation on 7 October 2026:

- pnpm check passes: 80 tests in ten files, workspace type checks, server and
  Playground production builds, and dependency boundary checks.
- Public CashGame/ParticipantCashGame tests cover cash-out above maximumBuyIn,
  valid reseating, enabled/disabled movement, sit-out/return readiness, target
  rather than incremental top-ups, positive stacks below minimumBuyIn, zero-stack
  eligibility/rebuy, exact table chip-capacity rejection, button rotation and
  override, active-Hand rejection, detached observations, historical facts,
  complete accepted-command replay, invalid-record rejection, and independent
  forks. M1-08 supplies the zero stack created by actual play needed to extend
  the rebuy minimum boundary fixture.
- Real HTTP/PostgreSQL tests cover owner-only management, exact idempotent
  success/rejection, requestId conflicts, stale requests, unsupported request
  fields, active-Hand and disabled-policy rejections, confirmed rollback with
  unchanged committed views, held COMMIT withholding changes, FIFO with Start
  Hand, one advancement of both revisions per successful command, and restart
  restoration of management commands and history.
- Isolated Chrome session poker-m1-04 exercised actual Playground forms: create
  a flexible-buy-in table, seat human/Bot, Start Hand, Fold, move human from Seat
  1 to Seat 3 while retaining 990 chips, topUpTo 1200 with a 210-chip preview and
  confirmation, sit out/return with corresponding Start Hand readiness, set the
  eligible Seat 3 button, leave/cash out 1200, and reseat the same human in Seat
  4 with 1000 chips. A second table demonstrated disabled movement controls and
  policy feedback after seating. Active-Hand management controls were disabled.
- Desktop 1440-pixel and actual mobile 390-pixel captures were visually inspected.
  Mobile document scrollWidth equals its 390-pixel viewport. The mechanical
  design detector returned no findings. Chrome console contained only Vite
  connection/HMR messages and the React DevTools notice. Browser bridge, server,
  and Vite processes were stopped after the smoke test. The combined milestone
  finish review will include this extension.

## Extension points

All new poker kinds extend createTableSessionMutations().submit and its existing
per-session queue. Request metadata and revisions stay outside engine commands.
The WebSocket ticket publishes the safe management events at the same postcommit
promotion boundary.

CashGameState.nextButtonSeat is a one-Hand override. Automatic rotation starts
from the previous Hand's frozen button, so a leaving or moving occupant does not
change its origin. HandState.observerParticipantIds records legally present
observers independently of frozen playing members; sitting out is not absence.

Private bankroll accounting measures net external chip flow through accepted
buy-ins, top-ups, and cash-outs. BigInt capacity checks preserve the representable
table total, while winnings remain unrestricted by the buy-in maximum.

Playground pendingManagement retains the exact uncertain attempt for explicit
retry, blocks competing submissions, and clears after definitive outcomes.
Success feedback is displayed only for its committed poker revision, so later
table changes cannot leave an obsolete target-stack confirmation visible.
