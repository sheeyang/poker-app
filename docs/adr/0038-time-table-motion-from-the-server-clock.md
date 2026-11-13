---
status: accepted
---

# Time Table Motion from the Server Clock, with No Motion Preference

M4 reveals each step of a Hand at its Presentation Phase's start, without motion, and the Trainer played its few animations (dealing, the burn) when a live update arrived. That breaks for all-in runouts and reconnects: a settled runout arrives in one update, and a viewer who reconnects would replay whatever the update carries. M5 adds card, chip, reveal and payout motion on top of M4's shared phase contract and participant-safe views. The motion was chosen from a prototype of four groups with three or more variants each.

## Decisions

- **Motion presents changes between presented views.** The Trainer compares the table it showed last with the table `presentTable` shows now, and plans motion cues from the difference: a deal, a bet, a fold, a sweep, a street, a showdown, a payout, a seat change, chips added to a stack. Cues come from views, never from the order events arrived in, so a runout that arrives settled is still dealt street by street as its phases start.
- **Each motion is timed from the server time of what it presents.** Phase motion is timed from its phase's start; anything else is timed from the view that carried it. An animation's current time is the estimated server time minus that moment, so a late viewer (a reconnect, a hidden tab, a slow device) joins the motion part-way, and one who arrives after it would have finished sees only the end state. Nothing replays.
- **Motion never gates play.** No Action Window, Action Deadline, Next-Hand Countdown or deal waits for an animation, and no animation is a poker command. A Participant may act while chips are still travelling.
- **The chosen motion.** The Hand is dealt from the deck in dealing order; chips slide to the betting line and are swept to the pot; opponents' folded hands are mucked; the pot is pushed onto the winner's stack, whose figure keeps its old value until the chips land. The acting seat's brass edge is the Action Deadline clock, clearing clockwise from the top. Seats settle in place when Participants arrive, leave or move; chips added to a stack come in from the table's edge, with the amount and a roll of the figure to its new total. Overlays enter from where they come from and leave faster.
- **There is no motion preference.** The card-animation switch is removed and the Trainer no longer honours the operating system's reduced-motion setting. Motion is part of how the table reads, and one presentation keeps it consistent for every viewer.

## Consequences

- Browser storage keeps only the analysis panel preference; ADR-0037's list of device preferences loses card animations.
- A viewer who is sensitive to motion has no way to turn it off. This is a deliberate product choice; revisiting it means adding a preference that changes presentation only, never timing.
- The planner is pure and tested apart from the DOM. The choreography reads the stage's layout, so its look is checked in the browser, not in unit tests.
- When the viewer's own seat changes, the table turns so they stay at the bottom, and no motion plays for that change.
