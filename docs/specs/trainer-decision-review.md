# Expandable Trainer decision review

The selected design is mockup B from the user's review: personal decisions form
an expandable list, and the other Participants' actions appear on a miniature
poker table inside the open decision. This implements current-Hand review within
ADR-0028, without introducing a historical replay workspace.

## Accepted behavior

- The table workspace fits the viewport and does not scroll with analysis. The
  sidebar has its own vertical scroll area with contained overscroll. At widths
  up to 1000px, it fills the workspace below the app header; the covered table is
  hidden from interaction. Closing returns focus to play without moving the page.
- Short phone screens place the three action buttons together and keep sizing
  controls below them. Human cards sit beside the human seat to keep the board
  clear within the available table height. Hand activity scrolls inside its open
  disclosure; practice setup and saved-table browsing retain normal page scrolling.
- Only accepted human decisions appear as review rows. Each collapsed row names
  the action. Preflop, Flop, Turn and River labels and their community cards belong
  inside the expanded detail, not in separate list headings.
- The Your decisions heading and all rows share one bordered, rounded box, matching
  mockup B. Row dividers and a distinct expanded surface keep the group readable.
- Collapsed decision headers show Decision Score and Action Rank Score out of 100
  in fixed columns, aligned across actions and values of different lengths. An
  expanded header shows only the action and chevron; the large Decision Score and
  secondary Action Rank Score appear inside its detail. The action header stays
  visible while its detail scrolls. Its grid and reserved score space stay the
  same size when toggled; expanded header scores are visually hidden and excluded
  from assistive technology. Pending/unavailable states remain explicit.
- At phone widths the action, both score columns and chevron share one compact
  grid row, at least 64px high. Expanded scores remain hidden in that same row;
  no second score line is reserved. Desktop score columns keep their alignment.
- The stable Hand N analysis heading has separate Live and This hand tabs. The
  chosen view stays in place as play advances. Tabs support arrow keys, Home/End
  and normal keyboard activation. Live shows only the current human decision;
  This hand contains the shared human decision box. Review hand/Review decisions
  opens This hand. Closing and reopening the sidebar retains the view unless a
  review entry point explicitly selects This hand. A different table initializes
  to Live when Live Analysis is enabled, otherwise This hand. Selecting Live never
  enables Live Analysis: the disabled view offers an explicit enable control.
- One decision is expanded at a time. The selected row can collapse, and opening
  it again restores its matching situation and analysis. Manual selection applies
  within the current Hand until another human action is
  accepted. A new Hand clears the previous review immediately and the sidebar
  follows the current Hand and newest accepted decision. Latest decision restores
  following when reviewing
  an older action; collapsing the newest action does not add that control. The
  Live tab restores the current live reference without discarding the Hand review
  selection. New accepted actions still follow the latest review within This hand.
- The detail shows a static participant-safe poker table before the selected
  action: original seats, stacks, dealer, human cards and community cards. It
  shows the pot and stacks on the mini table, with amount to call and seat/blind
  context beneath it. These facts are not repeated in extra score/action blocks.
- The live Current decision shows reference actions directly, without a duplicate
  table snapshot or Current table state label. Frozen snapshots remain available
  when reviewing an accepted decision, including with Live Analysis enabled.
- Each other Participant shows their latest earlier action, with an earlier-street
  label when relevant. Folded and all-in states remain visible. The selected action
  and later actions never supply these captions. Opponent cards are not revealed.
- Earlier actions is a collapsed disclosure containing only the preceding actions
  of that Hand, in order. No earlier player action is inferred when history is absent.
- The full Reference Strategy distribution, concrete sizing choices, selected
  reference action, scores, loading/error states and retry controls remain tied
  to the selected decision. The snapshot remains useful while analysis is pending.
- Expanded content follows this order: large scores, Reference actions and full
  sizing tree, one-line sampled/selected action, street and frozen situation, Earlier actions,
  Analysis details. The latter contains sampling explanations and Policy/Selector
  versions. Repeated You labels, accepted-action blocks and instructional captions
  are removed. The Reference Strategy name and chip units appear once at panel level.
- Analysis settings is a header control opening a nonmodal popover anchored to
  its button, with the Reference Strategy and Live Analysis controls. It overlays
  the review without moving its content and closes with Escape, an outside click
  or its close control. One About these scores disclosure explains the
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

## Selected comparison changes

The user selected changes 1 (separate views), 2 (reference before situation) and
4 (compact mobile header) from the React/Vite sidebar comparison prototype.
Its source is retained on branch `codex/sidebar-review-prototype`, under
`.scratch/sidebar-review-prototype`, against the pre-implementation UI.
Changes 3 (numbered decisions/count wording) and 5 (local score/sampling help) are
excluded. Existing action labels, Your decisions count wording, About these scores,
Analysis details, numerical meanings and anchored settings remain as before.
