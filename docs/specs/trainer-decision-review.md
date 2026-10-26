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
  grid row, at least 75px high, with a 152px score grid. The full score labels use
  0.72rem, values 1rem and denominators 0.8rem. Probability labels, You markers
  and panel metadata are larger for legibility. Expanded scores remain hidden in
  that same row; no second score line is reserved. Desktop score columns keep
  their alignment.
- The stable Hand N analysis heading has separate Live and This hand tabs. The
  chosen view stays in place as play advances. Tabs support arrow keys, Home/End
  and normal keyboard activation. Live shows only the current human decision;
  This hand contains the shared human decision box. Review hand/Review decisions
  opens This hand. Closing and reopening the sidebar retains the view unless a
  review entry point explicitly selects This hand. A different table initializes
  to Live when Live Analysis is enabled, otherwise This hand. Selecting Live never
  enables Live Analysis: the disabled view offers an explicit enable control.
- Only Live/This hand tabs stay pinned as the sidebar scrolls. The title,
  Reference Strategy caption and settings/return controls scroll away. The open
  decision header stays below the tabs using their measured height; keyboard
  scrolling reserves room for the pinned navigation. This hand omits the
  redundant Reviewing this hand line; Live keeps its current status messages.
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
  are removed. The full Reference Strategy name and chip units appear once at
  panel level. The name shows Policy followed by Action Selector, with the exact
  labels used by Analysis settings (for example, Simple Heuristic · Probability
  Selector), and may wrap naturally on narrow screens.
- Analysis settings is a header control opening a nonmodal popover anchored to
  its button, with the Reference Strategy and Live Analysis controls. It overlays
  the review without moving its content and closes with Escape, an outside click
  or its close control. One About these scores disclosure explains the
  scores and their limitations. Settings support keyboard activation and Escape.
- The completed-Hand recap keeps its outcome, decision count, Review hand entry
  point and Deal next hand controls. Its averages appear only in This hand, within
  the shared Your decisions box. A two-tier header has title/count first and two
  mean columns beneath. Mean Decision Score uses a stronger label and a larger
  value than Mean Action Rank Score; the expanded individual Decision Score stays
  larger still. The header scrolls away with the list; only the existing tabs and
  expanded action header stick. No averages appear before the current Hand ends
  or for a previously selected Hand. Pending, failed, retry and empty states stay
  explicit, without partial averages. A summary keeps its recorded decision set,
  Reference Strategy and values when settings change. When its full reference
  descriptor differs from the current configuration, its caption reads Reference
  Strategy followed by Policy and Action Selector, using the settings labels. The
  caption is omitted when they match; there is no retention sentence. Live Analysis
  and the Table Session summary remain unchanged.
- Desktop and mobile use the same expandable list. The mini table supports the
  configured two through nine seats, including sparse seats, without horizontal
  scrolling. Disclosure controls work with keyboard activation.

## Verification boundaries

The user agreed to tests through the rendered AnalysisPanel and DecisionSituation
interfaces, with browser verification for interactions. The score-hierarchy
implementation review baseline is commit d48dba4d9c58f59207af29e648764b57588a2f58.

## Selected comparison changes

The user selected changes 1 (separate views), 2 (reference before situation) and
4 (compact mobile header) from the React/Vite sidebar comparison prototype.
Its source is retained on branch `codex/sidebar-review-prototype`, under
`.scratch/sidebar-review-prototype`, against the pre-implementation UI.
Changes 3 (numbered decisions/count wording) and 5 (local score/sampling help) are
excluded. Existing action labels, Your decisions count wording, About these scores,
Analysis details, numerical meanings and anchored settings remain as before.

The subsequent usability comparison selected changes 1 (tabs-only sticky
navigation), 2 (larger phone text, with the revised smaller score labels) and
4 (full reference name matching settings), plus removal of Reviewing this hand.
Change 3 (larger settings/return tap targets) is excluded. Source is retained on
branch `codex/sidebar-usability-prototype`, under
`.scratch/sidebar-usability-prototype`, against implementation baseline eb9cb68.
Current-Hand behavior, independent sidebar scrolling, score order, full sizing
trees, frozen snapshots and the existing settings/help behavior stay unchanged.

The hand-summary comparison selected all three changes: averages in the Your
decisions heading using the Two-tier layout, primary Mean Decision Score emphasis,
and the conditional Reference Strategy caption. Source is retained on branch
`codex/hand-summary-prototype`, commit `1ee1dcf8a18f8200711ec1430007ad999e867db7`,
under `.scratch/hand-summary-prototype`. Its parent and this implementation's
review baseline are `19f9c0c33d48acc78d271d47b3dc28d04bd01666`. Other placements and
header variations were not selected. The mockup's caption was revised to Reference
Strategy, without the extra sentence about retaining the original reference.

The score-hierarchy comparison selected only option 2, Matching score pairs.
Hand means and expanded decision scores use the same two columns (1.45fr / 1fr),
Decision Score left and Action Rank Score right, with full labels above values.
Hand means use 23.8px / 17.5px; expanded decisions use 35px / 19.6px at the 14px
root size. Labels match their value colors, while all four denominators remain
muted at 0.8rem, weight 400, with 6px separation. The 24px column gap becomes
16px at 650px without changing the numeric sizes. Options 1 and 3 are excluded.
This selected arrangement supersedes only ADR-0008's older presentation wording
that places Action Rank Score underneath; all its numerical rules remain intact.
The two-tier heading/count, completed current-Hand scope, recorded-reference
identity, summary states, collapsed rows and all existing review behavior remain
unchanged. Source is retained on branch `codex/score-hierarchy-prototype`, commit
`a48af7e49ad8b4632c6550915a7102b77b25e1bc`, under
`.scratch/score-hierarchy-prototype`, with parent baseline
`d48dba4d9c58f59207af29e648764b57588a2f58`. The prototype uses illustrative data,
without an API or user data, and stays off the production branch.
