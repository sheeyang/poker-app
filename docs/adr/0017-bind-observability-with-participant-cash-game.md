# Bind Observability with ParticipantCashGame

CashGame will expose a participant-scoped ParticipantCashGame facade that binds one stable ParticipantId and constructs participant-safe views, historical projections, and presentation events. WebSocket updates contain a complete Observable Game View for synchronization plus optional Observable Presentation Events for animation; raw CashGame state and CashGameEvents remain server-side. Complete views make reconnects and missed updates self-healing, while presentation events are never an authoritative state delta.

The facade is projection-only: authenticated server orchestration submits mutations through CashGame, and binding an observer does not establish authorization. The server explicitly maps these projections to plain wire DTOs owned by `packages/contracts`, which does not depend on the engine.

Each facade is lightweight and short-lived, bound to one specific CashGame instance and ParticipantId; connections retain stable identifiers and obtain a new facade from the latest committed instance when needed. Its current and historical reads return immutable snapshots, with `getView({ at: { decisionId } })` preserving visibility at the historical decision. Asynchronous work receives those snapshots rather than retaining a facade or a live game reference.
