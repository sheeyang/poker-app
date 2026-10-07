# M1-05 implementation evidence

Check and Call use the same legality calculation as participant views. Call
commits the owed chips, capped by the remaining stack. The big blind retains
its preflop option. Round closure requires every live Participant able to act
to have acted and matched the current price. An accepted command performs the
street reset, burn, board deal, next decision, reveal, and settlement on the
existing isolated CashGame draft.

The public `rankHand(cards)` helper evaluates the strongest five of five to
seven explicit distinct cards. `compareHandRanks` compares all nine categories
and complete kickers without suits. CashGame settlement reuses that helper and
the contribution-derived pots, returning unmatched excess and splitting ties
in integer chips. A capped Call that leaves no further betting reveals live
hands before the automatic board runout. Ordinary river showdown reveals live
hands only after the last betting decision. Fold completion never reveals the
winner or draws later streets.

The server's internal `TableSessionControllerCommands.submitAction` capability
is captured through `onControllerCommandsReady`. It accepts only a bound Bot
and enters the exact human mutation FIFO, revision validation, transaction,
postcommit promotion, and definitive retry path. The normal HTTP action path
retains its bound-human authorization and returns 403 for Bot impersonation.
Request fingerprints distinguish human and trusted controller authority, so a
browser cannot recover a successful Bot acknowledgement by reusing its request.
This is fixture orchestration for M1-05; automatic Strategy jobs remain M1-12.

The Playground renders Check, Call, and Fold only from its human legal actions.
It displays Call's chip commitment, street wagers, safe board cards, public
showdown holdings, payouts, returns, and final stacks. Complete views govern
progression independently of presentation events.

Validation on 7 October 2026 before integration:

- `pnpm check` passed: 102 tests in 11 files, workspace type checks, production
  builds, and dependency boundary checks.
- Public engine fixtures cover preflop matching and the big-blind option,
  heads-up postflop order, all streets and burns, short Call, unmatched return,
  tied board ranks, conservation, fold privacy, rejection, controlled defects
  after each street/showdown, immutable prior facts/views, and record replay.
- Exported ranking fixtures cover all nine categories, every category's
  kickers, ace-low wheel, no king/ace wraparound, no suit tiebreak, zero/one/two
  hole cards, two trips, three pairs, invalid cards, and immutable ranks.
- Real HTTP/PostgreSQL fixtures cover human Call/Check and trusted Bot
  Check/Call, hidden-card serialization, shared FIFO and revision checks,
  binding restrictions, source-separated retries, commit-gated showdown,
  confirmed rollback and exact retry, and restoration after server restart.
- Named Chrome session `poker-m1-05` used isolated ports 3005/5175 and the
  captured trusted capability through the actual server. The human clicked
  Call and three Checks, reaching revisions 11/11. Board was
  `9s 6s 3s 2h 8c`, hole cards were `Kc 8d` and `7d Ks`, the 40-chip pot went
  to the human, and stacks finished 1020/980. Bot cards stayed hidden before
  showdown. Desktop 1280px and emulated mobile 390px captures were inspected;
  mobile document width equaled its viewport. Console messages were limited
  to Vite connection and the React DevTools notice. Isolated processes stopped.
- Impeccable's bounded mechanical detector returned no findings.

Literal engine vectors use the independent Python script documented in
[random-v1](../random-v1.md). Its optional master-seed argument reproduces
`board-tie-4656`: the first twelve draws are
`Ts Jc 8h 6h 7s Jh Ks Ah Ad Tc 3c Qd`. Both players play the board's ace-high
straight and receive 20 chips each. No production RNG or ranking function
computes test expectations.

`HandParticipantState.actedAtPrice` records round action completion alongside
the existing price/full-increment facts for the sized-action extension. Full
multiway/all-in readiness and layered/odd-chip acceptance coverage remain the
planned M1-07/M1-08 work. There is no second rules state or mutable pot ledger.
