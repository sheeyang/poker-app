# Poker Platform

This project models Texas Hold'em play and analysis. It provides a reusable rules foundation for interactive training and strategy research.

## Language

**Poker Engine**:
The reusable domain component that governs a poker game according to a selected rules configuration.
_Avoid_: Game backend, table UI

**Cash Game**:
A continuing no-limit Texas Hold'em game governed by one Game Configuration, with participant stacks and seats persisting across Hands.
_Avoid_: Tournament, individual Hand

**Playground UI**:
The enduring engineering interface for exercising and validating platform capabilities before their product experiences are designed. It is independent of the participant-facing Trainer and Research Lab experiences.
_Avoid_: Trainer, final product UI, disposable prototype

**Trainer**:
The interactive experience in which a human plays hands against strategy-controlled participants and examines numerical Strategy outputs and alignment scores for their decisions.
_Avoid_: Poker game, practice mode, advice engine

**Research Lab**:
The analysis experience for comparing strategies and running automated strategy-versus-strategy simulations.
_Avoid_: Trainer, simulator

**Admin Mode**:
The application mode in which authorized privileged completed-Hand inspection and hidden-information reveal are available. It does not expand the information legally observable to a Participant or supplied to a Policy.
_Avoid_: Participant visibility, unrestricted gameplay

**Range Visualizer**:
The view of a selected Policy's distributions across every legal hypothetical hole-card combination in one fixed observable decision situation. It shows action distributions and concrete sizings without estimating the likelihood of holding a hand or reaching the situation.
_Avoid_: Reach range, opponent range estimate

**Equity / Poker Math Overlay**:
An optional view of poker arithmetic and estimated equity using participant-visible facts and explicitly declared opponent-range assumptions. Estimated results retain their computation method and uncertainty.
_Avoid_: Decision Score, objective strategic quality

**Complete Equity World**:
One mutually compatible assignment of hypothetical holdings to every live opponent and a remaining community-card combination under a declared equity model. Its probability follows that model's opponent ranges and chance assumptions.
_Avoid_: Actual deck, betting trajectory

**Burn Card**:
A card removed face-down from the top of the deck before a community-card deal. Its identity is unavailable to every participant and strategy during the hand.
_Avoid_: Discard, exposed burn

**Game Configuration**:
The complete authoritative choices that govern a Cash Game, comprising an Observable Game Configuration and a Hidden Game Configuration. Behavior without a configurable alternative follows the Poker Engine's documented default.
_Avoid_: Rules profile, house rules

**Observable Game Configuration**:
The Game Configuration values participants may legally know, including seats, blinds, ante, buy-in limits, and seat-change policy.
_Avoid_: Game Configuration, when hidden values could be exposed

**Hidden Game Configuration**:
Authoritative Game Configuration values unavailable through participant-facing views, including the master random seed.
_Avoid_: Observable Game Configuration

**Table Session**:
A continuing cash game whose seats, participant stacks, button position, and completed hands persist between Hands. A newly created Table Session has its own poker history and configuration.
_Avoid_: Match, tournament

**Table Session Record**:
The private durable representation from which an authoritative Table Session can be reconstructed and researched. It retains versioned deterministic inputs and accepted game commands, while participant-facing consumers receive only explicit observable projections.
_Avoid_: Observable Session History, live Cash Game object, event log

**Persisted Table Session**:
The complete application-owned durable representation of a Table Session, containing its Table Session Record, participant controller assignments, and Trainer configuration needed to continue the session.
_Avoid_: Table Session Record, Cash Game state

**Table Owner**:
The application user authorized to manage a Table Session and its participant controllers. Ownership is independent of the Participant through whom that user plays.
_Avoid_: Participant, button, dealer

**Participant**:
A human or Bot identified throughout a Table Session independently of the Seat they currently occupy.
_Avoid_: Seat, Strategy

**Seat**:
A numbered table position that may be occupied by at most one Participant and may change between Hands.
_Avoid_: Participant, position name

**Hand**:
One complete deal of Hold'em, from its initial forced bets through award of its pots.
_Avoid_: Round, game

## Strategy and Analysis

**Strategy**:
A Policy together with an Action Selector. The Policy defines the Strategy's intended action distribution, while the Action Selector chooses one concrete action from that distribution without changing it.
_Avoid_: Bot, solver, policy alone

**Policy**:
The logically stateless strategic reasoning that produces a normalized probability distribution over a finite set of Concrete Choices from declared inputs, including the Observable Game Configuration, Observable Cash Game State, and Observable Session History.
_Avoid_: Action Selector, Bot

