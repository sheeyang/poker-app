# Poker Platform

This project models Texas Hold'em play and analysis. It provides a reusable rules foundation for interactive training and strategy research.

## Language

**Poker Engine**:
The reusable domain component that governs a poker game according to a selected rules configuration.
_Avoid_: Game backend, table UI

**Cash Game**:
A continuing no-limit Texas Hold'em game governed by one Game Configuration, with participant stacks and seats persisting across Hands.
_Avoid_: Tournament, individual Hand

**Trainer**:
The interactive experience in which a human plays Hands at a Practice Table or Online Table and examines numerical Strategy outputs and alignment scores for their decisions.
_Avoid_: Poker game, Trainer table, advice engine

**Research Lab**:
The analysis experience for comparing strategies and running automated strategy-versus-strategy simulations.
_Avoid_: Trainer, simulator

**Admin Mode**:
The application mode in which authorized privileged completed-Hand inspection and hidden-information reveal are available. It is never available at an Online Table and does not expand the information legally observable to a Participant or supplied to a Policy.
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

**Practice Table**:
A Table Session in which one human Participant plays only against Bots. Each Hand starts only by explicit deal, it has no Join Link, and its mode is fixed when it is created. Its human never leaves it, so it stays in their practice history to return to at any time.
_Avoid_: Trainer table, solo table

**Online Table**:
A Table Session that Guests join through its Join Link to play against each other, with or without Bots. It always has an Action Time Limit and Automatic Dealing, and its mode is fixed when it is created.
_Avoid_: Multiplayer table, shared table

**Current Table**:
The one Online Table a Guest is at, from creating, joining or returning to it until their Leave Table or Removal takes effect. A Guest has at most one, while they may be at any number of Practice Tables.
_Avoid_: Current game, active table

**Closed Table**:
An Online Table that has ended, after 24 hours without activity or when its Table Owner left with no other human at it. No one can join or act at it, and its Table History stays readable. Practice Tables never close.
_Avoid_: Archived table, ended session

**Join Link**:
The address of an Online Table, through which Guests join it and Participants return to it. It never changes, and anyone at the table can pass it on.
_Avoid_: Invite, participant link

**Table Password**:
An optional secret, set by the Table Owner, that a Guest must give to join an Online Table through its Join Link. Setting, changing, or removing it does not affect Participants already at the table.
_Avoid_: Passcode, PIN

**Table Session Record**:
The private durable representation from which an authoritative Table Session can be reconstructed and researched. It retains versioned deterministic inputs and accepted game commands, while participant-facing consumers receive only explicit observable projections.
_Avoid_: Observable Session History, live Cash Game object, event log

**Persisted Table Session**:
The complete application-owned durable representation of a Table Session, containing its Table Session Record, its mode, and participant controller assignments with each human Participant's Guest and membership.
_Avoid_: Table Session Record, Cash Game state

**Table Owner**:
The human Participant who may manage a Table Session's options and Bots: its creator, or at an Online Table the human to whom ownership passed when the previous owner left. Ownership grants no control over, or private information of, another human Participant.
_Avoid_: Participant, host, button, dealer

**Participant**:
A human or Bot identified throughout a Table Session independently of the Seat they currently occupy.
_Avoid_: Seat, Strategy

**Human Controller**:
The application user who controls a human Participant's decisions and observes the table as that Participant.
_Avoid_: Player, owner, seat holder

**Guest**:
An application user who has not logged in, identified only by their browser and a display name they choose. Clearing the browser's site data, or using another browser, makes them a new Guest, who cannot reach the old one's tables.
_Avoid_: Anonymous user, account

**Table History**:
Every completed Hand of a Table Session, which a viewer reviews from their own participant-safe view: public information for every Hand, and their own hole cards and decisions in the Hands they were dealt. It belongs to the table: anyone who has been a Participant there may read all of it, including Hands completed after their Leave Table and at a Closed Table.
_Avoid_: Hand log, Observable Session History, Table Session Record

**Replay**:
Stepping through a completed Hand of Table History one Replay Step at a time, seeing only what the viewer could see at that point, never what was revealed later.
_Avoid_: Counterfactual Comparison, simulation, hand reconstruction

**Replay Step**:
One point in a Replay: before each decision, after each street reveal including every all-in runout street, and the Hand's result.
_Avoid_: Frame, event, Beat

**Overall History**:
Every Table History a Guest can read, with its filters and Score Summaries across Table Sessions. It lists only the Guest's own decisions, from Hands they were dealt into; its non-score filters (street, Position, action type, table mode, completion date, pot in big blinds) apply at once.
_Avoid_: Session summary, account history

**Seat**:
A numbered table position that may be occupied by at most one Participant and may change between Hands.
_Avoid_: Participant, position name

**Position**:
A dealt-in Participant's place in a Hand relative to the button, fixed when the Hand is dealt: BTN, SB, BB, then UTG, UTG+1, UTG+2, LJ, HJ, CO, with middle positions dropped at smaller tables. Heads-up, the button posts the small blind and is BTN/SB. Participants not dealt in have no Position.
_Avoid_: Seat, seat number

**Hand**:
One complete deal of Hold'em, from its initial forced bets through award of its pots.
_Avoid_: Round, game

**Stand Up**:
Leaving a Seat and cashing out its stack while remaining a Participant at the table. Sitting down again requires a fresh buy-in.
_Avoid_: Leave, cash out, leave table

