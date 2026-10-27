# M3 Product Trainer Interface

The product Trainer now lives in `apps/web` and runs at `127.0.0.1:5174`.
`pnpm dev:trainer` starts it with the authoritative API and managed development
PostgreSQL. The engineering Playground was retired by ADR-0029.

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

## Initial implementation verification

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

## UX revision

The user rejected the initial interface as a styled Playground. The original
visual review above did not establish that the product journey was sufficient.
ADR-0028 now records the revised choose → play → review → continue sequence.

Start practice seats the full lineup and explicitly deals its first Hand from one
player gesture. Saved tables use observable game metadata rather than IDs. A
visible completed-Hand recap leads into street-specific review with safe cards;
manual selections remain pinned as subsequent Hands advance. Reference settings
are available from the analysis panel’s settings control. Rebuy & deal identifies and restores empty human/Bot
stacks while preserving intentionally removed or sitting-out opponents. Advanced
table administration stays outside the normal play loop.

Revision verification:

- Web TypeScript check, production build and workspace boundaries pass.
- Two frontend test files pass: eight tests, including resumed seating,
  duplicate-deal prevention, busted-opponent recovery and sitting-out behavior.
- Real server: Start practice reaches a playable six-player Hand without manual
  seating; Fold produces a visible recap and complete numerical summary.
- Rebuy & deal replenishes a busted opponent and starts Hand 2 while Hand 1 review
  stays pinned with its original cards and action.
- At 390×844, active betting controls occupy y=520–744 and the document has no
  horizontal overflow. Opening review focuses the panel at y=12; closing it returns
  to play. Nine-player seating also completes from Start practice.
- Desktop and mobile lobby, active play, completed Hand and contextual review
  captures are stored under `.impeccable/review/` as local development evidence.
- One mechanical scan exited 0 with advisory design-system documentation drift
  (color, font-size and radius values); its verbose output was truncated. This is
  not a claim of a clean scan. No second scan or unrelated drift repair was done.
- Independent UX verdict: **ship** for the seven scored fixes (first run,
  Hand completion, decision context, mobile use, repeat play, resumption and
  numerical meaning). This verdict covers that fix list, not a new whole-product
  usability study. DESIGN.md and the local schema2 sidecar now document the
  revised patterns while preserving the incumbent tokens.

## Completion — 24 October 2026

The user accepted M3 as complete after the final Trainer UI cleanup in commit
`1e37264`. M4 — Shared gameplay foundation is now the current focus. The current
eight-milestone roadmap defers elaborate animations to M5 and historical replay
and deeper analysis to M6; these are not outstanding M3 requirements.

The final interface includes a shared expandable decision box with aligned
collapsed scores, large scores first inside expanded details, and frozen
participant-safe situations with preceding opponent actions. The review header
keeps its size when toggled. Analysis settings and explanations use progressive
disclosure; complete numerical distributions, exact sizing choices and recovery
controls remain available.

The main table removes repeated labels and save messages, combines Hand/street
status, and keeps legal betting controls and mobile stack context. The compact
post-Hand recap retains both mean scores, with Review hand and Deal next hand
together. Rebuy/return explanations remain conditional. Setup and table options
use shorter copy, and Session summary names its actual behavior.

Final verification (performed for the implementation, not rerun for this status
update):

- Full repository suite: **44 files passed; 362 tests passed, one skipped** using
  `pnpm test --maxWorkers=2` with a temporary PostgreSQL database.
- All **16 frontend tests** passed; web TypeScript, production build and workspace
  dependency-boundary checks passed.
- Real browser checks confirmed a six-player Hand, automatic post-action and Hand
  scores, the relocated Review hand control opening its selected decision, and
  explicit Deal next hand reaching Hand 2.
- Desktop and 390×844 mobile checks confirmed the compact recap, paired actions,
  visible single save indicator, mobile stack context and no horizontal overflow.
- Layout detector returned no findings. Standards and Spec reviews had no
  remaining findings after the mobile save indicator was corrected.

Latest local screenshots are in `.scratch/ui-cleanup/` (ignored development
evidence). Earlier verification sections retain their historical scope and counts.
