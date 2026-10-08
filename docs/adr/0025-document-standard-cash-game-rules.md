# Document Standard CashGame Rules Without Rules Profiles

The initial public game is No-Limit Texas Hold'em CashGame, with standard documented behavior rather than a separate rules-profile system. CashGame owns the rules below and the authoritative cards, chips, contributions, and betting state, using focused internal modules and invariant-preserving helpers rather than a separate PokerCore; configurable alternatives belong directly in game configuration only when there is a real use case. This keeps callers at the level of game intentions with one Hold'em rules implementation and one state owner, as defined in [ADR-0011](0011-use-a-holdem-specific-cash-game.md).

## Configuration and defaults

- Seat capacity defaults to `6` and is configurable as an integer from `2` through `9`, inclusive. CashGame configuration validation enforces this initial supported range independently of how many participants are currently seated.
- Default small blind is `10`, big blind is `20`, and equal per-player ante is `0`.
- Minimum, default, and maximum buy-in are each `1000` initially.
- The initial button defaults to seat `1`; if that seat is unavailable for the first Hand, resolve to the next eligible seat clockwise.
- Seat capacity, blinds, ante, buy-in limits, participant stacks through allowed buy-ins/top-ups, button position, and `allowSeatChanges` are configurable. Blinds and all chip amounts use representable integer chip units.
- The master seed is hidden authoritative configuration supplied by the server, not a user-facing setting. Different rules configuration requires a new Table Session under ADR-0015.

## Eligibility and seating

CashGame includes only seated participants with at least one chip who are not sitting out. At least two must be eligible to start a Hand. The chosen participants and their seat positions are frozen for that Hand; joining, leaving, moving seats, and external stack changes cannot alter an active Hand. Participants remain in the Hand after forced contributions reduce their stack to zero.

Outside an active Hand, `allowSeatChanges` permits movement to any unoccupied valid seat when enabled and rejects movement when disabled. Do not impose missed-blind obligations, blind debt, or seat-change penalties. CashGame applies seating changes through its private state helpers and preserves seat uniqueness.

ParticipantId remains stable through movement, leaving, rebuying, and rejoining. Seats do not own identity or history, and new occupants do not inherit a previous occupant's observations. Sitting out excludes a participant from the next Hand, not from the stable participant registry.

After a completed Hand, the next button advances clockwise from the previous button's seat to the next eligible participant, skipping empty, sitting-out, and zero-stack seats even if the prior button's occupant has left. An explicit between-Hand `setButton` to an eligible occupied seat overrides the next button position. Hand participants and blind positions are determined before collecting forced contributions.

## Buy-ins and top-ups

A joining participant may supply a buy-in within the minimum and maximum inclusive; omission uses the default. Buy-in validation and stack changes belong to CashGame. Losing below the minimum through play does not require rebuying or prevent continued play with a positive stack.

Between Hands, `topUpTo(participantId, targetStack)` means the desired resulting stack, not the number of chips to add. The target must exceed the current stack and not exceed maximumBuyIn; a zero-stack rebuy must also satisfy minimumBuyIn. A positive-stack participant may top up while remaining below the minimum. A zero-stack participant cannot join the next Hand until rebuying.

Do not let a seated participant remove chips while remaining in the cash game or use topUpTo to lower their stack. They must leave to cash out, and later rejoining preserves ParticipantId and history. Private chip-bookkeeping helpers preserve valid amounts and conservation while CashGame applies the permitted buy-in, top-up, and cash-out operations.

## Antes, blinds, and betting order

Only conventional equal per-player antes are supported initially: ante zero disables them, otherwise each Hand participant contributes `min(ante, remainingStack)` before blinds. A short contribution consumes the stack and makes that participant all-in. Ante chips enter the contribution ledger and pot but never the participant's preflop street wager, so they do not reduce the amount needed to call a blind.

For three or more participants, the small blind is the next participating seat clockwise from the button and the big blind is the next one after that. Heads-up, the button posts the small blind and the other participant posts the big blind. Blind contributions are limited by the remaining stack; a short blind does not change the configured blind sizes. Do not initially support big-blind antes, button antes, straddles, missed-blind posts, or other alternative forced-bet structures.

Multiway preflop action begins with the next participant able to act clockwise after the big blind; heads-up it begins with the button/small blind. Postflop action begins with the first live participant able to act clockwise after the button, so the non-button acts first heads-up. Folded and all-in participants receive no betting turns.

## Betting legality and reopening

Check is available only when nothing is owed; Call commits the amount owed or the remaining stack when that is smaller. Bet opens wagering, while Raise increases an existing wager. The minimum full opening bet is the big blind; a full raise must increase the wager by at least the last full bet or full-raise increment, with the big blind setting the initial preflop increment. A smaller bet or raise is permitted only when it is a genuine all-in.

A short all-in increases what other participants must call but does not by itself count as a full raise or reopen prior betting. Apply the full-bet/full-raise threshold for each participant who already acted; cumulative short all-in increases can reopen action when the total increase that participant now faces reaches the applicable full-raise threshold. Participants whose betting has not been closed retain their legal raise opportunities. CashGame tracks action completion and reopening, and its internal helpers apply validated contributions within the same atomic draft.

