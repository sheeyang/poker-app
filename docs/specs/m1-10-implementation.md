# M1-10 implementation evidence

`ParticipantCashGame.getView({ at: { decisionId } })` reconstructs the exact
original observable configuration, state, and history through normal accepted
command replay. An unknown DecisionId, or one the stable Participant did not
observe, throws a `RangeError`. Current reads and historical reads remain
projection-only and return detached immutable plain data.

Observable history now contains each observed Hand's original decision states,
the accepted public actions, and its completed result when available. During a
Hand, prior accepted decisions appear without a completion result. Later
showdown holdings remain confined to later observations: they cannot change a
decision's cards, board, legal actions, seats, stacks, or prior history. Sitting
out permits public observation without a betting turn or private cards.
Leaving excludes subsequent Hands; movement and rejoining retain only the
stable identity's earlier observations. A new seat occupant receives no prior
Hand observations, including the previous completed Hand's cards in the current
view. Server HTTP and WebSocket mappings explicitly copy these safe fields.

The record remains exactly version metadata, complete authoritative
configuration, and accepted commands. It contains no observation snapshots,
decks, derived seeds, burns, RNG state, events, or application revisions.
`fromRecord` rejects unsupported versions, missing or extra fields, invalid
configuration, non-plain data, malformed commands, and semantically rejected
suffixes. It validates final invariants and returns a structured `invalid-record`
failure without a usable prefix, including when reconstruction throws.
Trusted construction rejects unsupported configuration fields so a successfully
created game's export always has the same supported replay format.

The server checks ownership before reconstructing a cold cached session and
deduplicates reconstruction across authorized reads and trusted controllers.
A malformed committed record returns a safe `record-restoration-failed` 503
on reads, mutation attempts, and WebSocket upgrades. Other owners receive 404.
The application aggregate still owns identity bindings, controller descriptors,
and both revisions; the engine receives none of them.

Validation on 7–8 October 2026:

- Public engine fixtures cover multi-Hand management and play, full current and
  historical round-trips, showdown visibility, leave/rejoin and sitting-out
  observation, independent forks, immutable exports, malformed suffixes, and
  identical future events/dealing after restoration.
- Real HTTP/WebSocket/PostgreSQL fixtures restart against the same committed
  schema, compare exact safe views and bindings/revisions, reopen both completed
  and unchanged human decisions, continue top-ups/new explicit Hands/Call/Check,
  and reject an externally corrupted suffix without serving a prefix.
- The named Chrome session `poker-m1-10` used isolated server/Vite ports
  3010/5180 and a separate PostgreSQL schema. The human created a configured
  table, seated two Participants, and started Hand 1. After restarting the
  actual server process, the exact confirmed decision was unchanged at revisions
  3/3, with `8c 8h` and two hidden opponent cards. Fold settled stacks at
  990/1010 and revisions 4/4. A second restart reproduced the complete view
  exactly, with no automatic next Hand. The user explicitly reopened, topped
  up to 1200, moved from seat 1 to seat 3, selected the button, and started Hand 2
  at revisions 8/8. Its human cards were `4c 3c`; the prior history retained
  seat 1. The 1280px capture was inspected, and the console contained only Vite
  connection and React DevTools notices. Assigned processes stopped and the
  isolated browser schema was removed.

The implementation merged integration `775913e`, including Check/Call/showdown,
live synchronization, and exact Bet/Raise sizing. An added public fixture locks
Raise-to 53 and Bet-to 31 through complete replay, preserving original full
raise minimums and Bet bounds (947 chips before later play reduces the current
maximum to 916). Historical views exclude later sizing and rejected malformed
sized suffixes return no usable game. `pnpm check` passed with 135 tests in 18 files,
workspace type checks, both production builds, and dependency boundary checks.
The frozen lockfile installation and `git diff --check` also passed.
