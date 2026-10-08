# M1-07 implementation evidence

CashGame supports two through nine eligible Participants independently of
configured seat capacity. Membership and seats freeze before forced bets.
Heads-up keeps the button/small-blind exception; multiway blinds are the next
two eligible seats clockwise from the button. Two card passes begin with the
button heads-up and left of the button multiway. Preflop begins after the big
blind multiway; subsequent streets begin after the button. Existing shared
legality and round traversal handle every live actor, with folded/all-in
members receiving no turns.

Antes are capped by each remaining stack and collected before blinds. They
enter Hand contributions without entering street wagers. `anteContribution`
is an explicitly mapped safe Participant fact, retained through street resets
and frozen historical views. Observable configuration continues to declare
the full configured blind amounts even when actual posts are short.

Start Hand now enters the same private betting completion path as Act.
When exactly one live Participant can act, only actual live opposing street
wagers can require a Call. A genuine outstanding debt exposes Fold/Call and
rejects Check and Raise. When it is satisfied, or no debt exists after forced
bets, CashGame reveals live hands before automatically burning, dealing the
remaining board, and settling. It does not create nominal blind debt,
meaningless checks, or an unmatched raise opportunity. The initial full raise
increment remains the configured big blind whenever multiple actors can bet.

`amountToCall` comes from the engine's current authoritative price and the
actor's stack/wager. The server maps it explicitly for current and historical
states, and the Playground uses this fact instead of inferring a nominal
price. The Playground renders all configured seats, actual ante contributions,
street wagers, total contributions, button/blind markers, hidden card counts,
and the existing legal human controls. No private deck or burn data enters
those DTOs.

Validation completed on 8 October 2026:

- The first public-engine short-blind test failed because Start Hand retained
  an unnecessary actor; it passed after unified completion. Subsequent red
  slices established missing ante and exact Call projections before adding
  those fields.
- Fourteen public CashGame/ParticipantCashGame fixtures cover every eligible
  count from two through nine, sparse seats, sitting-out and zero-stack
  exclusion, clockwise heads-up/multiway order, capped antes, all-in blinds,
  real outstanding Call/Fold, illegal Check/Raise atomicity, all streets,
  arbitrary multiway Bet/Raise matching, folded contributions, conservation,
  replay, and frozen historical ante/Call/privacy facts.
- Literal card fixtures use the independently documented `heads-up-fixture`
  v1 deck. Three-player sparse seats button 7 / SB 9 / BB 2 get holes `(5d,9c)`,
  `(4s,Ah)`, `(2c,3d)` respectively; burns are `4d,5s,9s`, board
  `Tc Qh Jc 3c 6d`. Carol's pair of threes wins the 60-chip pot. Nine-player
  dealing consumes eighteen hole cards, then burns `7h,Jh,7s` and board
  `Kc As 2h 6c Ts`; seat 5 pairs the ace and wins 180. Production RNG or ranking
  does not calculate test expectations.
- Real HTTP/PostgreSQL fixtures exercise three and nine players through
  showdown, safe public serialization, capped real Call 15, atomic active-Hand
  management rejection, movement/leave button continuity, frozen old seats,
  and server restart. Real transaction hooks prove rollback and held COMMIT
  withhold immediate forced-bet runout/reveals; the exact retry does not
  execute again. Trusted Bot fixture intentions retain the existing internal
  capability and durable mutation queue; no HTTP Bot bypass was added.
- Integrated `implement/m1` at `038bb39` with merge `4bb5a6c`, retaining
  M1-10's full derived histories, strict complete record replay, historical
  views, and nested field-by-field wire mapping.
- Final `pnpm check` passed 152 tests in 20 files, all workspace type checks,
  both production builds, and dependency boundary checks. `git diff --check`
  passed.
- Named Chrome session `poker-m1-07` used actual Playground controls and the
  existing schema-isolated trusted acceptance fixture on 3007/5177. A
  nine-seat capacity with You at 7 / Bot 1 at 9 / Bot 2 at 2, button 7 and ante 5 showed
  correct blind markers, contributions and Call 20. Human Call and three
  Checks completed at revisions 17/17, board `Qd 9h Td Th Kc`, stacks
  `1050,975,975`, pot 75. Opponent cards stayed hidden until showdown; prior
  decisions stayed private; reconnect changed no accepted play. No browser
  console errors appeared.
- Desktop 1280px and emulated mobile 390px full-page captures were inspected.
  Mobile document width equaled 390px and all nine seats rendered. Captures
  live outside the worktree in the task visualization directory as
  `m1-07-multiway-desktop.png`, `m1-07-completed-desktop.png`, and
  `m1-07-completed-mobile.png`. The isolated server dropped its schema, the
  Vite process and Chrome bridge stopped, and ports 3007/5177 are free.

The repeatable control verification is `scripts/smoke-multiway-browser.js`.
Run `apps/server/test/fixtures/sizing-browser.ts` with `PORT=3007` and a real
`TEST_DATABASE_URL`; start the Playground with `POKER_API_TARGET` pointing to
3007 and Vite on 5177. Create a table with capacity 9 / ante 5 and two Bots, seat
You at 7 / Bot 1 at 9 / Bot 2 at 2, set button 7, and Start Hand. Evaluate the script's
function with chrome-devtools-axi; on Windows join non-comment lines with
spaces before passing it to eval. Typing `stop` in the fixture terminal
closes the server and drops its schema. Automatic Strategy jobs remain M1-12.
Expanded side-pot/odd-chip fixtures and cumulative reopening remain M1-08/09.
