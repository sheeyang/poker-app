# M2 #23 implementation evidence

Every newly accepted human action now starts scored Reference Strategy analysis independently of Live Analysis and browser connections. Acceptance still commits the authoritative poker command and definitive acknowledgement before promotion. The postcommit hook captures the accepted original Decision through the same synchronous participant-safe helper used by explicit analysis requests, freezing its complete selected reference before a later queued preference mutation can run. Required Bot work is admitted first; analysis initialization is detached and exception-isolated, so computation or retention failure cannot change an accepted poker outcome.

## Acceptance and recovery

- Only a newly executed authorized human `act` creates a transient candidate. Rejected actions, Bot commands, configuration changes, pre-COMMIT failure and stored duplicate acknowledgements do not trigger analysis.
- An uncertain terminal COMMIT retains only a process-local request/fingerprint/Decision intent. It creates no analysis target while unresolved. Timer-driven recovery and explicit same-request resolution share the existing PostgreSQL transaction oracle and durable-outcome proof, restore the aggregate, resume admitted Bot work, and consume the accepted intent once.
- Confirmed noncommit cleanup includes attempts already marked `noncommit` by the resolver before reconciliation. Restart and shutdown discard transient intents; no analysis obligations, new durable job records or historical recovery sweeps were introduced.
- The selected complete Reference Strategy belongs to the new analysis request, with no reference assignment written onto accepted human actions. Analysis adds no poker commands or revision increments, and Bot selected-action provenance remains independent.

## Shared execution and Playground

- `analysis.getOrStart(input, purpose)` accepts typed Live, interactive, automatic and summary analysis purposes. Each new evaluation/scored entry retains its first submitted purpose. Matching requests share that entry without promotion, and explicit Retry retains the purpose. Scored requests propagate purpose to missing evaluation dependencies and score calculation on the same bounded runner.
- Live Analysis uses priority 1; automatic accepted analysis and all its newly submitted stages use priority 2. A fully matching live evaluation or in-flight job is reused after the action. Failed automatic admission is a readable analysis error rather than phantom pending.
- Enabling the committed Live Analysis setting automatically reconciles the current human target. Disabling it retires that display and hides pending/late output without cancelling shared work. The latest accepted human decision is selected and reconciled automatically, while explicit current/historical inspection remains available.
- Existing exact request/attempt/connection guards, notification-during-fetch reconciliation, readiness refresh, successful cache retention and failed-only Retry continue to apply. Legal play remains available throughout, without polling or a feedback Continue gate.

## Verification

The new real HTTP/WebSocket/PostgreSQL browser driver `scripts/smoke-automatic-browser.js` passed six cases: enabling Live Analysis without inspection, disabling/hiding late work, automatically showing accepted scores with Live Analysis off and matching evaluation reuse, notification-driven HTTP without polling, explicit scored Retry, and readiness reconciliation after disconnected completion. The inherited evaluation (12), two-tab Retry (6) and scoring (7) drivers also passed, for 31 browser cases. The evaluation driver now expects automatic scored failure after accepting a decision whose evaluation failed; all drivers can share an isolated configurable control port.

Desktop 1440px and narrow 500px snapshots were inspected, with no horizontal overflow. The browser tool's native resize floor was 500px; no smaller viewport result is claimed. The single mechanical detector pass returned `[]`. The established engineering UI and styling remain in place.

The browser stack was stopped, including the isolated Chrome bridge/MCP, server fixture, owned schema, HTTP/WebSocket relay and Vite, before serial repository tests.

Eleven public-boundary automatic-analysis tests passed against real PostgreSQL. They cover accepted actions without a browser, held/failing computation with Bot progression, uncertain COMMIT, confirmed rollback, precommit/rejected/duplicate suppression, restart without a recovery obligation, capacity errors, fixed priorities for evaluation/scoring/Retry, frozen original Retry inputs and live-to-scored sharing.

Existing Bot fixtures now distinguish their controlled Bot Strategy from ordinary human reference work. The timeout/FIFO capacity scenarios use real Bot-only Hands to isolate their original queue assertions without changing limits. Evaluation notifications are selected by exact request identity, and scored persistence/capacity faults are installed before human acceptance so they cover automatic work.

The final serial full suite (`node node_modules/vitest/vitest.mjs run --maxWorkers=1`) persisted passing results for all 36 files, covering this branch's 304 tests. The terminal session expired during an interruption; results were recovered from Vitest 5.0.3's `node_modules/.vite/vitest/da39a3ee5e6b4b0d3255bfef95601890afd80709/results.json`, where every file has `failed: false`. No terminal exit code or elapsed-time summary is claimed for that recovered run. The affected five files were also checked directly after fixture changes, with the two final Bot-capacity cases passing in a subsequent focused run. Final typecheck passed with exit code 0.

Final `pnpm build`, `pnpm check:boundaries`, and `git diff --check` passed. No additional browser/server processes remained active during these checks.
