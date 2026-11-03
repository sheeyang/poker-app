# M4-05 implementation evidence

At a Practice Table the server now paces the whole Hand. Besides the deal (1.5 s) and each street reveal (1 s), an accepted transition schedules a 2 s showdown phase when hands are turned up and a 2 s payout phase when the Hand completes. An all-in runout is one accepted action, so it schedules the showdown, every remaining street, and the payout, in that order; a river showdown schedules the showdown and the payout; a Hand won by folds has only the payout. The complete result is already in the view and live update that announce a runout. The Trainer reveals each step at its server timestamp, without motion. The behavior is described in the [server protocol reference](../server-protocol.md#play-timing).

Deal is accepted when the latest Hand's payout phase ends. A Deal received earlier is rejected with 409 `payout-phase-not-ended`, judged by the time the server received it, as for Action Windows. The Trainer enables Deal, including Rebuy & deal, at that instant. Deal also ends the dealing human's voluntary sit-out inside the commit that starts the Hand (`set-sitting-out` then `start-hand`, one revision step); the Practice plan no longer sends a separate resume request. The table wakes at the end of the payout phase, including after a restart, which is the seam for after-Hand work.

Server tests in `apps/server/test/payout-phases.test.ts` drive a `ManualClock` through a river showdown, a fold win, a three-way all-in with side pots, the live update of a runout, the Deal gate and a restart during the payout phase, and Deal resuming a sitting-out human (and leaving them sitting out when the Hand cannot start). Pure web tests in `apps/web/test/presentation.test.ts` cover the order in which a runout is revealed (opponents' cards at showdown, then each street, then payouts), a fold-won pot, an earlier schedule without a payout phase, and when Deal opens.

## Browser check

On 2 November 2026, using the [schedule browser fixture](../local-development.md#schedule-browser-fixture) (system clock, automatic Bots), a heads-up Practice Table in an isolated Chrome profile showed:

- After the human folded, the seats showed `Folded` and `Won 20` with "Deal next hand" disabled. It enabled about 1.9 s after the result appeared, which is the 2 s payout phase less the delivery delay (the estimated server clock is never ahead of the server's).
- After sitting out between Hands in Table options, the button read "Return & deal". Clicking it sent exactly one request, `start-hand`, with no separate `set-sitting-out`. Hand 02 started with the human playing.
- The Simple Heuristic Bot folds to every all-in, so no runout was shown in the browser. Server and pure web tests cover runouts.
