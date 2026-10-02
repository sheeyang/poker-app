# Persist the Master Seed and Accepted Commands

The authoritative Table Session Record will contain version 1 metadata, the complete Game Configuration including its hidden master seed, and the ordered successful Cash Game commands. Each Hand derives an independent seed from the master seed and a stable authoritative Hand sequence, then deterministically shuffles its deck. Shuffled decks, derived Hand seeds, card traces, burn cards, RNG state, rejected commands, and Cash Game events are not separately persisted because they can be reconstructed from the single authoritative record. Research obtains completed-Hand hidden information by replaying that record.

Game Configuration is immutable for the lifetime of a Table Session in M1; different settings require a new Table Session with a newly generated server seed.

There is no Reset Table operation; callers create a new Table Session when a fresh game is desired.