**Policy Result**:
A Policy's distribution over Concrete Choices together with optional Policy-specific diagnostic information. It is distinct from the concrete action selected for play and from the Trainer's derived analysis of a decision.
_Avoid_: Selected action, Analysis Result

**Action Selector**:
The mechanism that selects the concrete action represented by one Concrete Choice from an already-computed Policy distribution without adding strategic reasoning or changing its probabilities.
_Avoid_: Policy, Strategy

**Playing Strategy**:
The Strategy assigned to control a Bot's decisions.
_Avoid_: Reference Strategy

**Reference Strategy**:
The human-selected Strategy used independently of every Bot's Playing Strategy to supply Policy distributions, concrete selected actions, alignment scores, and counterfactual comparison.
_Avoid_: Playing Strategy

**Live Analysis**:
Optional evaluation of the Reference Strategy for the human's current decision before they act. Its numerical results comprise the Policy's action probabilities and concrete sizings together with the Action Selector's selected action.
_Avoid_: Advice, best-action instruction

**Observable Session History**:
The immutable participant-specific projection of prior Table Session information that was legally observable to a Participant at each point after they joined. Strategies may derive adaptive information from it but do not own persistent cross-hand memory.
_Avoid_: Strategy Memory, unrestricted session history

**Bot**:
An automated participant controller that selects actions from a Strategy's distributions.
_Avoid_: Strategy, solver

**Solver**:
A computational system that produces a policy for a declared poker model together with the available evidence about its solution quality. A Solver's output may supply a Strategy, but the Solver is not itself a participant controller.
_Avoid_: Strategy, bot

**Solver-Derived Strategy**:
A Strategy backed by a Solver result whose modeled game, assumptions, abstractions, computation, and available solution-quality measurements are retained with it.
_Avoid_: GTO Strategy, unless the stronger claim is justified

**Observable Cash Game State**:
The canonical immutable representation of current Cash Game information legally visible to one Participant, including their available actions when they must act.
_Avoid_: Decision State, authoritative game state

**Observable Game View**:
The complete participant-safe view formed from Observable Game Configuration, Observable Cash Game State, and Observable Session History.
_Avoid_: Authoritative game state, research reveal

**Participant Cash Game**:
The participant-scoped view of one authoritative Cash Game. It constructs Observable Game Views, Observable Session History, and participant-safe presentation events for its bound Participant without owning separate game state.
_Avoid_: Cash Game, copied game state, authorization principal

**Observable Presentation Event**:
Optional participant-safe information describing a recent transition for animation or presentation. It is never required to reconstruct the current Observable Game View.
_Avoid_: Cash Game Event, state delta, authoritative history

**Concrete Choice**:
A legal Fold, Check, Call, Bet-to, or Raise-to option paired with its probability in a Strategy policy. Bet-to and Raise-to amounts are exact integer total commitments for the current betting street.
_Avoid_: Action bucket, sizing abstraction

**Counterfactual Comparison**:
Evaluation of multiple compatible Strategies against the same frozen Observable Cash Game State and Observable Session History, regardless of whether each Strategy would naturally have produced the preceding actions.
_Avoid_: Replay, simulation

**Decision Score**:
A normalized value from 0.00 to 1.00 measuring per-decision alignment between a human's complete concrete decision and the Reference Strategy's Policy. Unsized actions use their Choice probability; sized actions use the greatest same-type Choice probability multiplied by Sizing Similarity.
_Avoid_: Accuracy, Action Rank Score

**Sizing Similarity**:
An internal Decision Score factor comparing the additional chips committed by two Bet or Raise choices as the smaller amount divided by the larger amount. It measures numerical Policy alignment, not EV or strategic quality.
_Avoid_: Sizing Quality, bet quality

**Action Probability**:
The probability that a Strategy assigns to an action type, calculated by summing the probabilities of its Concrete Choices of that type.
_Avoid_: Decision Score, decision quality

**Action Rank Score**:
A normalized value from 0.00 to 1.00 representing the rank of the human's selected action type among all currently legal action types by aggregated Reference Policy probability, with tied action types sharing a rank.
_Avoid_: Decision Score, top-action agreement

**Analysis Result**:
Derived, reproducible analysis of a recorded decision by an identified Reference Strategy version and configuration. It may be cached, replaced, or recomputed without changing the Hand.
_Avoid_: Hand Record, authoritative score

**Score Summary**:
The pair of arithmetic means of Decision Score and Action Rank Score over a declared set of accepted human decisions evaluated against one fixed Reference Strategy. It is complete only when every required decision analysis has succeeded, and a set containing no human decisions has no score.
_Avoid_: Partial average, average of Hand averages
