# M1-08 implementation evidence

The existing CashGame settlement and runout implementation from M1-05/M1-07
already meets the all-in rules. New acceptance fixtures exercise it through
public CashGame/ParticipantCashGame commands and real HTTP/WebSocket/PostgreSQL.
No alternate pot ledger, action type, state injection, seed request field, or
production rules refactoring was needed. Shared legality remains unchanged for
M1-09's cumulative reopening stress.

The Playground now lists the authoritative main pot and each side pot with its
amount and eligible Participant names. It reads these facts directly from the
committed view. Existing All-in status, safe board/showdown, returns, payouts,
and exact sized-action controls remain the public presentation. A seated zero
stack now explains its next-Hand ineligibility and the rebuy control. The Start
Hand readiness message directs zero-stack recovery to Manage between Hands.
Rebuy preserves Participant identity and completed history; the next Hand still
requires an explicit Start Hand.

## Independent worked fixtures

- Live contributions 100/300/300 produce main 300 and side 400. With the
  documented `heads-up-fixture` deck and button Seat 1, Alice in Seat 3 pairs
  the board's three and wins main 300. Bob in Seat 2 has the best remaining
  high-card hand and wins side 400. Final stacks are 300/400/0.
- Live contributions 100/300 produce matched pot 200 and unmatched return
  200. The deep button raises while both Participants can act; the short big
  blind then Calls its remaining 80. The one remaining able Participant does
  not receive a new Raise opportunity.
- Live 100, live 300, folded 200 produces pots 300/200 and return 100. Live
  100, folded 300, live 400 produces pots 300/400 and return 100. The folded
  Participant funds matched layers without eligibility or public hole cards.
- Contributions 2/2/2/1/1, with the latter three folded, produce pots 5 and 3
  eligible to the first two live Participants. Tied Alice/Bob receive 3/2 and
  2/1 respectively, so Alice wins 5 and Bob 3. Combining the pots before
  splitting would incorrectly give 4 each.
- Ante-all-in 3 against 100/100 retains two hole cards and a main cap of 3:
  pots 9/194, with the side available only to the larger contributors.

[all-in-board-ties.py](../fixtures/all-in-board-ties.py) independently finds
literal board-playing ties with Python's standard library, without production
RNG or ranking imports. It excludes any live hand's higher straight or flush.
Run it normally for engine fixtures and with `--hex` for creation entropy:

- `all-in-board-tie-3-1441`: draws
  `Jd Ad 7d Js Ks Tc Qd 7h 4c 5c 5d 6c Qs 8s`; all three play the eight-high
  straight. Main 300 splits 100 each; side 400 splits 200 each.
- `all-in-board-tie-5-44`: draws
  `7d Qc 8s 8c 6h Ad Js 2h 4c 2d Jd 2s Ah 5s Qd 4h Tc 3c`; Alice/Bob play
  the wheel, with Alice first clockwise from the button for each odd chip.
- 32-byte hex master seed ending `0489` (all preceding digits zero): draws
  `8d Td 8c Kd Th 6d 4h 4d 2s 5d Ks 6c 4s 3h`; all three play the six-high
  straight in the durable main/side tie test.
- 32-byte hex master seed ending `06d7`: draws
  `Ac 3d 9d Ah Qh Ks 8h 7s Qs Kd 5s 8s Jc Th Kh 9c Tc 7h`; Alice/Bob play
  the jack-high straight in the durable per-pot odd-chip test.
- The all-zero 32-byte seed can be reproduced with `random-v1.py` and 64 zero
  digits. Three-player board is `Td Qh 5c Ad 4s`, burns `3d Js Qs`; Bob in
  Seat 2 holds `4d 8s` and pairs the four. With caps 100/300/300 he wins both
  pots and stacks finish 0/700/0. Heads-up board is `Kc 3d Td 5c Ad`; the deep
  button's nine kicker beats the short big blind's eight, settling 200 plus
  a 200 return and leaving stacks 0/400.

## Validation on 8 October 2026

- Frozen-lockfile installation passed. `pnpm check` passed 167 tests in 22
  files, all workspace type checks, both production builds, and dependency
  boundaries. `git diff --check` passed.
- Seven new public-engine fixtures cover the literal caps, distinct main/side
  winners, folded layers, tied main/side winners, independent odd chips,
  chip conservation after each action, exactly one recorded command per action,
  normal versus automatic deterministic burns/dealing, frozen historical
  visibility, full record restoration, and actual-play rebuy/explicit next Hand.
  Existing M1-06/07 fixtures cover genuine singleton short Bet/Raise, below-
  minimum rejection, a single short raise's closed/unacted betting rights,
  capped short Call, short antes/blinds, outstanding Call/Fold, and fold privacy.
- Eight new real HTTP/WebSocket/PostgreSQL fixtures cover layered all-in
  acceptance, short Bet/Raise/Call, ante all-in, folded layers, unmatched returns,
  early fold privacy, tied main/side payouts, independent odd chips, commit-gated
  reveals and events, rollback, exact retry, server restart, zero-stack exclusion,
  rebuy, and explicit next Hand. The crypto mock arms only creation's hidden
  seed allocation after a real identity cookie is established, clears in finally,
  and leaves all other entropy/UUID behavior real. No database content is injected
  or used as an assertion side channel; all poker outcomes are observed over
  HTTP/WebSocket. Serialized payloads physically omit seed/deck/burn identities
  and retain original safe decision visibility.
- The browser tracer first failed on the missing layer/eligibility display and
  passed after that narrow UI change. Named Chrome session `poker-m1-08` used
  real schema-isolated Fastify on 3008 and Playground on 5178. Ordinary controls
  created and seated 100/300/300, submitted Raise-to 100, and completed at
  revisions 7/7 with pots 300/400, board `Td Qh 5c Ad 4s`, stacks 0/700/0.
  It then disconnected/reconnected without accepted play, rebought the human
  to 100, confirmed no automatic new Hand, explicitly started Hand 2 excluding
  the unreplenished zero stack, and played 100/300 to pot 200 plus return 200.
- Desktop 1280px and mobile 390px captures were inspected. Pot eligibility,
  disabled Start Hand, rebuy, and payout information remain readable. Mobile
  document width equals its viewport (390px). Console errors are empty and
  the single required Impeccable mechanical scan returned no findings.
  Captures are outside the worktree in the shared task visualization directory:
  `m1-08-layered-desktop.png` and `m1-08-layered-mobile.png`.

## Reproduce the browser acceptance

Start `apps/server/test/fixtures/all-in-browser.ts` with `TEST_DATABASE_URL`
pointing at a real test database and `PORT=3008`. Start Playground Vite with
`POKER_API_TARGET=http://127.0.0.1:3008` on 5178. The standalone fixture controls
one creation entropy draw and submits Bot intentions through the captured
`onControllerCommandsReady.submitAction` capability and shared mutation FIFO;
it is excluded from production and adds no HTTP Bot impersonation route.

Evaluate `scripts/smoke-all-in-browser.js` with chrome-devtools-axi by fetching
its Vite `/@fs/<absolute-path>` source and evaluating the returned function.
It creates fresh tables through the browser's own identity and uses actual
Playground controls. Type `stop` in the fixture terminal to close the server
and drop its schema; stop the assigned Vite process and named Chrome bridge.
