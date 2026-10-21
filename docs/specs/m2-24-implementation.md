# M2-08 / #24 - Hand Score Summaries

Implementation branch: `codex/m2-24-hand-summaries`, based on integration `4e876d69e172ce9775e43ca76822bdaf1f22eb05` after #21/#22.

## Scope

Explicit authorized Hand-summary requests capture one committed snapshot: accepted human Decision IDs, original participant-safe inputs, one complete Reference Strategy, and captured poker revision. Summary manifests remain transient. Numerical members reuse the established analysis module and its successful PostgreSQL cache; aggregate arithmetic stays in Research and uses the application's shared JobRunner.

All Hand requests share one coordinator with batch size 2 and at most 2 outstanding unique dependencies or aggregate submissions. A logical timeout retains its slot until physical execution settles. No polling, recovery sweep, additional evaluator, runner, or connection class is introduced.

## Approved test boundaries

Real HTTP/WebSocket/PostgreSQL; Research public numerical functions; real Playground transport. The existing analysis module has small production result/settlement waits for orchestration, but no tests assert those internal methods or container layout.

## TDD evidence

- Empty Hand snapshot: first real HTTP run failed with 404; implementation passed and retained exact committed revision/reference/count with no evaluations.
- Research means: public calculation tests failed with missing function; implementation passed independent empty, one-decision, and `(0,0),(.3,.5),(0,0)` examples.
- Accepted decision: failed because response incorrectly remained empty; implementation passed complete independent `(0.25,0)` averages, owner-only summary notification without a table subscription, and unchanged poker state.
- Concurrent global bound: failed because 3 distinct evaluations started against the declared bound of 2; shared coordinator passed 3 cold tables plus an overlapping request and advanced from completion without another HTTP request.
- Frozen active-Hand Retry: red run reached missing Retry route after verifying failure precedence while another member remained pending. Implementation passed: concurrent Retry converges on one new attempt, preserves original inputs/seeds/reference/membership, reuses the still-active member, and returns independent complete means `(0.65,0.75)`.

## Validation

Seven real server scenarios were verified individually: empty metadata, accepted means/delivery, concurrent global bounds, frozen failed-only Retry, explicit runner-capacity error, physical timeout/repeated-Retry bounds, and restart with persisted member reuse. Research summary suite: 3 cases passed. Server typecheck passed after bounded scheduling/physical settlement additions. Physical timeout coverage passed after the test anchored its wait to the actual controlled Strategy abort, avoiding a race between equal one-second clocks. Old physical executions retain both global slots through repeated Retry. Restart coverage passed: old exact manifest reads/Retry return 404 and a new explicit snapshot reuses successful persisted members without evaluation. Broad/browser validation remains pending the shared runtime slot.
