# Derive Strategy Adaptation from Observable History

Policies will be logically stateless and receive the current Observable Cash Game State, Observable Game Configuration, and complete Observable Session History for their participant. Adaptive Policies derive opponent models or statistics from that authoritative history; any future caches or checkpoints remain disposable optimizations rebuildable from it rather than Strategy-owned memory.
