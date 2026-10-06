# M1 ticket breakdown

Source: [M1 — Playable engine, server, and Playground](m1-playable-engine-server-playground.md), the current six-milestone plan, and its accepted ADRs.

Status: drafted for the to-tickets granularity/dependency review; GitHub publication follows approval. The source is a local spec and there is currently no parent tracker issue.

Each ticket is one narrow behavior spanning the engine or other server-side capability, durable aggregate/requests, Playground presentation, and behavioral tests. Establish the workspace as part of creating a usable table rather than a separate scaffolding ticket. No prefactor is needed in the current documentation-only repository.

The proposed testing boundaries remain public CashGame/ParticipantCashGame APIs and real HTTP/WebSocket with PostgreSQL, plus a small browser smoke. Focused exported Strategy/ranking checks are allowed where needed; private implementation structure is not a test contract.

Early play slices use trusted deterministic acceptance fixtures to drive other Participants until Bot automation is available. These fixtures use real validated command/queue paths and do not create browser acting-as-Bot controls, production authorization bypasses, temporary house rules, or implicit fallback actions.

Common acceptance for every delivered command: one semantic CashGame state owner; atomic rejection and defect isolation; accepted-command replay; server-owned revisions/request metadata; owner/controller authorization; idempotent definitive outcomes; commit before visible publication; physically safe DTOs; and no automatic next Hand.

## Proposed tickets

1. **Create an owned, persistent Table Session**
   - **Blocked by:** None (can start immediately).
   - **What it delivers:** Create and reopen an empty Table Session from the Playground with local identity, observable configuration, durable ownership, and idempotent creation.
   - [Full issue draft](../../.scratch/m1-tickets/issues/01-create-owned-table-session.md)

2. **Seat Participants through durable atomic mutations**
   - **Blocked by:** Ticket 1.
   - **What it delivers:** Place the human and Bots in seats with valid buy-ins, with one serialized, revisioned mutation path and durable success/rejection retries.
   - [Full issue draft](../../.scratch/m1-tickets/issues/02-seat-participants-atomically.md)

3. **Deal a heads-up Hand and settle a fold**
   - **Blocked by:** Ticket 2.
   - **What it delivers:** Start a two-Participant Hand, show only legally visible cards, and finish the Hand when the human folds.
   - [Full issue draft](../../.scratch/m1-tickets/issues/03-deal-heads-up-and-fold.md)

4. **Manage seats, button, top-ups, and rebuys between Hands**
   - **Blocked by:** Ticket 3.
   - **What it delivers:** Move, sit out, cash out, reseat, choose the button, and add chips between Hands while preserving Participant identity.
   - [Full issue draft](../../.scratch/m1-tickets/issues/04-manage-between-hand-participants.md)

5. **Play heads-up Check and Call through showdown**
   - **Blocked by:** Ticket 3.
   - **What it delivers:** Play a heads-up Hand across flop, turn, and river with automatic burns/deals, required showdown reveal, and correct best-five ranking.
   - [Full issue draft](../../.scratch/m1-tickets/issues/05-play-check-call-showdown.md)

6. **Play exact Bet-to and Raise-to sizes**
   - **Blocked by:** Ticket 5.
   - **What it delivers:** Use every legal integer bet/raise size with correct minimums and full-raise reopening through the Playground.
   - [Full issue draft](../../.scratch/m1-tickets/issues/06-bet-raise-exact-sizes.md)

7. **Play multiway Hands with antes and correct position**
   - **Blocked by:** Ticket 6.
   - **What it delivers:** Play with three through nine Participants, equal per-player antes, correct blind/deal/action order, and eligible button rotation.
   - [Full issue draft](../../.scratch/m1-tickets/issues/07-multiway-antes-and-order.md)

8. **Run out all-ins and settle main, side, and split pots**
   - **Blocked by:** Ticket 7.
   - **What it delivers:** Resolve all-ins automatically, return unmatched excess, settle layered pots and split/odd-chip payouts, and allow played-out Participants to rebuy.
   - [Full issue draft](../../.scratch/m1-tickets/issues/08-all-ins-and-layered-payouts.md)

9. **Apply participant-specific reopening after short all-ins**
   - **Blocked by:** Ticket 8.
   - **What it delivers:** Handle cumulative short all-in increases correctly, keeping displayed Raise availability and server acceptance identical.
   - [Full issue draft](../../.scratch/m1-tickets/issues/09-cumulative-short-all-in-reopening.md)

10. **Resume a played Table Session after server restart**
   - **Blocked by:** Ticket 4.
   - **What it delivers:** Restore complete multi-Hand poker state, participant history, ownership/controllers, and revisions, then continue the same session in the Playground.
   - [Full issue draft](../../.scratch/m1-tickets/issues/10-restore-played-table-session.md)

