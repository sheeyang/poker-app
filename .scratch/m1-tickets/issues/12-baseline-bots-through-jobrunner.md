# M1-12: Play baseline Bots through the server JobRunner

## What to build

The Table Owner assigns each Bot a complete baseline Playing Strategy and starts a Hand. The server evaluates the Bot's immutable participant-safe decision through JobRunner, validates and selects a concrete action, and submits that action through the ordinary queued durable mutation path. The Playground remains responsive and shows Bot thinking and committed play.

M1 scope; apply accepted ADRs 0001, 0005, 0009, 0013, 0017–0019, 0022. This is a vertical slice of the playable foundation, not an invitation to implement later Trainer, product UX, replay tooling, Solver, or simulation milestones.

## Acceptance criteria

- [ ] A Strategy composes a logically stateless Policy with an Action Selector; configurations declare every output-affecting parameter. Policy evaluate and checkCompatibility receive the same immutable Observable Game View, with separate execution/configuration options, never a StrategyContext, live game/facade, WebSocket envelope, raw events, or master seed.
- [ ] UniformChoicePolicy gives equal probability to all legal unsized actions and legal Bet/Raise minimum/maximum choices, deduplicating coincident endpoints and including a sole short-all-in size once. It makes no poker-expertise claim.
- [ ] One Strategies-owned validator rejects empty/all-zero/duplicate/illegal distributions, invalid integer sizes, nonfinite/out-of-range probabilities, or sum drift beyond absolute 1e-9. It returns a new immutable PolicyResult preserving informational diagnostics, drops zero entries, and normalizes only tolerated drift.
- [ ] Canonical order is Fold, Check, Call, ascending Bet-to, then ascending Raise-to, independent of construction order. ProbabilitySelector samples this unchanged canonical distribution using its declared seed; HighestProbabilitySelector keeps the first maximum, replaces only for strictly greater probability, and consumes no seed.
- [ ] Expose independently selected baseline complete Strategies for each Bot, defaulting to UniformChoicePolicy/ProbabilitySelector with HighestProbabilitySelector available. Store controller assignments in the application aggregate rather than poker configuration or commands.
- [ ] One server-managed JobRunner owns bounded execution/concurrency, cancellation and explicit failures. Jobs receive immutable declared inputs and return plain data, never mutate the live CashGame, and cannot depend on undeclared randomness, mutable external state, or wall-clock decisions.
- [ ] Derive effective Policy and selector seeds independently from the versioned master-seed namespaces plus stable Participant/Decision identities. Deck consumption cannot be changed by Policy/selector consumption; identical implementations/versions/configuration/input/seeds reproduce distributions and actions.
- [ ] Returned Bot work re-enters the session queue and must match captured pokerRevision, ParticipantId, DecisionId, exact current Strategy identity/version/configuration, effective seeds, and evaluation request identity before the normal act submission. Metadata remains outside Policy input.
- [ ] Compatibility/validation/evaluation/selection errors, timeouts, or obsolete work submit no implicit Fold/Call/fallback, poker command, or revision advance. The Playground exposes thinking/failure, without blocking legal human actions or controlling engine progression.
- [ ] Accepted Bot actions atomically retain Policy and selector identities/versions/configurations and effective seeds or reconstructible provenance with the committed command; distributions remain derived. Restoration replays accepted ConcreteActions without rerunning historical Strategies.
- [ ] After restore or browser disconnect, resume required Bot work from current immutable inputs while human decisions wait for reconnection. Finishing a Hand never automatically starts another Hand.
- [ ] Public Strategy fixtures and real server/JobRunner/PostgreSQL/WebSocket tests verify uniform endpoint/short-all-in coverage, canonical validation tolerance and ties, seeded reproducibility/independence, snapshot safety, stale-result rejection, durable provenance, restore without historical reevaluation, and a complete browser human-versus-baseline-Bot Hand.

## Blocked by

- Draft ticket 09: Apply participant-specific reopening after short all-ins.
- Draft ticket 10: Resume a played Table Session after server restart.
- Draft ticket 11: Keep the Playground synchronized across reconnects.

