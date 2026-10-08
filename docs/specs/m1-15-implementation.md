# M1-15 implementation: unknown PostgreSQL COMMIT recovery

Ticket: https://github.com/sheeyang/poker-app/issues/15.
Started from integration `4844086`; completed-Hand inspection integration
`76bba53` was merged in `c4a44c2` before combined verification.

## Durable acceptance and evidence

The three acceptance sites (creation, poker/Bot mutation, application controller
mutation) use one narrow explicit node-postgres BEGIN/COMMIT adapter. Existing
Drizzle callback SQL, public CashGame forks/commands and definitive outcomes are
preserved. It assigns an xid8 as decimal text and independently commits a small
attempt journal after callback/pre-COMMIT checks and before terminal COMMIT.
Journal data contains only owner/table scope, requestId, versioned fingerprint,
xid, pending/noncommit state and optional created Table Session hint. The hint
has no foreign key to its uncommitted target row, avoiding creation deadlock.

The journal/recovery pool is separate, limited to two connections and finite
two-second connection/query/statement timeouts. Ten simultaneous target clients
can all finish their journal/COMMIT path. A 100ms recovery sweep coalesces queued
or running background recovery to at most one operation per Table Session;
an oracle outage cannot build an automatic FIFO backlog.

Recovery asks the primary `pg_xact_status(xid8)` in a fresh READ COMMITTED statement
and only then separately reads the definitive outcome/aggregate. In-progress,
NULL, query error or committed-but-missing/mismatched outcome stay pending.
Missing request rows are never evidence of abort. Committed outcomes reload game,
both revisions, bindings/assignments/configuration and Bot provenance together
inside the existing per-session FIFO. Creation uses authenticated user/requestId
before a Table Session exists. Matching identity and ownership are checked again
for every retry; conflicting contents cannot reuse a pending or aborted ID.

Confirmed ambiguous abort retains a durable `commit-not-applied` tombstone and
does not execute the old attempt. A deliberate human new ID can continue; Bots
receive fresh evaluation identities and re-evaluate the current confirmed
decision. Old work cannot enter the mutation path. Ordinary known failure before
terminal COMMIT retains explicit same-ID retry with no definitive outcome.
Committed client/journal cleanup failures cannot replace the stored outcome.

Startup scans pending hints and seeds gates before restore/resumeBots. Independent
tables/users progress while the affected scope remains recovering. HTTP reads and
initial full WebSocket frames include transient runtime status outside the
ObservableGameView. Same-revision status changes are accepted separately from
gameplay ordering; the current-socket inspection capability rule remains intact.
The Playground distinguishes stored rejection, unconfirmed infrastructure outcome,
and confirmed noncommit. It offers Check attempt outcome or Start a new attempt,
and preserves confirmed cards, stacks and revisions while paused.

Pre-close invalidates callbacks/Bot work before HTTP drains. Waiting pre-COMMIT
fault hooks race the lifecycle gate and recheck it before journal/terminal dispatch.
Already-running HTTP replies send Connection: close during shutdown; otherwise an
active keep-alive reply can delay Fastify close. The real SQL terminal fault uses
fixture-owned standalone clients only after the application callback has finished,
so old server pools close while target SQL remains independently unresolved.

## TDD and regression evidence

Tests use the approved real Fastify HTTP/WebSocket/PostgreSQL and trusted immutable
readPersistedSession boundaries; no private helper/reducer, fake database, fault
HTTP route or engine mutation escape was added. Fault fixtures select actual
terminal COMMIT or ROLLBACK while the production resolver independently learns
the result from PostgreSQL.

Meaningful RED/GREEN slices:

- Real in-progress terminal transaction: initial HTTP 200 failed the unknown
  outcome assertion; the adapter now returns 503, retains confirmed state and
  restores eventual COMMIT exactly once.
- Ambiguous abort: initial HTTP 400 failed infrastructure classification; it now
  returns 503 `commit-not-applied`, survives restart, and requires a fresh ID.
- Rejection-only creation without a Table Session hint: a fresh owner request was
  incorrectly blocked after actual abort; owner-scope reconciliation now releases
  it while preserving the old noncommit identity.
- Held pre-COMMIT shutdown: a 15-second timeout exposed active HTTP keep-alive
  drain; lifecycle/Connection: close handling passes without releasing the old
  hook first, and old callback continuation cannot commit.
- Actual COMMIT followed by client cleanup error: HTTP 503 hid committed success;
  disposition no longer overrides the stored HTTP 200 acknowledgement.

