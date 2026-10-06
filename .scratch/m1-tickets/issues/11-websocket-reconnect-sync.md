# M1-11: Keep the Playground synchronized across reconnects

## What to build

While a Table Session changes, the Playground receives the latest complete participant-safe view over WebSocket. Disconnecting, missing transitions, or receiving duplicate/out-of-order updates does not leave the table stale. This slice applies to the initial heads-up fold path and automatically carries later rules and management capabilities as they land.

M1 scope; apply accepted ADRs 0013, 0016–0018, 0022. This is a vertical slice of the playable foundation, not an invitation to implement later Trainer, product UX, replay tooling, Solver, or simulation milestones.

## Acceptance criteria

- [ ] Authenticate and authorize each connection's table/observer binding independently of client-supplied ParticipantId; never treat ParticipantCashGame binding as permission.
- [ ] Construct a fresh participant facade from the latest confirmed committed CashGame for each projection; connections retain identifiers rather than obsolete live game/facade references.
- [ ] Every update contains TableSessionId, committed pokerRevision/sessionRevision, a complete Observable Game View, and optional participant-safe presentation events from that same committed aggregate.
- [ ] Publish only after confirmed database commit, never a working fork or proposed revision. Revision metadata remains in the backend envelope rather than in the game view, Policy input, or engine record.
- [ ] Order by sessionRevision. Ignore duplicate/older envelopes, do not replay an already-processed revision's events, and accept a newer complete view across gaps without reconstructing missing events.
- [ ] Reconnect sends the current complete authorized view and both revisions; missed animations/events need not be replayed. The complete view, not presentation events, determines current cards/stacks/pots/actor.
- [ ] The Playground shows connection/reconnect status and refreshes stale state while preserving valid human action access. A human decision waits during disconnection; disconnection does not submit a poker command or change revisions.
- [ ] Serialized events omit unrevealed hole cards and burn identities; normal HTTP and WebSocket payloads omit hidden seed/configuration, future cards, deck order, unrestricted engine state, and raw CashGameEvents.
- [ ] Real HTTP/WebSocket/PostgreSQL tests hold/fail commit, disconnect/reconnect, introduce revision gaps/duplicates/reordering, and assert correct views, no leaked working state, authorization, and no repeated event processing.
- [ ] A small browser smoke demonstrates seating/start/fold completion plus reconnect to the latest view. Subsequent controller-only changes must synchronize using sessionRevision even when pokerRevision does not change.

## Blocked by

- Draft ticket 03: Deal a heads-up Hand and settle a fold.

