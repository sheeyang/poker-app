---
status: superseded by ADR-0005
---

# Make Strategy Memory Explicit and Snapshotable

Strategies may maintain cross-hand memory for adaptive play, but the strategy framework will own that memory as explicit, snapshotable, and persistable data rather than allowing opaque process state. Stateless Strategies omit it, while adaptive Strategies may update it only from information legally observable to their seat so replay and counterfactual analysis can reconstruct the same perspective.
