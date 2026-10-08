# M1 final review

Reviewed the full integration against the approved M1 specification and all 15
tickets. Fixed comparison:
`git diff 8a00ee14932b4f6547a38778f37969f288bdcf02...b7a6c5bbc2857f3d4ae00e392ddd14dbffcd8e27`.
The independent Standards and Spec reviewers examined the same pinned change.
Their original findings are kept separate below, including their original
priorities. All accepted corrections were made in one implementation worktree
at `b8e14a1` and merged as `22f0a409025aa9892481e2e13d57c74bc60f7e70`.

## Standards

- **P2 documented-standard breach: Bot actor discovery depended on the human
  observer.** `apps/server/src/mutations.ts:74` read
  `session.game.forParticipant(session.aggregate.bindings[0]!.participantId).getView().state.actorId`.
  An unseated human's restricted view omitted a valid Bot-only Hand, preventing
  its required controller work and startup resumption. This conflicted with
  ADR-0018's restoration of controllers and required Bot work, and ADR-0019's
  orchestration through the JobRunner. **Resolved:** discover the self-acting Bot
  through its own participant-safe view. Real HTTP/PostgreSQL regressions cover
  unseated humans, departure between Hands, sitting out, and startup.
- **P3 judgement call: possible Duplicated Code in fingerprint encoding.**
  Creation and mutation services independently implemented recursive `canonical`
  encoding with `value.map(canonical).join(',')` and `Object.keys(value).sort()`.
  **Resolved:** one private server serializer, preserving version prefixes and
  all fingerprint input/encoding semantics. Existing durable idempotency and
  key-reordering checks pass.

The Standards reviewer confirmed both original findings resolved by source and
regression inspection. Tool-enforced rules were excluded. Explicit wire mapping
and the ParticipantCashGame facade were retained under the repository's ADRs.

## Spec

- **P1: Bot-only Hands stalled when the human was unseated.** The specification
  requires “starting requires at least two eligible Participants” and “then resume
  required Bot work for the current decision.” The human-observer actor lookup
  violated these requirements after valid Hand start, Retry, and restart.
  **Resolved:** Bot actor discovery and the real regressions described above.
  A seated sitting-out human remains an observer and did not independently
  reproduce the original failure.
- **P2: Hand presentation events bypassed absence visibility.** The specification
  requires “absence and rejoining cannot invent missed information.” An absent
  human's normal view/history omitted a Bot-only all-in Hand, while its projected
  events exposed that Hand's board and revealed holdings, even without Admin
  Mode. **Resolved:** authoritative Hand events retain their originating HandId;
  participant projection checks that Hand's frozen observer membership. Copied
  batches remain hidden after rejoining. Safe wire shapes and management events
  are preserved. Public engine and real HTTP/WebSocket tests cover the boundary;
  explicit authorized completed-Hand inspection still works.

The Spec reviewer confirmed both original findings resolved and found no material
regression in their corrections. No additional concrete missing requirement or
unrequested scope extension was established.

Original findings: **Standards 2, worst P2; Spec 2, worst P1.** Both axes have zero
unresolved original findings. Validation of the combined merge is recorded below.

## Interface and documentation

A fresh reviewer checked desktop and mobile evidence against the functional M1
Operate contract. The first mobile full-page capture was rejected because its
ending repeated the header; a clean recapture passed the evidence gate. The
five-section review found only a missing product-context document. `PRODUCT.md`
now records the existing purpose, scope, information boundaries and incumbent
interface. The reviewer scored this persistence fix **resolved**, with disposition
**ship** covering that scored fix. No material UI defect was established in the
functional-scope review; source was sampled rather than exhaustively inspected.

The fresh documentation check verified PRODUCT.md, styles and component samples.
It preserved the coherent incumbent interface. The pre-existing absence of
DESIGN.md and its sidecar was reported; no visual-system change was approved.
Polished product UX and animations remain deferred to M3 by the specification.

## Completion verification

Frozen offline installation and the integrated `pnpm check` pass: **235 tests in
30 files**, all workspace typechecks, server/Playground production builds, and
dependency boundaries. Browser evidence covers real session creation, seating,
exact sizing, Bot play, payouts, management, recovery across restart, deliberate
resubmission, continued play and completed-Hand inspection. See the
[correction evidence](m1-final-review-fixes.md) and [M1-15 evidence](m1-15-implementation.md).
Mobile evidence is Chrome emulation, not a physical-device test.

All fifteen tickets are closed. The integration branch is `implement/m1`.
Implementation worktrees and task-owned fixture processes/schemas are removed.
The implementation remains scoped to one local authoritative server and the
bounded baseline Strategies described in the specification and README.
