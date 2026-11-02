# M4-04 implementation evidence

At a Practice Table the server now paces the deal and each street reveal. Each accepted transition schedules its Presentation Phases (deal 1.5 s, street reveal 1 s) in the Persisted Table Session, in the commit's own transaction. The current decision's Action Window opens when the last phase ends. Earlier actions are rejected with `action-window-not-open`, and a Bot is asked for its decision only at the window's wake-up. Views and live updates carry the schedule and the server time. The Trainer estimates the server clock from those timestamps, reveals hole cards and streets at their phase starts, and enables action controls only inside the viewer's window. The behavior is described in the [server protocol reference](../server-protocol.md#play-timing).

The only new test seam is the `clock` server option. Timing tests in `apps/server/test/presentation-phases.test.ts` drive a `ManualClock` (`apps/server/test/fixtures/clock.ts`). Earlier server tests that are not about timing use an `InstantClock`, whose time jumps to each timer as soon as it is set, so every phase has ended when a commit's response arrives. Pure web tests in `apps/web/test/presentation.test.ts` cover clock-offset estimation, which steps are revealed at a given time, and when action controls are enabled.

## Browser check

On 2 November 2026, using the [schedule browser fixture](../local-development.md#schedule-browser-fixture) behind the live-transport relay, a heads-up Practice Table in an isolated Chrome profile showed:

- After the deal, the action controls were disabled during the 1.5 s deal phase and enabled at its end.
- The live frames for three revisions (human Call, flop dealt, Bot's flop Check) and the follow-up read were held well past the flop phase. On release, newest first, the client went straight from preflop to the flop with the human to act, without replaying the elapsed phase. The older frames did not move it back.
- A replayed old revision was ignored, and the client matched a fresh server read.
- With the turn-deal revision dropped and the follow-up read held, the client never saw the turn's phase. It synchronized from the next revision, with the turn shown and the human to act.
- With live frames held, the flop view arrived over HTTP about 0.8 s before the human's window opened. The controls enabled 34 ms after the window's server time, not 1 s after receipt. Released frames changed nothing.
- Server-side, each Bot acted 20–30 ms after its window opened.
- The Simple Heuristic Bot folded to every all-in, so no runout was shown in the browser. The server test and the pure web test cover runouts.
