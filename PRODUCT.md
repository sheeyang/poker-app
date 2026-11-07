# Poker product context

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

The primary users are poker players studying their decisions on desktop and
mobile browsers. They play Texas Hold'em against Bots, and examine numerical
outputs from a selected Reference Strategy. They can also play other people at
Online Tables. The hosted product is open to the public, and anyone can create a
table as a Guest. A specific skill level, or a need for instruction in poker
basics, has not been established.

## Product Purpose

Let a human play no-limit Hold'em Cash Game Hands and study how their concrete
decisions align with a chosen Reference Strategy. Hands are played against Bots
at a Practice Table or against other humans at an Online Table. The Trainer
supplies numerical evidence for the player's interpretation without prescribing
an action or labeling a decision good or bad.

Success means the player can configure and continue a Table Session, play legal
actions, understand confirmed table state, and inspect Strategy outputs and
alignment results on desktop and mobile. Analysis and presentation must not delay
gameplay or make its correctness depend on an animation. At Online Tables, each
player's study settings and results stay private from everyone else at the table.

## Positioning

Bot Playing Strategies and the human-selected Reference Strategy are independent.
Players can study a Reference Strategy's complete Policy distribution, concrete
sizings and selected action alongside their own accepted decision. A sampled
Reference action is distinct from the distribution and need not have its highest
probability.

Decision Score and Action Rank Score measure Policy alignment. They do not measure
EV, regret, accuracy, objective strategic quality or long-run frequency calibration.
The currently implemented baseline Strategies are testing controls and support no
claim of poker expertise or Solver quality.

## Product Principles

1. Preserve player agency: present numerical Strategy evidence without advice or
   evaluative judgments.
2. Keep play authoritative and continuous: confirmed server state governs the
   table, independently of animation and analysis completion.
3. Make analysis interpretable: distinguish probabilities, selected actions,
   scores, references and incomplete results.
4. Protect information boundaries in every state, including animation, recovery
   and completed-Hand inspection.
5. Support the complete play-and-study workflow on desktop and mobile.

Use the terms in [GLOSSARY.md](GLOSSARY.md).

## Open Decisions

- Final product name, voice and binding brand assets or commitments.
- Depth of terminology help and onboarding for the intended poker-player audience.
- Specific accessibility requirements or conformance targets beyond the existing
  requirement that optional presentation must not govern gameplay correctness.
