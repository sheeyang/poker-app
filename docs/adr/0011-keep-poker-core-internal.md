# Keep PokerCore Internal Until a Second Ruleset Exists

The engine package will expose a deep stateful CashGame module while keeping PokerCore as an internal stateful module for generic card, chip, contribution, pot, and conservation mechanisms. With only one concrete ruleset, a public Core seam would make callers orchestrate low-level mechanics without demonstrated reuse; a second real ruleset may justify extracting a public interface after its genuinely shared behavior is known.
