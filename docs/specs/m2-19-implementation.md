# M2-19 implementation evidence

Table Session Trainer configuration now retains one complete Reference Strategy and the Live Analysis setting independently of Bot Playing Strategies and the engine-owned poker record. New sessions default to UniformChoicePolicy with ProbabilitySelector and Live Analysis off.

The owner-only configuration operation uses the existing serialized, idempotent mutation and uncertain-commit recovery path. Committed settings advance sessionRevision, publish complete owner views, and restore after restart. They advance neither pokerRevision nor poker commands. Unsupported descriptors, stale revisions, conflicting request IDs and unauthorized changes produce definitive safe rejections. Following the existing pre-release record policy, restoration rejects aggregates missing the required configuration rather than silently changing their meaning.

## Validation

- The implementer passed 15 focused configuration tests and the related Bot, live, recovery and restoration checks. The full pre-connection-merge suite passed 256 tests with two workers; typechecks, builds and dependency boundaries passed.
- After integrating the shared connection, both implementer and merger passed 38 configuration, shared-live and Bot lifecycle tests. The complete integration branch at `97fcf59` passed **258 tests in 32 files** against real PostgreSQL with `node node_modules/vitest/vitest.mjs run --maxWorkers=2`.
- Real database coverage includes defaults, complete descriptor retention, independent Bot assignments, authorized updates, idempotency, stale revisions, conflicting reuse, validation, rollback, commit-before-publication and restart restoration. Socket fixtures wait for initial delivery before checking committed publication, so teardown cannot race an unopened connection.

## Two-tab Playground check

The coordinated check used the real server's isolated PostgreSQL schema, the shared transport relay, Vite at `http://127.0.0.1:5184`, and two tabs in an isolated Chrome session.

1. Create a Table Session through the ordinary Playground button. Verify ProbabilitySelector, Live Analysis off and revisions 0/0.
2. Open the same Table Session in a second tab. In the first tab choose HighestProbabilitySelector, enable Live Analysis and use **Save analysis settings**.
3. The HTTP view showed the full committed descriptor at pokerRevision 0 and sessionRevision 1. Both Bots retained ProbabilitySelector.
4. Without refreshing, the second tab displayed the new Reference Strategy, enabled Live Analysis and revisions 0/1. Neither tab reported an alert.
5. Restart the isolated server fixture and reload the second tab. The shared connection reestablished, and the exact descriptor, Live Analysis setting and revisions restored without alerts.

This verifies configuration controls and durability. Automatic Live Analysis and post-action evaluation belong to ticket #23.
