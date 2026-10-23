# Simple Heuristic

User-approved temporary Strategy: make the Trainer feel like a casual poker table
without needing a strong opponent. This is basic poker reasoning, with no claim of
optimal play or objective decision quality.

## Agreed behavior

- Play fairly loose before the flop, using broad holding tiers.
- After the flop, consider made hands, obvious straight/flush draws and call price.
- Check misses, call modest bets with middling hands, bet stronger hands and
  occasionally bluff. Never fold when checking is free.
- Open around three big blinds. Usually bet half to two-thirds pot afterward;
  raises account for the wager faced and convert to legal total commitments.
- Reserve large commitments for strong hands or suitable short-stack situations.
- Make Simple Heuristic with Probability Selector the default Playing Strategy
  in new practice tables and the default Reference Strategy in new Table Sessions.
- Keep Uniform Choice and both existing Action Selectors available for playing
  and reference analysis. Reference selection remains independent of Bot play.
- Preserve every existing table's stored Playing and Reference Strategies and
  captured analysis identity. No migration or reinterpretation of old results.

## Version 1 behavior

`simple-heuristic/v1` has fixed rules and empty configuration, like the retained
Uniform Choice baseline. Changes to these rules require a new version. The Policy
is deterministic and stateless; Probability Selector supplies seeded variation.
It consumes only the actor's Observable Game View. No opponent model, simulation,
equity estimate, position-specific chart or additional engine API is introduced.

Preflop tiers distinguish premium pairs/AK, stronger pairs/broadways, playable
aces/suited cards/connectors and weak holdings. Postflop tiers distinguish private
pairs, top pairs/overpairs, two pair, sets and stronger made hands. Shared board
combinations alone do not count as personal monsters. Four-card straight and
flush draws only affect decisions before the river and must involve hole cards.

Pot sizing uses all observable contributions, including antes, folded chips and
the unmatched portion of the current wager. Both postflop sizes are rounded to
integer chips, clamped to the engine's legal bounds and deduplicated. Preflop
reraises target three times the current price. A call above three-quarters pot
or 35% of remaining stack is treated cautiously. Committing at least half of the
remaining stack requires a premium hand, or a strong hand with at most ten big
blinds available on this street. A separate shove choice takes a small share of
aggression only for those hands when short or when the stack is within twice the
pot after calling. Weak hands sometimes bluff with small bets; they do not bluff
away large portions of their stack.

## Validation boundaries

Agreed with the user: public Policy/Strategy APIs and table creation/configuration
APIs, plus existing UI checks. Review against pre-change commit
`30506d478c820e79936cec922c1f4a91305cb6e4` and this specification.
