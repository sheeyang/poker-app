# Derive Strategy Adaptation from Observable History

Policies will be logically stateless and receive the current Observable Cash Game State, Observable Game Configuration, and complete Observable Session History for their participant. Adaptive Policies derive opponent models or statistics from that participant-safe projection of authoritative history; any future caches or checkpoints remain disposable optimizations rebuildable from it rather than Strategy-owned memory.

Do not introduce persistent Strategy memory, memory lifecycle APIs, Strategy snapshots, or checkpointing as a logical source of truth. Simple Policies may ignore history, while exploitative or adaptive Policies may derive as much legally observable information as they need. The server constructs inputs from an immutable ParticipantCashGame snapshot; CashGame exposes game-domain information and never depends on Strategy or offers a Strategy-specific context API.
