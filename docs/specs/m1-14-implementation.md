# M1-14 implementation: completed-Hand inspection

Ticket: https://github.com/sheeyang/poker-app/issues/14.
Base: integration `implement/m1` at `bf1592d`.

## Behavior and boundaries

An authenticated Table Owner explicitly posts a requested Hand ID to
`/api/table-sessions/:id/inspect-hand`. Admin Mode defaults on. Server configuration
`adminMode:false`, or `POKER_ADMIN_MODE=false` for the normal server entry point,
disables backend reveal and removes the Playground inspection control.

The server checks identity and ownership before loading private durable inputs.
Research receives only the permitted Table Session Record, Table Session ID and
requested Hand ID. It restores an isolated CashGame and uses immutable `getHand()`
facts. Missing Hands and active Hands are rejected, including direct HTTP requests.
The purpose-built DTO explicitly maps only that completed Hand's hole cards,
contributions, board, burn cards, full reconstructed shuffled deck and drawn-card
count, positions, pots, unmatched returns and payouts. It contains no master seed,
game object, unrestricted record, current decision, or live hidden-information stream.

`CashGame.getCompletedHands()` returns a detached immutable list of authoritative
Hand IDs and sequences. This avoids deriving domain IDs from accepted commands.
Safe owner inspection metadata is outside `ObservableGameView`; it neither widens
Participant history nor enters Policy inputs. It includes completed Bot-only Hands
when the owner's human Participant was absent. Admin Mode off returns an empty list.

The exact per-server JobRunner already used by Bots owns Research execution. No
second runner or mutation FIFO was added. Inputs and outputs use its detached,
immutable plain-data boundary. Its existing capacity, cancellation and logical
timeout contract applies. Reconstruction uses in-process synchronous replay of a
finite committed record; timers cannot preempt synchronous CPU work. Heavy arbitrary
Research backends require an isolated execution adapter, as documented for M1-12.

Inspection does not change commands, either revision, the live CashGame, or durable
outcomes. It reads one committed record rather than a proposed aggregate. An old
completed-Hand result remains valid while later poker advances; Bot current-decision
revision guards do not apply to historical facts. The response stays confined to the
requested completed Hand even when that record also contains a later active Hand.

## Playground synchronization

The completed-Hand selector and explicit Reveal Hidden Information action sit
beside existing engineering controls. The result labels its Hand and displays
holdings, deal information and payout facts separately from current play. Human
legal actions remain available while a reveal is pending.

Capability activation uses only metadata from the current live socket. It is
independent of the gameplay cache's revision guard. The first full frame on a fresh
connection applies even at identical poker/session revisions after restart. HTTP
responses never activate inspection, so a delayed response from a previous server
cannot re-enable it, including when the initial gameplay cache was empty. The
connection fences old socket callbacks and orders metadata by sessionRevision;
older/duplicate full frames cannot regress the completed-Hand list. Connection or
table changes clear the selection, pending UI and result. A later fresh enabled
connection can activate inspection again.

## Verification

Public CashGame/ParticipantCashGame RED/GREEN established immutable completed-Hand
enumeration, restoration, absent-Participant history filtering and original decision
visibility. Real Fastify HTTP/WebSocket, the shared JobRunner and isolated PostgreSQL
cover owner authorization, unauthenticated/non-owner rejection, direct active-Hand
rejection, missing/unsupported requests, fold-win and showdown reconstruction, burn
positions, safe normal payloads, master-seed omission, unchanged record/revisions,
Admin Mode disabled after restart, Bot-only selection, shared capacity, human
responsiveness during queued work, and historical results after subsequent play.

The real browser fixture uses server 3014, relay 4014, Vite 5184 and its own PostgreSQL
schema. Ordinary UI controls created a two-seat Highest Probability Bot table,
seated both Participants, started Hand 1 and accepted Raise-to 40. Its 5/5 settlement
revealed both holdings, a 20-chip return and a 40-chip payout, while the current
table still hid the folded Bot's cards. Hand 1 remained scoped while Hand 2 was
active at 7/7. Holding its reveal response left the human Fold enabled; Hand 2
settled at 8/8 before the Hand 1 result arrived successfully.

Restarting Admin Mode off at unchanged 8/8 revisions removed the control and result;
direct reveal returned 403. Releasing an older enabled HTTP response did not restore
them. The same scenario with both initial HTTP and live delivery held first proved
the table cache was empty, then delivered fresh disabled live metadata before the
unseen old enabled HTTP response. Off/on restart restored access. Replaying an older
8/8 full frame after Hand 3 settled at 10/10 retained all three options and Hand 3
selection. Disconnecting during a held reveal cleared pending state and prevented
the delayed result from appearing; reconnect required another explicit reveal.

Desktop (1440×1000) and mobile emulation (390×844, touch, DPR 3) had no horizontal
overflow. The mobile reveal button is 44px high, native select/focus affordances
remain available, and helper text contrast on white is 6.36:1. One mechanical
Impeccable detector pass returned `[]`. Controlled fixture restarts produced one
temporary transport 502; a fresh final reload had no browser console errors.

Captures outside the repository:

- `C:/Users/sy/.codex/visualizations/2026/10/07/01a115dd-7d6d-79d2-82a4-f9d61deb33de/m1-14-desktop.png`
- `C:/Users/sy/.codex/visualizations/2026/10/07/01a115dd-7d6d-79d2-82a4-f9d61deb33de/m1-14-mobile.png`

Final `pnpm check` passed after merging integration `4844086`: workspace typechecks,
**218 tests in 29 files**, production server/Playground builds and dependency-boundary
checks. All ticket-owned server/control, relay, Vite and named Chrome bridge
processes were stopped. The exact isolated schema
`browser_inspection_918a548d01704d92aa60278642719633` was dropped and verified absent.
Other processes and databases were not changed.
