# M1 final review corrections

Base integration: `implement/m1` at `b7a6c5b`. Corrections were kept together in
the existing `implement/m1-final` worktree after all fifteen ticket integrations.
The approved seams remain public CashGame/ParticipantCashGame, exported
Strategy/ranking, real HTTP/WebSocket with isolated PostgreSQL, and browser flows.

## Corrected behavior

Bot actor capture previously read the owner's human view first. An unseated or
departed human correctly has no current Hand/actor in that view, which stalled a
valid Bot-only Hand. Capture now searches bound Bot views for the Bot whose
Participant ID matches its current actor, and supplies only that Bot's complete
immutable participant-safe view to Strategy compatibility and evaluation. Its
decision identity, revision, assignment, input fingerprint and seed guards remain
in the existing orchestration path.

Hand presentation events previously ignored frozen observer membership. A Human
who left before two Bots' forced all-in Hand received their revealed holdings and
board despite an empty normal view/history. Every authoritative Hand event now
carries its originating Hand ID; management events keep their existing shape.
Participant projection gates Hand events against that Hand's frozen observer
membership and maps allowed fields explicitly. Copied/delayed batches retain
the correct context after later Hands and rejoining. Participant wire events keep
their existing shape; burn events still omit identities. Records remain seed plus
accepted commands, and explicit authorized completed-Hand inspection is unchanged.

Creation and mutation request fingerprints now share one private canonical JSON
serializer. The version prefixes, sorted object keys, array order and scalar
serialization are unchanged.

The lost-after-COMMIT live test now asserts recovery feedback precedes proven
promotion, eventually observes committed revisions 1/1 and the stable original
acknowledgement, and reconnects to the latest view. Its previous assertion assumed
the 100ms live recovery sweep could never complete before reconnect.

`PRODUCT.md` records the established engineering purpose, audience, workflow,
information boundaries and incumbent interface constraints requested by the final
interface review. No visual redesign was introduced.

## TDD and verification

The absent-Human Bot-only HTTP/PostgreSQL regression was RED with no completed
Hand before the actor fix, then GREEN with one completed Hand at 4/4. Additional
real regressions cover a sitting-out Human, leaving between Hands, and startup
resumption of a Bot-only decision with only the actual Bot's own cards/actions in
Strategy input.

The public ParticipantCashGame privacy regression was RED with fifteen leaked
events including both holdings and the board, then GREEN with an empty missed-Hand
event batch. A copied batch stays empty after rejoining and a later Hand; a seated
sit-out observer still receives their observed Hand's board and identity-free burns.
The real HTTP/WebSocket/PostgreSQL case confirms ordinary reads and live events
omit missed Bot-only all-in cards while explicit Admin inspection still succeeds
without changing revisions or the normal view.

Final `pnpm install --offline --frozen-lockfile` succeeds. `pnpm check` passes all
workspace types, **235 tests in 30 files**, server/Playground production builds and
dependency boundaries. Existing public creation, poker/controller idempotency,
key-reordering, rules, replay, recovery and information-boundary checks pass.

## Fresh browser evidence

The existing real recovery fixture used server 3025, Vite 5195 and isolated schema
`browser_recovery_6ed316790b8b4239b0f53c0bcf8af983`. Native Playground controls created
Table Session `2766e75c-e7e4-4feb-a03c-5466781ef384`, seated a human and two Uniform
Choice/Highest Probability Bots, explicitly started Hand 1, submitted legal
Raise-to 53, and selected Reveal Hidden Information after the automatic Bot folds.
The committed result was 7/7, a 50-chip pot/payout and 33-chip uncalled return;
normal folded Bot cards remained hidden beside explicit completed-Hand inspection.

Primary captures in
`C:/Users/sy/.codex/visualizations/2026/10/07/01a115dd-7d6d-79d2-82a4-f9d61deb33de/`:

- `m1-15-desktop.png`: 1440×1000 viewport, DPR 1, 1440×3602 full page from top.
- `m1-15-mobile.png`: 390×844 touch viewport, DPR 2, 780×12634 full page from top
  with the completed-Hand inspection expanded.
- Readable DPR 3 viewport evidence: `m1-final-mobile-top.png`,
  `m1-final-mobile-hand.png`, `m1-final-mobile-inspection.png` and
  `m1-final-mobile-bottom.png` (1170×2532 each).
- `m1-final-mobile-bottom-dpr2.png` verifies the full-page capture's clean end.

Both primary captures begin at scrollY 0. Desktop and mobile document widths
match their viewport widths; no horizontal overflow or console errors were found.
Mobile reveal is 44px high. The DOM has one header, one title and one app root.
An initial DPR 3 full-page mobile capture exceeded Chrome's 16,384-pixel texture
limit and wrapped the header at its end; the DPR 2 primary replacement avoids
that artifact. Evidence is Chrome emulation, not a physical-device test.

The task-owned fixture, Vite process and named Chrome bridge were stopped. The
fixture dropped its exact isolated schema; local development data and other
agents' resources were preserved.