Accept every legal integer betTo or raiseTo, not just Strategy sizings. These amounts are the participant's total contribution on the current street after acting. An all-in is an ordinary Bet, Raise, or Call that exhausts the stack; it is not a separate action. Normal validation rejects wrong actors, illegal action types, invalid chip amounts, under-minimum non-all-in wagers, and raises when action has not reopened.

Observable legal actions and `CashGame.act()` validation derive from the same internal legality calculation, including reopening eligibility. Describe each legal Bet/Raise sizing as inclusive integer minimum/maximum bounds, or as a single permitted short-all-in amount when the participant cannot reach the full minimum. Do not emit an inverted interval, treat below-minimum non-all-in amounts as legal, or enumerate every possible chip amount. A sole short-all-in size remains a Bet or Raise description, not another ConcreteAction type. Policies select finite concrete sizes from these possibilities, and submission is revalidated against current authoritative state.

A betting round ends when every live participant still able to act has satisfied the round's action and matching requirements. One remaining live hand ends the Hand immediately. If no further betting decision is possible after outstanding Call/Fold decisions are resolved, reveal remaining live hole cards as required, run out the board, and settle automatically. The application does not request street transitions, burns, dealing, or settlement separately.

## Dealing and burns

Use a standard 52-card deck with no jokers, shuffled deterministically from the derived Hand seed. Deal two private hole cards per participant, one at a time in clockwise passes. With three or more participants, the first card goes immediately left of the button; heads-up, the button/small blind receives the first card.

After preflop, burn one and deal three cards for the flop; burn one and deal one for the turn; burn one and deal one for the river. Use precisely the same sequence for an automatic all-in board runout. A Hand ending before a later street never burns or deals unnecessary future cards.

Burns are removed face-down and their identities remain hidden in participant projections. Deal and burn events can drive face-down presentation without exposing identities. CashGame's private card/deck helpers preserve authoritative deck order and unique physical card locations while its dealing logic determines whether a drawn card is a hole card, burn, or board card. Both operate on the same private state, not separate authoritative card collections.

## Hand evaluation

At showdown, use the strongest five-card hand from two hole cards and five board cards, allowing zero, one, or two hole cards. In descending order, categories are Straight Flush, Four of a Kind, Full House, Flush, Straight, Three of a Kind, Two Pair, One Pair, and High Card; a Royal Flush is the highest Straight Flush, not another category.

Compare complete hand ranks and kickers. Ace is high or low in A-2-3-4-5 but cannot wrap around in K-A-2-3-4. Suits have equal rank and never break ties; identical best five-card ranks tie.

## Derived pots and payouts

CashGame maintains the contribution ledger in its private state and uses its internal pot-calculation module to derive pots by contribution layers instead of mutating a second pot source of truth. Folded contributions stay in the pot, folded participants lose eligibility, and a participant can win only layers covered by their own contribution. Different contribution caps produce the main pot and side pots, each with an amount and eligible participants. Return unmatched excess to its contributor rather than constructing a one-participant side pot.

Contribution layers are accounting boundaries. Coalesce adjacent matched layers when their live eligible Participant sets are identical; folded-only caps do not create separate contested pots. Keep layers with different eligible sets as separate pots even when their eventual winners are the same. For contributions 2/2/2/1/1 with the last three Participants folded, the two tied live hands split one 8-chip pot 4/4. If all five hands are live, the 1-chip all-ins remain eligible for main pot 5 while only the first three can win side pot 3; the same two tied winners can receive separate odd chips for a combined 5/3 split. This clarifies the standard all-in eligibility and dead-money semantics documented by [PokerStars' rules](https://www.pokerstars.com/poker/games/rules/); the folded-cap example is an inference from those semantics, not a separately published rule example.

CashGame settles every derived pot independently using the best eligible Texas Hold'em hand. Tied winners split equally in integer chip units; award remaining odd chips clockwise from the button among the tied winners, independently for each pot. With only one live hand, award its applicable pots without showdown. Returns and payouts use invariant-preserving internal transfers within the complete draft and conserve chips across stacks and contributions.

For example, contributions of 100, 300, and 300 create a main pot of 300 for all three and a side pot of 400 for the two larger contributors. Contributions of 100 and 300 create a matched pot of 200 and return 200 to the larger contributor, not a separate side pot.

## Showdown and visibility

A participant always sees their own hole cards. Opponents' hole cards remain hidden until CashGame makes them public. When all further betting is impossible, reveal every remaining live hand before running out the board; after river betting with multiple live hands, reveal all remaining hands at showdown. Revelation is automatic online-style behavior, not a show-or-muck decision. The order of reveal animations has no rules significance.

If everyone else folds, end and settle immediately without making the winner's hole cards public. Later showdown or privileged Research revelation never changes what was visible at an earlier decision. Only ParticipantCashGame supplies normal gameplay, Bot, and Policy information, and privileged completed-Hand reveal follows the Admin Mode boundary in ADR-0021.

Do not initially implement voluntary showing, optional mucking, requests to see mucked hands, slow-roll procedures, misdeals, exposed-card replacement, rabbit hunting, or manual dealer corrections. Add alternatives through explicit future configuration decisions only when a concrete use case needs them.
