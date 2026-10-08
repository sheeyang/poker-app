# Poker Playground product context

## Purpose and audience

Poker Playground is the enduring engineering interface for exercising the Poker
Engine and authoritative server before their separate Trainer and Research Lab
experiences are designed. Its M1 audience is a developer or local Table Owner
validating poker rules, participant visibility, persistence, recovery and Bot
behavior. It is an Operate interface: users perform explicit operations and inspect
the resulting confirmed state.

The product thesis is to let a local Table Owner exercise authoritative poker
behavior and understand confirmed state and actionable failures. Scope comes from
the [M1 specification](docs/specs/m1-playable-engine-server-playground.md), the
[current milestone plan](docs/milestones.md), [ADR-0022](docs/adr/0022-maintain-an-independent-playground.md)
and the terminology in [GLOSSARY.md](GLOSSARY.md). The [README](README.md) describes
local setup and protocols.

## M1 workflow

1. Establish a local browser identity and create or reopen an owned Table Session.
2. Choose fixed observable configuration and baseline Bot Playing Strategies, then
   seat the human and Bots with valid buy-ins.
3. Explicitly Start Hand. Submit the human's current legal Fold, Check, Call,
   Bet-to or Raise-to; the server runs the acting Bot's Strategy when needed.
4. Observe committed cards, stacks, pots, payouts and poker/session revisions.
   Complete views synchronize reads, reloads and live reconnects.
5. Manage Participants between Hands: sit out/return, move, cash out/reseat,
   top up/rebuy, and select the next button. Explicitly start each next Hand.
6. When an attempt is uncertain, retain confirmed state and explicitly check its
   outcome. Confirmed noncommit permits a deliberate new attempt; Bot failures
   offer Retry or a Playing Strategy change.
7. In enabled Admin Mode, explicitly select and reveal one completed Hand's deal
   and payout facts independently of current play.

The local Fastify server and PostgreSQL own authorization, accepted mutations,
durable outcomes and restoration. The browser identity cookie establishes Table
Ownership; browser storage only remembers the selected session. Baseline
Strategies are testing controls with no claim of poker expertise.

## Information and interaction constraints

Normal views, historical observations, presentation events and Policy inputs stay
Participant-safe. A missed Hand does not enter an absent Participant's normal
history or event stream after rejoining. Privileged inspection requires Table
Ownership, enabled Admin Mode and Hand completion; it never expands earlier
observations or Policy inputs. Hidden seeds and authoritative game objects remain
server-side.

Keep confirmed state visible during loading, failure and recovery. Use clear
labels, legal bounds, visible disabled states and specific next actions. Status
feedback can change independently of committed gameplay revisions. Presentation
events support optional rendering; the complete view remains the synchronization
authority.

## Established interface

Preserve the incumbent neutral engineering UI: system sans text, a light gray-green
ground (`#f3f5f2`), white work surfaces, dark green actions (`#19553e`), and labeled
native inputs/selects. Cards use concise rank/suit text as data. This records the
existing M1 interface and does not establish a new brand or visual direction.

The desktop first viewport contains the title and identity status, configuration
and reopen controls, and the Table Session work area. Narrow screens stack these
in document order. The work area groups the current Hand and legal actions before
Bot configuration, completed-Hand inspection, seating and between-Hand management.
Prioritize legible hierarchy, responsive reflow and safe information separation.

M1 is local development with one authoritative server process. Product accounts,
online multiplayer, publication/deployment and multi-server coordination are outside
its scope. The main product interface, polished product UX and animations are
deferred to M3 in the current milestone plan. Trainer analysis, deeper replay and
Research, Solver execution and mass simulation follow their later milestones.
