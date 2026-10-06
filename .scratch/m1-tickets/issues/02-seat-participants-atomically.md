# M1-02: Seat Participants through durable atomic mutations

## What to build

The Table Owner chooses an empty seat and buy-in for the human or a configured Bot in the Playground, submits a request, and sees the committed seat and stack. Establish the reusable per-session acceptance path here so subsequent poker operations inherit atomic rules execution, durable outcomes, revisions, and commit-before-publication behavior rather than implementing separate mutation mechanisms.

M1 scope; apply accepted ADRs 0011, 0012, 0015–0018, 0020, 0025. This is a vertical slice of the playable foundation, not an invitation to implement later Trainer, product UX, replay tooling, Solver, or simulation milestones.

## Acceptance criteria

- [ ] seatParticipant enforces stable participant identity, valid seat capacity, at most one occupied seat per Participant and one Participant per seat, and the inclusive minimum/maximum buy-in range; an omitted buy-in uses the default. Seat positions do not own identity or history.
- [ ] CashGame owns one private table/Hand state. A successful command evaluates a complete isolated draft, validates chip/seat invariants, replaces live state, and appends one accepted command atomically. Expected failures return structured rejections; unexpected defects cannot partially change state or history.
- [ ] CashGame.fork creates an independent working instance preserving configuration, accepted history, deterministic continuation, and domain identities; it records no command and shares no mutable state. toRecord returns a detached immutable version-1 replay-input record.
- [ ] The server authorizes Table Owner management, serializes one FIFO queue per Table Session, and allows different sessions to progress independently.
- [ ] The queued path resolves requestId/fingerprint before checking expectedPokerRevision. A successful seat mutation commits the accepted command, pokerRevision+1, sessionRevision+1, and processed outcome together before promoting the game and revisions or exposing the accepted view.
- [ ] Definitive domain/application rejections are retained outside the poker record and advance neither revision. Matching retries return the original acknowledgement/rejection without re-execution after later state changes; changed request contents reject reuse. PostgreSQL enforces the unique session/request identity.
- [ ] Confirmed rollback or a rejected draft leaves committed seats, stacks, accepted history, and both revisions unchanged. Unknown commit outcomes are distinguished from confirmed rollback and cannot trigger blind re-execution; full resolution is added in ticket 15.
- [ ] The Playground seat/buy-in controls refresh the committed participant-safe view and distinguish acknowledgement, domain rejection, stale state, and infrastructure/pending outcomes. Do not persist a complete view as an idempotent response.
- [ ] Public engine tests cover seat/configuration separation, buy-in limits, immutable exports, independent forks, and atomic rejection/controlled failure. Real HTTP/PostgreSQL tests cover authorization, FIFO and cross-session behavior, stale expectations, duplicate success/rejection, conflicting reuse, held commit, and confirmed rollback.

## Blocked by

- Draft ticket 01: Create an owned, persistent Table Session.

