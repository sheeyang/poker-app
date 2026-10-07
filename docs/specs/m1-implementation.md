# M1 implementation

Integration branch: `implement/m1`. Starting commit: `8a00ee1`.

The user approved implementation of the complete M1 specification and all 15
tickets, including the proposed testing boundaries, on 7 October 2026.

The agreed behavioral boundaries are public CashGame/ParticipantCashGame APIs,
real HTTP/WebSocket with isolated PostgreSQL, focused exported Strategy/ranking
checks, and a browser smoke. Implementation follows the TDD skill and the
dependency graph below, with one ticket branch/worktree per slice.

| Ticket | Capability | Blocked by | Status |
| --- | --- | --- | --- |
| [#1](https://github.com/sheeyang/poker-app/issues/1) | Owned persistent Table Session | — | Complete: `f87b854`, 33 tests, browser/startup/checks |
| [#2](https://github.com/sheeyang/poker-app/issues/2) | Durable atomic seating | #1 | Complete: `43e687f`, 61 tests, browser/checks |
| [#3](https://github.com/sheeyang/poker-app/issues/3) | Heads-up dealing and fold settlement | #2 | Complete: `515ab9f`, 71 tests, browser/checks |
| [#4](https://github.com/sheeyang/poker-app/issues/4) | Between-Hand management | #3 | Complete: `0117f07`, 80 tests, browser/checks |
| [#5](https://github.com/sheeyang/poker-app/issues/5) | Check/Call through showdown | #3 | In progress |
| [#6](https://github.com/sheeyang/poker-app/issues/6) | Exact Bet-to/Raise-to | #5 | Pending |
| [#7](https://github.com/sheeyang/poker-app/issues/7) | Multiway play and antes | #6 | Pending |
| [#8](https://github.com/sheeyang/poker-app/issues/8) | All-ins and layered payouts | #7 | Pending |
| [#9](https://github.com/sheeyang/poker-app/issues/9) | Cumulative short-all-in reopening | #8 | Pending |
| [#10](https://github.com/sheeyang/poker-app/issues/10) | Played-session restart and history | #4 | In progress |
| [#11](https://github.com/sheeyang/poker-app/issues/11) | WebSocket reconnect synchronization | #3 | In progress |
| [#12](https://github.com/sheeyang/poker-app/issues/12) | Baseline Bots and JobRunner | #9, #10, #11 | Pending |
| [#13](https://github.com/sheeyang/poker-app/issues/13) | Bot retry and Strategy replacement | #12 | Pending |
| [#14](https://github.com/sheeyang/poker-app/issues/14) | Completed-Hand Admin inspection | #12 | Pending |
| [#15](https://github.com/sheeyang/poker-app/issues/15) | Unknown-commit recovery | #13 | Pending |

Completion requires the combined browser flow, type/build/dependency checks,
the rule/privacy/replay/conservation/durability suites, and the final Standards
and Spec code reviews. Source requirements remain in
[the M1 specification](m1-playable-engine-server-playground.md) and the linked
issues; this document records execution and validation evidence.
