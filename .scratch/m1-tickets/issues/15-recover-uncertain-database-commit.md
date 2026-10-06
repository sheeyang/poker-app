# M1-15: Recover unknown database commits without duplicate play

## What to build

If the server loses confirmation of a database commit, the affected operation becomes visibly pending/recovering rather than appearing accepted or rolled back. The server pauses the affected Table Session's mutation/Bot submissions, resolves the actual durable outcome, reloads confirmed state, and returns the original definitive result or confirmed noncommit. The owner can then continue from the accurate Playground view.

M1 scope; apply accepted ADRs 0013, 0016, 0018–0020, 0022. This is a vertical slice of the playable foundation, not an invitation to implement later Trainer, product UX, replay tooling, Solver, or simulation milestones.

## Acceptance criteria

- [ ] Differentiate confirmed commit, confirmed rollback/noncommit, and unknown outcome for creation, poker mutations, and application configuration mutations. Never assume rollback merely because COMMIT acknowledgement was lost.
- [ ] Enter per-session recovery after ambiguous commit; pause that session's mutation queue and Bot submissions until resolution, while independent sessions can proceed. Creation recovery uses authenticated user/requestId before a TableSessionId exists.
- [ ] An initially absent processed-request row does not prove noncommit while the original transaction remains unresolved. Reconcile durable transaction/outcome state and reload the confirmed aggregate before accepting new submissions.
- [ ] For eventual commit, return the original stored acknowledgement/rejection, promote/load the matching committed game and revisions together, and synchronize a complete safe view without duplicate command execution.
- [ ] For confirmed noncommit, keep the committed state unchanged and do not automatically re-execute the original attempt. A human can submit a new requestId; Bot orchestration may freshly evaluate the still-current decision.
- [ ] Pending queued requests and late jobs cannot bypass recovery or submit work for obsolete restored state. After resolution they must satisfy the same expected revisions, request identity, controller assignment and decision validity checks.
- [ ] Durable success outcomes, definitive domain/application rejections, and conflicting requestId reuse keep the existing semantics during/after restart and recovery; stored responses are small outcomes, not old observable views.
- [ ] The Playground distinguishes a stored rejection, rollback/infrastructure failure, and unresolved recovery, and shows actionable confirmed state when ready. No uncommitted working state/proposed revisions leak over HTTP or WebSocket.
- [ ] A narrow fault-capable persistence wrapper controls held transaction timing, lost acknowledgements and confirmed failures around real PostgreSQL transactions; it does not replace the database or expose engine mutation escape hatches.
- [ ] Real integration fixtures cover lost confirmation with eventual commit, confirmed noncommit, an initially absent request row during unresolved commit, creation ambiguity without duplicate seed/session/bindings, application-only mutations, Bot queue pause/late results, and restart while resolving.
- [ ] Run a real browser recovery flow against the server/database: create, seat human/Bots, explicit start, legal sized play through completion, between-Hand management/top-up/rebuy, disconnect/reconnect and restart/recovery, then continue from confirmed state. Keep the existing rule, visibility, replay, atomicity and durable-outcome checks passing; completed-Hand inspection has its independent ticket.
- [ ] Document local recovery behavior and its executable checks, and run workspace type/build/dependency-boundary checks. Record formats/random algorithms/fingerprints remain explicit/versioned; no browser engine imports, later-milestone features, multi-server locking, throughput targets, or pre-release compatibility guarantees are added.

## Blocked by

- Draft ticket 13: Recover Bot failures and change Playing Strategies safely.

