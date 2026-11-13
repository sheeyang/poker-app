---
status: accepted
---

# Derive Presentation Phase Lengths from Shared Choreography

ADR-0032 gives each Presentation Phase a fixed server length per kind (deal 1.5 s, street 1 s, showdown 2 s, payout 2 s) and a 3-second pause between Hands at Online Tables. ADR-0038 then has the Trainer write its own motion lengths and only start them at each phase's start. The two disagree: slowed down so a player can follow it, the deal ran about 0.6 s past its phase and the flop about 0.4 s past its own, so an Action Window opened while cards were still landing; on a small table the motion ends early and the table sits still for no reason. Spec [#68](https://github.com/sheeyang/poker-app/issues/68) closes the gap.

## Decisions

- **One shared definition of presentation timing.** A presentation module in the shared contracts package, which the server and the Trainer both already depend on, holds every Presentation Phase's timing, the Next-Hand Countdown length, and the table's motion timings. Overlays (menus, dialogs, notices, the analysis panel) are not table events and keep their own timings in the web app.
- **Phase lengths come from the choreography.** For each phase that presents something (deal, street reveal, showdown, payout), a beat function takes what the phase presents and returns every inner beat as an offset from the phase's start, plus the total. The server sets the phase's length from that total, so a phase lasts exactly as long as its motion, by construction.
- **Each phase carries its inputs.** A Presentation Phase records what it presents, using only what the view already makes public. Every Trainer plays the same beats from the same inputs, so a viewer who watched from the start, one who joined late and one who reconnected mid-runout share one timeline. If a Trainer's computed total differs from the phase's own length (during a deploy), the phase is authoritative and the beats are scaled to fit it.
- **Settle replaces the pause between Hands.** A Settle is a Presentation Phase after every deal, street reveal, showdown and payout, in which nobody may act and nothing moves. Its length is a shared constant chosen by the phase it follows (and, after the payout, by table mode), and may be 0. An Action Window, and its Action Deadline, opens when the Settle ends; a Hand ends when the Settle after its payout ends.
- **The time to read a showdown is its Settle.** The showdown's beats end once the last hand is face up; the 1.2 s Settle after it is the time to read the turned hands before the pot is pushed. Reading time is stillness, so it is a Settle length, not a beat.
- **A refill is one that comes with the deal.** Practice's Rebuy & deal refills the empty stacks in the commit that deals (Deal's `refills`), and the deal's Phase Inputs name exactly those rebuys, so the deal lands them before the blinds. A rebuy made on its own between Hands (an Online Table's, or from Practice's table options) is shown as it arrives and has landed before the next deal, which it does not lengthen.
- **Only what is presented is an input.** The cards of the last Hand that fly back to the deck are not a Phase Input: a Trainer returns only the cards its viewer saw. Their flights are bounded instead, within one return beat of the deal, closer together the more there are, so no beat ends after the phase's total by construction.
- **A Trainer bends to the phase.** A phase whose Phase Inputs a Trainer cannot read (a server of another version, during a deploy) is played from what the view shows of it, fitted to the phase's own length, and never stops the table's motion.
- **Tempo.** Every beat is about 1.5× the first motion pass, with one exception: a split pot's awards land 300 ms apart (the first pass had 60 ms), so each winner's stack figure is seen to change on its own (spec story 12).
- **Dealing order is the engine's.** The deal goes out in the order the engine deals: clockwise from left of the button, and heads-up the button first. The first motion pass dealt heads-up from the big blind; the Phase Inputs record the engine's order, so the Trainer follows it.
- **Motion with no Presentation Phase** (bets, folds, checks, seat changes, chips added to a stack, the viewer's own seat change) uses the shared beat constants and still never gates play.

## Consequences

- Supersedes [ADR-0038](0038-time-table-motion-from-the-server-clock.md)'s client-written motion lengths, and [ADR-0032](0032-extend-table-sessions-for-shared-online-play.md)'s fixed per-kind phase lengths and pause between Hands. ADR-0038's other decisions stand: motion is timed from the server clock, never gates play, and has no motion preference.
- Changing how long the deal takes changes it on the server and in every Trainer at once.
- Schedules persisted before this change are not read; the product is not yet released.
