# M2 #22 implementation evidence

The existing analysis operation now accepts an owner's accepted human Decision ID as well as an unaccepted current decision. Historical Policy inputs come from `ParticipantCashGame.getView({ at: { decisionId } })`; the accepted action comes from committed participant-safe history. Later showdown, Admin inspection, management, and subsequent Hands cannot widen those original inputs. Observed Bot decisions are rejected as human score targets.

## Numerical interpretation and retention

- Research exports `calculateActionProbabilities` and `calculateDecisionScores`. The server supplies successful validated Choices, the original observable view, and the accepted ConcreteAction. The browser formats returned numbers and implements no scorer.
- Unsized scores use the matching Choice probability or zero. Bet/Raise scores compare only the same type, subtract the original actor's street `wager`, and maximize probability times smaller/larger additional commitment. Exact and off-grid legal sizes are supported.
- Action aggregation includes all legal types, with omitted types at zero. Rank scores use distinct descending aggregates with tied ranks shared; one distinct rank gives one. Scoring method `v1` treats aggregates within absolute `1e-12` of a rank representative as tied, avoiding an extra rank from decimal aggregation such as `0.1 + 0.2` versus `0.3`. Groups use their representative rather than chaining pairwise near-equality. Returned aggregate probabilities are not quantized.
- Evaluation responses now include their aggregate Action Probabilities alongside exact Choices and selected concrete action. Scores remain absent before an accepted action.
- Successful evaluations remain in `analysis_evaluations`; successful scores persist separately in `analysis_scores`. Score identity adds the exact accepted action and scoring-method version to the full evaluation identity. Scored resources retain their evaluation request ID, complete Strategy, safe-input fingerprint, effective seeds and implementation versions.
- A scored request reuses successful or in-flight matching evaluation work. Missing score calculation uses the same bounded JobRunner after its dependency completes. Concurrent consumers share one score request; completion is persisted and HTTP-readable before its authorized notification. No table subscription is needed.
- Failures remain readable without restarting on ordinary reads. Explicit Retry preserves the scored request and frozen inputs, changes its attempt ID, retries failed evaluation dependencies only, and reuses successful/active dependencies. Score persistence failure does not erase a successful evaluation. Dependency-load and capacity failures are explicit errors rather than pending jobs that were not admitted.
- Shutdown releases waiting dependency observers and discards old-lifecycle results. Transient failures/work are not recovered as durable obligations; requested historical targets reuse successful stored data or schedule missing work after restart.
- No poker commands, revisions, accepted human Reference Strategy assignments, or Bot Policy-distribution retention were added.

## Playground and browser verification

The Decision picker lists accepted human decisions from observable history while preserving the existing current-decision control. The result labels the accepted human action, Decision Score, Action Rank Score, Reference Strategy identity, selected concrete action, exact Policy distribution, and aggregate Action Probabilities separately. Legal play remains independent. Request/attempt/connection guards from #20/#21 remain in place, and target identity distinguishes evaluation-only from accepted-action analysis.

The real Chrome driver `scripts/smoke-scoring-browser.js` passed seven cases with real HTTP, shared WebSocket and PostgreSQL: evaluation output without premature scores, reuse after acceptance, notification-triggered HTTP without polling, historical inspection during later play, changed-reference isolation from delayed HTTP, successful scored reuse after restart, and explicit scored Retry without an implicit restart. The inherited twelve-case evaluation driver and six-case real two-tab Retry driver also passed on this branch.

Desktop 1440px and emulated 390px inspection found no horizontal overflow. Full-page and detail captures are in the local `.impeccable/review/` directory. The one mechanical detector pass returned `[]`; the fresh finish review returned `ship`, with no material fixes and no visual-system documentation changes required for this ordinary extension.

## Reproduce

1. Set `TEST_DATABASE_URL` to a real test database. Start `evaluation-browser.ts` with `POKER_EVALUATION_PORT=3064` and `POKER_EVALUATION_CONTROL_PORT=3066`.
2. Start `live-transport.ts` with `POKER_API_UPSTREAM=http://127.0.0.1:3064` and `POKER_TRANSPORT_PORT=4062`.
3. Run Playground Vite on 5234 with `POKER_API_TARGET=http://127.0.0.1:4062`, then open an isolated Chrome session.
4. Import the scoring driver as raw text through Vite and evaluate its returned Promise. `globalThis.scoringControl` can override its default control URL `http://127.0.0.1:3066`.
5. Call the fixture control `/stop` to close the real server and drop its owned schema, then stop the relay, Vite, and Chrome session.

Focused public-function tests use independently worked expected values. Real server tests cover historical visibility/reference capture, persistent and in-flight reuse, concurrent matching requests, owner-only readable notifications, score/dependency persistence failures, bounded admission, explicit Retry composition, and shutdown/restart behavior. The full repository validation result is recorded below after its final serial run.
