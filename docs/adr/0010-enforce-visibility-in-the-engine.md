# Enforce Information Visibility in CashGame

The public CashGame module will own the gameplay observability seam over authoritative state and expose only immutable participant-specific Observable Game Configuration, Observable Cash Game State, and Observable Session History values. Policies never receive internal PokerCore state or unrestricted records; privileged hidden-state inspection is a separate completion-gated Research layer operating on authoritative TableSessionRecord data, not a CashGame method, and its result type cannot be used as Policy input.