11. **Keep the Playground synchronized across reconnects**
   - **Blocked by:** Ticket 3.
   - **What it delivers:** Receive complete committed participant views over WebSocket and recover from gaps, duplicate updates, and disconnections.
   - [Full issue draft](../../.scratch/m1-tickets/issues/11-websocket-reconnect-sync.md)

12. **Play baseline Bots through the server JobRunner**
   - **Blocked by:** Ticket 9, Ticket 10, Ticket 11.
   - **What it delivers:** Play complete human-versus-Bot Hands using validated UniformChoicePolicy distributions, independent seeded selectors, and durable Bot provenance.
   - [Full issue draft](../../.scratch/m1-tickets/issues/12-baseline-bots-through-jobrunner.md)

13. **Recover Bot failures and change Playing Strategies safely**
   - **Blocked by:** Ticket 12.
   - **What it delivers:** Retry failed Bot work or replace a Bot's Playing Strategy without an implicit action or obsolete result overwriting current work.
   - [Full issue draft](../../.scratch/m1-tickets/issues/13-retry-change-bot-strategy.md)

14. **Inspect completed-Hand hidden information in Admin Mode**
   - **Blocked by:** Ticket 12.
   - **What it delivers:** Explicitly reveal completed-Hand hole cards, burns, and reconstructed deal facts through authorized server Research while protecting live play.
   - [Full issue draft](../../.scratch/m1-tickets/issues/14-inspect-completed-hand-admin.md)

15. **Recover unknown database commits without duplicate play**
   - **Blocked by:** Ticket 13.
   - **What it delivers:** Pause and recover an uncertain creation or table mutation, restore the confirmed outcome, and continue play without duplicate actions or publication.
   - [Full issue draft](../../.scratch/m1-tickets/issues/15-recover-uncertain-database-commit.md)

## Dependency rationale

- Ticket 1 is the only initial frontier; ticket 2 establishes the shared acceptance path and ticket 3 first completed Hand.
- After ticket 3, table management (4), normal betting (5 onward), and WebSocket synchronization (11) can progress independently.
- Restart restoration (10) follows table management (4), using the play behaviors available then; later rule tickets extend its replay fixtures as their commands land.
- Baseline Bot play (12) needs complete betting/reopening (9), restored controller/session boundaries (10), and live synchronization (11).
- Bot recovery/configuration (13) and completed-Hand inspection (14) can progress independently after the shared JobRunner arrives in ticket 12.
- Unknown-commit recovery (15) follows Bot retry/configuration (13) so it covers poker and application mutations plus queued Bot results. Inspection (14) is read-only and does not block commit recovery.

## Coverage and M1 completion

- Creation/configuration/local identity/ownership/package boundaries: ticket 1.
- Atomic CashGame commands, forks, durable FIFO/revisions/idempotent outcomes and confirmed rollback: ticket 2 and inherited acceptance in later command slices.
- Independent deck/Policy/selector randomness and initial dealing/privacy: ticket 3, exercised through ticket 12.
- Seating/identity/buy-in/top-up/rebuy/button/history continuity: tickets 2–4 and actual-play zero-stack fixtures in ticket 8.
- Complete Hold'em progression, ranking, wagering, positions, antes, all-ins, pots, payouts and reopening: tickets 3 and 5–9.
- Record format/restoration/historical visibility/continuation: ticket 10, with record fixtures extended in each later command feature.
- Safe HTTP/WebSocket, complete-view reconnect, gap/duplicate ordering and commit-before-publish: ticket 11 and durable recovery ticket 15.
- Strategy validation/canonicalization/selectors, JobRunner, compatibility, seeds, Bot provenance and restart work: ticket 12.
- Retry/change Strategy and exact current-result identity: ticket 13.
- Authorized completion-gated Research/Admin Mode inspection: ticket 14.
- Unknown commit, creation ambiguity, confirmed noncommit without auto-retry, Bot pause and recovery feedback: ticket 15.

M1 completes only when all 15 slices pass their acceptance criteria and the combined browser flow exercises creation, seating, explicit starts, legal sized human-versus-Bot play, settlement, between-Hand management/top-up/rebuy, completed-Hand inspection, reconnect, restart and commit recovery. Type/build/dependency checks and rule/visibility/conservation/replay/durability suites must pass. Each slice adds its own tests; there is no separate end-only testing ticket.

## Approval check

Review granularity (too coarse / too fine), genuine blocking edges, and any proposed merges or splits. Once approved, publish one ready-for-agent GitHub issue per ticket in topological order, substituting real issue references and native blocking relationships for draft ticket numbers. Source publication is not required for these self-contained issues; there is no parent issue to alter.

The invoked to-tickets skill says: “Iterate until the user approves the breakdown.”

