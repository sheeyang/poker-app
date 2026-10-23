# Expandable Trainer decision review

The selected design is mockup B from the user's review: personal decisions form
an expandable list, and the other Participants' actions appear on a miniature
poker table inside the open decision. This implements current-Hand review within
ADR-0028, without introducing a historical replay workspace.

## Accepted behavior

- Only accepted human decisions appear as review rows. Each collapsed row names
  the action. Preflop, Flop, Turn and River labels and their community cards belong
  inside the expanded detail, not in separate list headings.
- The Your decisions heading and all rows share one bordered, rounded box, matching
  mockup B. Row dividers and a distinct expanded surface keep the group readable.
- Collapsed decision headers show Decision Score and Action Rank Score out of 100
  in fixed columns, aligned across actions and values of different lengths. An
  expanded header shows only the action and chevron; the large Decision Score and
  secondary Action Rank Score appear inside its detail. The action header stays
  visible while its detail scrolls. Pending/unavailable states remain explicit.
- One decision is expanded at a time. The selected row can collapse, and opening
  it again restores its matching situation and analysis. Manual selection remains
  pinned as live play advances. Latest decision restores following when reviewing
  an older action; collapsing the newest action does not add that control. With
  Live Analysis enabled, Live decision restores the current live reference.
- The detail shows a static participant-safe poker table before the selected
  action: original seats, stacks, dealer, human cards and community cards. It
  shows the pot and stacks on the mini table, with amount to call and seat/blind
  context beneath it. These facts are not repeated in extra score/action blocks.
- Each other Participant shows their latest earlier action, with an earlier-street
  label when relevant. Folded and all-in states remain visible. The selected action
  and later actions never supply these captions. Opponent cards are not revealed.
- Earlier actions is a collapsed disclosure containing only the preceding actions
  of that Hand, in order. No earlier player action is inferred when history is absent.
- The full Reference Strategy distribution, concrete sizing choices, selected
  reference action, scores, loading/error states and retry controls remain tied
  to the selected decision. The snapshot remains useful while analysis is pending.
- Expanded content follows this order: large scores, street and frozen situation, Reference
  actions and full sizing tree, one-line sampled/selected action, Earlier actions,
  Analysis details. The latter contains sampling explanations and Policy/Selector
  versions. Repeated You labels, accepted-action blocks and instructional captions
  are removed. The Reference Strategy name and chip units appear once at panel level.
- Analysis settings is a header control revealing the Reference Strategy and Live
  Analysis controls on request. One About these scores disclosure explains the
  scores and their limitations. Settings support keyboard activation and Escape.
- The completed-Hand recap has one Review hand entry point and its summary; it
  does not duplicate the decision list. Live Analysis and gameplay remain available.
- Desktop and mobile use the same expandable list. The mini table supports the
  configured two through nine seats, including sparse seats, without horizontal
  scrolling. Disclosure controls work with keyboard activation.

## Verification boundaries

The user agreed to tests through the rendered AnalysisPanel and DecisionSituation
interfaces, with browser verification for interactions. The review baseline is
commit a32cd074fee76d0a9ad38a0a0da4679bd14a6ae0.