**Leave Table**:
Ceasing to be at an Online Table, after standing up if seated. A Guest who returns keeps the same Participant. There is no Leave Table at a Practice Table.
_Avoid_: Stand Up, quit, disconnect

**Removal**:
A Leave Table imposed by the Table Owner. The Guest may join again like any other Guest, through the Join Link and any Table Password. During a Hand it is an After-Hand Request, the strongest one: nothing the Guest asks for undoes it.
_Avoid_: Ban, kick

**After-Hand Request**:
A change to a Participant asked for during a Hand (a human's Sitting Out, Stand Up, Leave Table or Removal, or the Table Owner's Sitting Out or removal of a Bot) that is recorded and applied for everyone together when the Hand ends, with the Settle after its payout. Everyone at the table can see it pending.
_Avoid_: Queued action, deferred command

**Sitting Out**:
A seated Participant's status that excludes them from new Hands, while keeping their Seat and stack, until they resume.
_Avoid_: Away, inactive, left

**Eligible Participant**:
A seated Participant with chips who is not Sitting Out and, at an Online Table, is either a Bot or a connected human. Only Eligible Participants are dealt into a new Hand.
_Avoid_: Active player, ready participant

## Play Timing

**Presentation Phase**:
A server-timed interval in which no Participant may act: the deal, a street reveal, the showdown or the payout, each followed by its Settle. It ends by server time, never by animation completion. A phase whose length comes from its beats carries its Phase Inputs.
_Avoid_: Animation, presentation window

**Phase Inputs**:
What a Presentation Phase presents, recorded on the phase, from which the server and every Trainer compute the same beats and so the phase's length. Only what the view already makes public: for the deal, who is dealt in and in what order, how many cards each, the blinds, and who was refilled with it (by Rebuy & deal) and by how much; for a street reveal, whose wagers are swept and how many board cards are revealed; for the showdown, whose wagers are swept and whose hands are turned up; for the payout, each Participant paid, in seat order, with what they won and what came back to them uncalled.
_Avoid_: Phase payload, phase data

**Beat**:
A timed moment of table motion, such as a card leaving the deck, a card landing or the line being swept, placed as an offset from the start of its Presentation Phase or of the table event that caused it. A presenting phase's beats, computed from its Phase Inputs, decide its length.
_Avoid_: Animation, keyframe, step

**Settle**:
The Presentation Phase after every deal, street reveal, showdown and payout, in which the table is still: nothing moves and nobody may act. Its length is a shared constant chosen by the phase it follows and, after the payout, by table mode; it may be 0. A Hand ends when the Settle after its payout ends.
_Avoid_: Pause, pause between Hands, delay, cooldown

**Action Window**:
The server-opened interval in which exactly one Participant may act on their current decision. It opens only after any preceding Presentation Phase ends.
_Avoid_: Turn, turn window, turn timer, action clock

**Action Time Limit**:
The Table Session setting that is either off or the duration of each human Participant's Action Window.
_Avoid_: Action Deadline, timer setting

**Action Deadline**:
The authoritative server time at which a human Participant's Action Window closes under an Action Time Limit. Actions arriving after it are rejected; Bots have no Action Deadline.
_Avoid_: Timer, turn deadline, Action Time Limit

**Timeout Action**:
The Check, or Fold when Check is not legal, that the server submits for a human Participant whose Action Deadline passes. It counts as that Participant's own decision.
_Avoid_: Auto-fold, default action

**Automatic Dealing**:
Play in which the server starts each subsequent Hand when its Next-Hand Countdown expires instead of waiting for an explicit deal. It is used only at Online Tables and deals only while at least one Eligible Participant is human.
_Avoid_: Auto-start, continuous play

**Next-Hand Countdown**:
The announced server time at which the next automatically dealt Hand starts. Eligibility is rechecked when it expires.
_Avoid_: Inter-hand timer

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
The Strategy in a Guest's Trainer Configuration, used independently of every Bot's Playing Strategy to supply Policy distributions, concrete selected actions, alignment scores, and the baseline of each Counterfactual Comparison.
_Avoid_: Playing Strategy

**Trainer Configuration**:
A Guest's Reference Strategy and Live Analysis setting, chosen once and used at every table, in review and in every summary. Changing it never changes analysis already requested.
_Avoid_: Table settings, per-table Reference Strategy

**Live Analysis**:
Optional evaluation of the Reference Strategy for the human's current decision before they act. Its numerical results comprise the Policy's action probabilities and concrete sizings together with the Action Selector's selected action.
_Avoid_: Advice, best-action instruction

**Allow Live Analysis**:
An Online Table option, visible to everyone at the table, that the Table Owner changes between Hands. Each Action Window captures it when it opens, so a change applies from the next decision; while it is off, Live Analysis is refused, and post-action analysis and scoring continue.
_Avoid_: Live Analysis setting (that is part of each Guest's Trainer Configuration)

**Reference Strategy Evaluation**:
The Policy Result and Action Selector's selected concrete action for one fixed observable decision situation and one complete Reference Strategy. Alignment scores additionally depend on the human's accepted concrete action.
_Avoid_: Decision Score, selected action alone

**Observable Session History**:
The immutable participant-specific projection of every prior Hand of the Table Session, including Hands before the Participant joined: public information for every Hand, and the Participant's own hole cards in the Hands they were dealt. Every Participant sees the same public history. Strategies may derive adaptive information from it but do not own persistent cross-hand memory.
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