The eleven recovery tests also cover creation restart without duplicate seed,
session or binding set; independent owners/tables; session-only controller revision;
stored domain rejection and Retry acknowledgement with no command/revision;
changed-content conflict; original small acknowledgement after later state advances;
late pre-recovery Bot results; and actual ambiguous Bot action abort followed by
fresh evaluation and exactly one accepted command/provenance entry.

Two earlier interim fixtures expected the recovery gate to remain permanent until
restart. Their original lost-afterCommit fault remains unchanged. M1-15 explicitly
requires live resolution, so matching attempts now return their stored acknowledgement
before restart. The Bot fixture observes the published recovery frame instead of
assuming it must still be the last frame after a valid live resolution. Existing
held-transaction commit-before-publish checks and known pre-COMMIT same-ID retry
checks remain unchanged; genuinely unresolved transactions have new direct coverage.

## Combined real browser evidence

The ticket-owned fixture used server 3015, Vite 5185 and schema
`browser_recovery_ab8ea2c0f44c45908b69f7aa7a3a191c`. Its stdin controls change only
real persistence terminal timing/lifecycle; ordinary UI controls provide all
creation, seating, poker and management intentions.

The browser created three seats with a human and two Uniform Choice/Highest
Probability Bots, default stack 1000 and maximum 2000. It seated all three and
explicitly started Hand 1 at 4/4. Human Raise-to 53 was legal (40–1000) and entered
a held real transaction. The last confirmed Hand stayed at 4/4, pot 30 and the
human's current cards/actions; only Check attempt outcome remained enabled.
The server restarted while that SQL transaction was still in progress. HTTP
Refresh view plus explicit Disconnect/Reconnect live updates retained recovering
4/4 state. Actual COMMIT and an explicit outcome check returned the original
acknowledgement while the latest complete view had advanced through both Bot folds
to 7/7: 50-chip pot/payout, 33-chip uncalled return, human stack 1030.

A Bot top-up from 990 to 1100 then entered another real unresolved transaction.
Actual ROLLBACK preserved 7/7 and 990 chips. Checking that attempt displayed confirmed
noncommit and Start a new attempt. Deliberate new submission succeeded. Sit out,
Return to play and Set next button completed through normal management. Authorized
inspection revealed only completed Hand 1, including its 53-chip human commitment,
folded Bot holdings, 33-chip return and 50-chip payout. Hand 2 was explicitly started
and completed by legal human/Bot folds at 14/14. Hand 1 inspection stayed scoped,
while current normal views retained hidden folded Bot cards. A further ordinary
server restart and reload retained confirmed 14/14 with no pending attempt.

A second UI-created two-seat table used min/default/max buy-in 1/20/1000. Human
Call 10 against the all-in big blind completed a five-card river showdown
`3s As 8s 7c Tc`, paying 40 to the human and leaving the Bot at zero. The browser
rebought that actual zero stack to 20, explicitly selected the next button, started
Hand 2 and submitted legal Fold; it settled at 8/8 with a 20-chip payout and
10-chip uncalled return. No production seed input or prebuilt engine state was used.

Fresh final desktop (1440×1000) and mobile emulation (390×844, touch, DPR 3) have
no horizontal overflow and no browser console errors. Mobile reveal is 44px high.
One Impeccable detector pass returned `[]`; captures were visually inspected.

- `C:/Users/sy/.codex/visualizations/2026/10/07/01a115dd-7d6d-79d2-82a4-f9d61deb33de/m1-15-desktop.png`
- `C:/Users/sy/.codex/visualizations/2026/10/07/01a115dd-7d6d-79d2-82a4-f9d61deb33de/m1-15-mobile.png`

## Checks and limits

Final `pnpm check` passes workspace types, **229 tests in 30 files**, production
server/Playground builds and dependency boundaries. Existing rules, reopening,
pots/payouts/conservation, participant/historical privacy, replay/restoration,
durable outcomes, Bot lifecycle and independent inspection checks pass.
README now describes full M1, actual versioned fingerprints (including mutation
source), random/record versions, runtime `POKER_ADMIN_MODE=false`, local commands
and executable recovery behavior.

This remains one local server process on PostgreSQL 17, with no multi-server locking
or generic recovery framework. Unknown/expired transaction evidence remains safely
pending; no age-based guess establishes abort. The bounded baseline/cooperative
async JobRunner cannot preempt arbitrary synchronous CPU work and waits for actual
running task settlement during close. The tests release their owned work/SQL in
teardown. Mobile evidence is Chrome emulation, not a physical-device test.

All ticket-owned fixture/Vite/Chrome bridge processes were stopped and the exact
isolated browser schema was removed and verified absent. Development databases,
other ticket resources and the integration branch were not changed by cleanup.
