# M1-13: Recover Bot failures and change Playing Strategies safely

## What to build

When a Bot fails or is incompatible, the Table Owner sees an actionable failure in the Playground, can retry the unchanged decision, or can explicitly choose another baseline Strategy. Strategy changes are application configuration mutations, and only work matching the current decision and exact controller request can submit an action.

M1 scope; apply accepted ADRs 0009, 0018–0020. This is a vertical slice of the playable foundation, not an invitation to implement later Trainer, product UX, replay tooling, Solver, or simulation milestones.

## Acceptance criteria

- [ ] Expose owner-authorized Bot Retry and Change Playing Strategy through safe HTTP requests and Playground controls; do not grant humans permission to act as Bot Participants.
- [ ] Retry an unchanged failed decision with the same declared inputs/configuration/effective seeds, retaining a distinct orchestration request identity so an older completion cannot win a race.
- [ ] A committed controller/Strategy assignment change uses expectedSessionRevision and the shared session queue, stores a definitive idempotent outcome, and advances sessionRevision only. It fabricates no poker command and does not advance pokerRevision.
- [ ] Compatibility, evaluation, validation, selection, timeout, and infrastructure failures remain explicit controller outcomes; transient thinking/failure status is not a revisioned poker mutation, and none produces a fallback action.
- [ ] Check exact current assignment/version/configuration, seeds, request identity, Participant/Decision and captured pokerRevision after job return inside the queue. Reject late results even for the same DecisionId when assignments/configuration or request identity changed.
- [ ] Cancellation is an optional resource optimization, never the correctness check. A failed/cancelled/obsolete job cannot overwrite a newer status or submit an old action.
- [ ] Persist original accepted Bot-action provenance unchanged when assignments change. After restart, restore current controllers and resume only current work, without rerunning already accepted historical decisions.
- [ ] The Playground displays failure reasons, Retry/Change Strategy, current assignment and thinking state, stays responsive for legal human actions, and synchronizes controller changes by sessionRevision through complete envelopes.
- [ ] Real job/server/PostgreSQL/WebSocket race fixtures cover repeated retries, assignment replacement during work, same DecisionId/new configuration, timeout/error/no action, poker advancement, duplicate configuration requests, expected-session revision rejection, restart, and provenance preservation.

## Blocked by

- Draft ticket 12: Play baseline Bots through the server JobRunner.

