# M3 Product Trainer Interface

The product Trainer now lives in `apps/web` and runs at `127.0.0.1:5174`.
`pnpm dev:trainer` starts it with the authoritative API and managed development
PostgreSQL. The separate engineering Playground remains at port 5173.

The user selected a classic poker room and confirmed that the table should lead,
with analysis in a collapsible side panel. The interface implements green oval
felt, safe cards and showdown, clear seats/turn/wagers/pots/payouts, legal integer
betting controls and bounded pot presets, table setup and continuing sessions,
seating and between-Hand management, Bot strategy assignment and explicit Retry,
Reference Strategy selection, optional Live Analysis, expanded unconditional
probabilities, separate selected reference actions, accepted-decision scores,
Hand summaries and a deliberate session-summary stopping point.

`packages/client` shares the existing HTTP transport, complete-view live
synchronization and analysis reconciliation with the Playground. It does not
import authoritative implementations. Mutation attempts are retained before
transmission and remain recoverable after uncertain responses. Dealing and burn
motion uses safe events and never controls confirmed state or legal actions.

## Verification

- Workspace typecheck passes.
- All application production builds and dependency-boundary checks pass.
- `pnpm test --maxWorkers=1`: **41 test files passed; 337 tests passed and one
  skipped**. The initial parallel run hit two timing failures in historical
  scoring and independent database startup; both passed isolated and the entire
  suite then passed serially.
- Frontend boundary tests cover pot conservation in presentation, total-commitment
  presets, short all-ins, integer bounds and stale snapshot protection.
- Real browser flow: create and seat six players; explicitly deal; accept a Call;
  show real showdown and payouts; receive automatic post-action and Hand scores;
  explicitly finish and display the frozen Table Session summary.
- Heads-up flow verifies Live Analysis, an expanded Raise parent with its exact
  unconditional sizing children, and rejection of fractional input `40.5`.
- Browser offline/online interruption retains the action request and confirmed
  view; restored connectivity resolves that same attempt and clears it.
- Desktop `1440×960` and mobile `390×844` captures verify completed and active
  states, legal sizing, full analysis, rebuy recovery and the summary dialog.
- Impeccable mechanical detector: no findings. Independent finish review:
  **ship**, with no material fixes.

Local review captures are in `.impeccable/review/` (ignored development evidence).
ADR-0028 records the product interaction and authority decisions. The design
system is captured separately in root `DESIGN.md` and `.impeccable/design.json`.
