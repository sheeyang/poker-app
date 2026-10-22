# Introduce the Product Trainer Interface

M3 introduces `apps/web` as the participant-facing Trainer. `apps/playground`
remains the independent engineering interface. Both consume safe Contracts and
share HTTP, live synchronization and analysis-resource reconciliation through
`packages/client`; neither browser app imports authoritative implementations.

## Play and study

The table leads. A collapsible analysis panel presents the complete Reference
Strategy independently of Bot Playing Strategies. On desktop it sits beside the
table; smaller screens place it below the table and legal action controls. Live
Analysis defaults to off. Accepted decisions are analyzed without delaying play,
and remain labeled with their captured Reference Strategy. Probabilities use
`0.00–1.00`; scores use `/100`. Sized choices remain expanded and show original
unconditional probabilities. A selected reference action is presented separately
from its Policy distribution. Nothing labels a decision good, bad or optimal.

Completed Hands automatically request one Hand summary. The panel displays that
snapshot, including pending, empty and failed states. Finishing a play session is
an explicit action between Hands that freezes a Table Session summary. It does
not delete, reset or close the continuing server-side Table Session. The user can
keep playing or return to saved tables. Summaries show averages only when the
complete server result succeeds; failed analysis requires explicit Retry.

## Authority and recovery

Complete server views remain authoritative. Every mutation persists its exact
request ID and revision before transmission; an ambiguous response keeps that
attempt available for a same-ID status check. Definitive rejections release it.
A confirmed `commit-not-applied` result requires a deliberate new attempt.
Reload retains the selected table and unresolved request. Live readiness and
reconnect reconcile through HTTP; no normal-operation polling is introduced.

Bet-to and Raise-to controls submit integer total commitments for the street.
Quick amounts include the existing wager and call, then clamp to server-provided
minimum and maximum totals. Native number validation and explicit range checks
reject empty, fractional or out-of-bounds input before submission.

## Presentation

The user selected a classic green poker room, with the table dominant and study
in a collapsible side panel. Card faces use only visible card identities.
Opponent cards and burn cards remain face-down unless the participant-safe view
reveals them at showdown. New safe presentation events trigger short deal and
face-down burn motion. Complete views render immediately, and missed or skipped
animations never replay state transitions or gate legal actions. Reduced motion
and the user's animation preference disable motion without changing gameplay.

General historical navigation, replay, counterfactual comparison, range and equity
tools remain M4. This decision extends ADR-0017, ADR-0022 and ADR-0026; earlier
milestone numbers in those documents do not change the current six-milestone plan.
