# M1-03: Deal a heads-up Hand and settle a fold

## What to build

With the human and one Bot seated, the owner explicitly starts a heads-up Hand from the Playground. The human receives their private cards and first decision, can Fold, and sees the Hand settle without revealing the winning Bot's hole cards. This is the first complete playable path and establishes dealing, participant projections, high-level action acceptance, and engine-owned Hand/Decision identities.

M1 scope; apply accepted ADRs 0009, 0011–0018, 0021, 0022, 0025. This is a vertical slice of the playable foundation, not an invitation to implement later Trainer, product UX, replay tooling, Solver, or simulation milestones.

## Acceptance criteria

- [ ] startHand rejects an already-active Hand or fewer than two eligible Participants; eligibility requires being seated, not sitting out, and having at least one chip before forced contributions. Freeze Hand membership and seats, and preserve Participants made all-in by forced contributions.
- [ ] The initial button defaults to seat 1 and resolves clockwise to an eligible seat. Heads-up, the button posts the small blind, receives the first hole card, and acts first preflop; the other Participant posts the big blind. Contributions are capped by remaining stacks without changing configured blind sizes.
- [ ] Define and version master-seed derivation encoding, namespace/identity inputs, deterministic random generation, unbiased range sampling, and shuffle as explicit v1 algorithms. Derive deck seeds independently by authoritative Hand sequence; define separate Policy/selector namespaces for later jobs, without exposing the master seed.
- [ ] Use one standard 52-card deck and deal two private hole cards in clockwise passes. Public HandId and DecisionId are deterministic domain identities, not server concurrency revisions.
- [ ] ParticipantCashGame.getView constructs one immutable configuration/state/history snapshot bound to stable ParticipantId, while projectEvents physically constructs safe presentation events. It is projection-only and never grants authorization or owns copied game state.
- [ ] The human sees their own hole cards and public seats/stacks/contributions/current actor; the Bot's unrevealed cards, burns, future cards, deck order, master seed, and raw events are physically absent from serialized data. The server checks the user's controller binding before accepting the acting Participant's action.
- [ ] act accepts a normal ConcreteAction and uses shared legality with its current observable description. For the fold path, settle a lone live hand immediately, return unmatched excess rather than creating a one-Participant side pot, and do not expose the winner's cards or burn/deal unused future streets.
- [ ] startHand and act include every consequence in one atomic accepted command and use ticket 2's durable path. No revisions/request metadata enter engine arguments, records, results, views, or Policy inputs. Successful commands advance server revisions once each.
- [ ] The Playground exposes explicit Start Hand, safe cards/actor/stack/pot information, and Fold for the human decision; a completed Hand waits for another explicit start. Early fixtures may drive other Participants through trusted server/test orchestration, never browser impersonation or production authorization bypass.
- [ ] Seeded public engine and real HTTP/PostgreSQL tests establish deterministic initial dealing, uniqueness, heads-up positions, fold settlement/conservation, own-versus-opponent serialization, wrong actors, active-Hand setup rejection, atomic failures, and commit-before-visible completion.

## Blocked by

- Draft ticket 02: Seat Participants through durable atomic mutations.

