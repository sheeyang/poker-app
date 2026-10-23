# Expandable Trainer decision review

The selected design is mockup B from the user's review: personal decisions form
an expandable list, and the other Participants' actions appear on a miniature
poker table inside the open decision. This implements current-Hand review within
ADR-0028, without introducing a historical replay workspace.

## Accepted behavior

- Only accepted human decisions appear as review rows. Each collapsed row names
  the action. Preflop, Flop, Turn and River labels and their community cards belong
  inside the expanded detail, not in separate list headings.
- One decision is expanded at a time. The selected row can collapse, and opening
  it again restores its matching situation and analysis. Manual selection remains
  pinned as live play advances; Return to latest decision restores following.
- The detail shows a static participant-safe poker table before the selected
  action: original seats, stacks, dealer, human cards and community cards. It
  shows the pot, amount to call, human stack and seat/blind context in chips.
- Each other Participant shows their latest earlier action, with an earlier-street
  label when relevant. Folded and all-in states remain visible. The selected action
  and later actions never supply these captions. Opponent cards are not revealed.
- Earlier actions is a collapsed disclosure containing only the preceding actions
  of that Hand, in order. No earlier player action is inferred when history is absent.
- The full Reference Strategy distribution, concrete sizing choices, selected
  reference action, scores, loading/error states and retry controls remain tied
  to the selected decision. The snapshot remains useful while analysis is pending.
- The completed-Hand recap has one Review hand entry point and its summary; it
  does not duplicate the decision list. Live Analysis and gameplay remain available.
- Desktop and mobile use the same expandable list. The mini table supports the
  configured two through nine seats, including sparse seats, without horizontal
  scrolling. Disclosure controls work with keyboard activation.

## Verification boundaries

The user agreed to tests through the rendered AnalysisPanel and DecisionSituation
interfaces, with browser verification for interactions. The review baseline is
commit a32cd074fee76d0a9ad38a0a0da4679bd14a6ae0.
