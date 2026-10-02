---
status: superseded by ADR-0021
---

# Enforce Information Visibility in CashGame

CashGame will own the gameplay observability seam over authoritative state and bind a stable Participant through `forParticipant(participantId)`. The resulting ParticipantCashGame facade explicitly constructs immutable participant-safe configuration, state, history, views, and presentation events without owning a separate game copy. Normal player-facing server code, Bots, Policies, and WebSocket projection use this facade rather than raw state or raw CashGameEvents. Privileged hidden-state inspection remains a separate completion-gated Research layer over TableSessionRecord data, not a CashGame method, and its result cannot be used as Policy input.
