# M2-18 implementation evidence

The Playground establishes the existing local identity before connecting to one shared /api/live WebSocket. The authenticated user channel becomes ready independently of selected tables. Table changes and Close Table Session send correlated subscription commands without replacing that connection. Every subscription uses the existing ownership check and fresh participant-safe committed projection. The legacy table-specific live route remains compatible.

Contracts owns ClientLiveMessage, ServerLiveMessage and TableLiveMessage. The latter contains table-update, table-status and analysis-update. AnalysisUpdate contains only resource, tableSessionId, requestId, attemptId and completion/error status; numerical output stays behind HTTP. No fake jobs or analysis UI were added to demonstrate readiness. The server's publishUserUpdate closure is the integration point for authorized analysis delivery; the browser exposes onReady and onAnalysisUpdate callbacks with a connection generation, plus its current userChannel lifecycle.

Subscription commands serialize authorization and removal, buffer the initial complete view until acceptance is correlated, and remove all delivery registrations on disconnect. The browser reconnects with bounded backoff, restores its desired table subscription, cancels reads from the retired connection and reconciles through HTTP. Table revision guards remain shared between HTTP and WebSocket cache writes. Inspection capabilities are refreshed from each accepted subscription and connection; presentation events are never replayed for an already accepted revision. There is no normal polling.

## Validation

On 20 October 2026, after merging integration tip fab5cd2:

- pnpm check passed: all workspace typechecks, 243 tests in 31 files against real PostgreSQL, both production builds and package-boundary checks.
- The new real HTTP/WebSocket tests first failed at the missing authenticated shared endpoint, then at the absent correlated subscription response. They now cover cookie authentication, user readiness without a table, two simultaneous owned subscriptions, cross-user rejection, unsubscribe isolation, latest complete resubscription views and fresh subscriptions after disconnect.
- scripts/smoke-shared-live-browser.js passed through the real HTTP/WebSocket/PostgreSQL transport fixture: one connection with no selected table, table changes and closing without replacement, old-table delivery isolation, complete event-free resubscription, forced reconnect with restored subscription, and rejection of an older HTTP response held across reconnect.
- scripts/smoke-live-browser.js passed: ordinary creation, seating, explicit Start Hand, Fold and 990/1010 settlement, a missing revision, duplicate/reordered frames, held old HTTP reads, participant privacy, disconnect/reconnect, recovery feedback at unchanged revisions, table switching, and Admin Hidden Information reveal after resubscription. Its completed-Hand synthetic status check now uses recovery status, which the current UI displays outside an active Bot decision.
- The final isolated Chrome error console was empty. Browser processes were stopped and their isolated PostgreSQL schema removed.
- A broader test run exposed an existing Bot lifecycle assertion racing the next WebSocket frame. It now uses the same public-boundary expect.poll pattern as neighboring tests; no Bot production behavior changed in this ticket.

## Reproduce browser verification

Start three processes from the repository root using separate PowerShell terminals. A real PostgreSQL test database must be running. The application fixture creates an isolated schema.

1. Set TEST_DATABASE_URL to the real test database and run pnpm exec tsx apps/server/test/fixtures/shared-live-browser.ts (default API port 4021).
2. Set POKER_API_UPSTREAM=http://127.0.0.1:4021 and POKER_TRANSPORT_PORT=4022, then run pnpm exec tsx apps/server/test/fixtures/live-transport.ts.
3. Set POKER_API_TARGET=http://127.0.0.1:4022, then run pnpm --filter @poker/playground dev --port 5191.

Use a fresh isolated chrome-devtools-axi session, open http://localhost:5191, and evaluate scripts/smoke-shared-live-browser.js as a function. As in the M1 transport smoke, fetch the script through Vite's /@fs/ absolute workspace path and evaluate that source. Run the existing smoke-live-browser.js afterward. Each returns passed: true. The new driver starts with no selected table; if reusing a profile, close its selected Table Session first.

Stop the scoped browser bridge and the three development processes when finished. The application fixture's termination handler removes its schema.
