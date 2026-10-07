# M1-03 implementation evidence

M1-03 adds the first explicit playable Hand to the engine, durable server, and
Playground. Start Hand freezes eligible membership and seats before forced bets,
uses versioned deterministic dealing, and creates engine-owned Hand/Decision
identities. A human Fold settles all matched chips, returns unmatched excess,
and leaves the winning Bot's cards private. Completed Hands await another
explicit Start Hand command.

The approved tests exercise public CashGame/ParticipantCashGame and real
HTTP/PostgreSQL. No private random helper is a test seam. Independent Python
vectors and the byte-level contract live in [random-v1](../random-v1.md); the
public Hand fixture locks all 52 cards through a literal deck digest and verifies
literal hole cards through participant projections and immutable trusted facts.

Validation on 7 October 2026:

- `pnpm check` passes: 71 tests in eight files, workspace type checks, server and
  Playground production builds, and dependency boundary checks.
- Public engine tests establish independent deterministic deck/Hand identities,
  capped blinds, frozen short-all-in membership, fold settlement/conservation,
  immutable views/facts/events, physical opponent-card omission, full replay,
  independent forks, wrong actors, active setup/readiness rejection, and atomic
  controlled defects after dealing or settlement.
- Real HTTP/PostgreSQL tests establish owner-only Start Hand, human-controller
  action binding, 403 for Bot impersonation, wrong human turns, active setup
  rejection, revisions advancing once per successful command, matching retry
  outcomes, commit-before-visible behavior/FIFO, confirmed rollback, and complete
  played-Hand restoration after server restart.
- Isolated Chrome session `poker-m1-03` exercised the actual Playground form:
  configure one Bot, create an owned session, seat human/Bot in seats 1/2, Start
  Hand, and Fold. At revisions 3/3 the human saw `6s 4c`, the Bot showed two
  hidden cards, pot was 30, and actor was You. At 4/4 the Hand completed with
  stacks 990/1010, matched pot 20, return 10, and the Bot still hidden. Start Hand
  was enabled for explicit continuation. Chrome console contained only Vite
  connection messages and the React DevTools notice.

## Extension points for subsequent tickets

`packages/engine/src/internal/state.ts` contains the one authoritative plain
draft. Persistent Participants are separate from frozen Hand members, and the
current Hand is `hands.at(-1)`. Completed contributions remain display facts;
the bankroll invariant counts only unsettled current-Hand contributions along
with persistent stacks. `contributionLayers` includes folded chips and identifies
single-contributor excess as returns. Current matched layers are derived from
contributions; the Playground's live pot includes every unsettled contribution.

`getHand(handId)` physically constructs detached immutable trusted facts without
exposing private mutable state or RNG objects. `forParticipant(id).getView()`
constructs a complete immutable participant-safe snapshot, and `projectEvents`
physically constructs a separate safe presentation array. Previously returned
snapshots cannot change when a Hand settles or another Hand starts. Historical
decision reads and join/absence history extend this facade in M1-10.

Check/Call progression, ranking, sized actions, full multiway progression, and
automatic all-in runout remain the planned M1-05 through M1-09 extensions. Forced
contributions already preserve all-in members and configured blind sizes; this
slice imposes no artificial heads-up readiness restriction. Browser actions
never impersonate Bot controllers. Trusted Bot orchestration extends the shared
server FIFO in M1-12 and must retain its own result-validity checks.

`createTableSessionMutations().submit(id, owner, kind, request)` is the single
durable path for seating, Start Hand, and act. Engine arguments and accepted
commands contain no request metadata or server revisions. HTTP Start Hand is an
owner operation; HTTP act additionally requires the acting Participant's human
controller binding to the authenticated user. WebSocket publication in M1-11
extends this same postcommit promotion boundary.
