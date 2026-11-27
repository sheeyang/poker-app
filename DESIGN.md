---
name: Poker Trainer
description: A classic cardroom for focused play and numerical study.
colors:
  ground: "#141e1b"
  surface: "#1b2824"
  raised: "#25342e"
  line: "#35453d"
  muted: "#a4b5a9"
  text: "#e8ede7"
  gold: "#ddc28b"
  gold-hover: "#ecd7ab"
  gold-active: "#c5a96f"
  primary-text: "#243025"
  felt: "#205b46"
  field: "#17231e"
  control-line: "#46594d"
  control-hover: "#304238"
  control-active: "#3b4d42"
  card-paper: "#f5f2e7"
  card-ink: "#1b2b24"
  card-red: "#b13c36"
  probability-call: "#90b8c9"
  probability-fold: "#c8a79a"
  probability-check: "#a4c3b0"
  probability-aggression: "#d5bc88"
  seat: "#202e27"
  tag: "#2d4031"
  tag-text: "#c1cfb9"
typography:
  headline:
    fontFamily: '"Segoe UI", -apple-system, BlinkMacSystemFont, sans-serif'
    fontSize: "1.7rem"
    fontWeight: 650
    letterSpacing: "-.025em"
  title:
    fontFamily: '"Segoe UI", -apple-system, BlinkMacSystemFont, sans-serif'
    fontSize: "1.25rem"
    fontWeight: 600
    letterSpacing: "-.015em"
  body:
    fontFamily: '"Segoe UI", -apple-system, BlinkMacSystemFont, sans-serif'
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.6
  label:
    fontFamily: '"Segoe UI", -apple-system, BlinkMacSystemFont, sans-serif'
    fontSize: ".86rem"
    fontWeight: 600
  card-index:
    fontFamily: 'Georgia, "Times New Roman", serif'
    fontSize: "1.25rem"
    fontWeight: 700
    lineHeight: .9
rounded:
  tag: "4px"
  card: "5px"
  field: "7px"
  control: "8px"
  container: "12px"
  dialog: "16px"
  round: "50%"
spacing:
  compact: "4px"
  xs: "8px"
  sm: "12px"
  md: "16px"
  section: "20px"
  lg: "24px"
  xl: "32px"
  page: "36px"
components:
  button-primary:
    backgroundColor: "{colors.gold}"
    textColor: "{colors.primary-text}"
    rounded: "{rounded.control}"
    padding: "9px 16px"
  button-primary-hover:
    backgroundColor: "{colors.gold-hover}"
    textColor: "#162119"
  button-primary-active:
    backgroundColor: "{colors.gold-active}"
  button-secondary:
    backgroundColor: "{colors.raised}"
    textColor: "{colors.text}"
    rounded: "{rounded.control}"
    padding: "9px 16px"
  button-secondary-hover:
    backgroundColor: "{colors.control-hover}"
  button-quiet:
    backgroundColor: "transparent"
    textColor: "{colors.text}"
    rounded: "{rounded.control}"
    padding: "9px 16px"
  button-text:
    backgroundColor: "transparent"
    textColor: "{colors.gold}"
    padding: "4px 0"
  field:
    backgroundColor: "{colors.field}"
    textColor: "{colors.text}"
    rounded: "{rounded.field}"
    padding: "10px 12px"
  navigation:
    backgroundColor: "transparent"
    textColor: "{colors.muted}"
    padding: "0 2px"
  tag:
    backgroundColor: "{colors.tag}"
    textColor: "{colors.tag-text}"
    rounded: "{rounded.tag}"
    padding: "3px 6px"
  seat:
    backgroundColor: "{colors.seat}"
    textColor: "{colors.text}"
    rounded: "{rounded.container}"
    padding: "11px"
  playing-card:
    backgroundColor: "{colors.card-paper}"
    textColor: "{colors.card-ink}"
    rounded: "{rounded.card}"
    width: "55px"
    height: "78px"
---

# Design System: Poker Trainer

## Overview

**Creative North Star: "The Classic Cardroom"**

Green felt, a charcoal-green shell, ivory cards and brass controls establish a familiar poker room. Compact interface typography and restrained material detail keep the experience focused and legible. The cards are the brightest objects; surrounding surfaces recede.

This system belongs to the participant-facing Trainer in `apps/web`, in the classic poker-room direction recorded in PRODUCT.md.

**Key Characteristics:**

- Dark green tonal surfaces with warm brass interaction accents.
- Ivory playing cards with conventional serif indices and suit colors.
- Compact system typography, clear borders and tabular numerical data.
- Shallow material depth and followable table motion timed by the server's clock.

## Colors

Subdued cardroom greens with warm controls and differentiated numerical data. Frontmatter values are normative.

### Primary

- **Brass:** `gold`, `gold-hover` and `gold-active` identify primary controls, active navigation and focus. Dark primary text preserves their solid, tactile appearance.
- **Cardroom Felt:** `felt` supplies the playing surface, distinct from the darker surrounding shell.

### Secondary

- **Probability accents:** cool blue for Call/default, dusty rose for Fold, pale sage for Check and muted brass for Bet/Raise. These distinguish action types without declaring a preferred choice.

### Neutral

- **Charcoal green:** `ground`, `surface` and `raised` separate shell, containers and controls; `line` provides quiet structure.
- **Soft ivory and sage:** `text` carries primary content; `muted` carries supporting context.
- **Playing-card stock:** `card-paper` carries dark indices; `card-red` differentiates hearts and diamonds. Reserve the light stock for physical card surfaces.
- **Control surfaces:** `field`, `control-line`, `control-hover` and `control-active` distinguish editable and interactive elements. Seat and tag tones remain within the same green family.

**The Brightest Object Rule.** Keep large surrounding surfaces dark so ivory playing cards retain the strongest light contrast.

## Typography

**Interface font:** Segoe UI with platform system sans fallbacks. **Card font:** Georgia with Times New Roman and serif fallbacks. No downloaded font is required.

Neutral interface text surrounds conventional printed card indices. Prose uses a relaxed line height and a readable measure.

- **Headline / title:** page and section headings, with slightly tightened letter spacing.
- **Body / label:** readable prose and semibold field labels; supporting metadata uses smaller, quieter text.
- **Card index:** bold serif rank above its suit, with a mirrored lower index on full-size cards.
- **Numerical emphasis:** stacks, pots, probabilities and scores use tabular numerals. The Decision Score is the largest figure, with Action Rank Score secondary; `/100` denominators stay small, muted and subordinate.

## Layout

Use compact control groups and consistent gaps from the spacing scale. Distinguish sections with tonal surfaces or fine borders. Allow labels, summaries and forms to wrap.

The shell has a maximum width. The active table fills the viewport below the app header and stays fixed while the analysis sidebar scrolls independently. On narrow screens, analysis fills the workspace instead of sitting beside the table, forms stack, shell padding shrinks and action buttons become shallower horizontal groups. The supported minimum width is 320px. Practice setup and saved-table browsing use normal page scrolling.

On phones the table takes the remaining viewport height with a felt inset, and board cards, hole cards and seats shrink to fit. Larger tables use smaller seats and cards still. Active-hand controls respect safe-area padding. Short viewports put the three action buttons on one row and move the viewer's cards beside their seat to keep the board clear.

## Elevation & Depth

Most surfaces use tonal layering and one-pixel borders. Shadows express physical separation for the felt rail and playing cards, and elevation for modal dialogs. Do not apply them to every container.

Table motion follows ADR-0038 and ADR-0039: the last Hand's cards fly back to the deck, closer together when many return; cards leave the deck one at a time in dealing order (heads-up, the button first), closer together at a full table, and turn face up about their own axis; chips slide to the betting line, are swept into the pot, and the pot is pushed onto each winner's stack in turn, the figure changing only as their chips land; opponents' folded hands are mucked. Its timing is shared with the server, in one presentation module. Each Presentation Phase (the deal, a street reveal, the showdown, the payout) lasts exactly as long as the motion it presents, because the server derives the phase's length from the same beats the Trainer plays. A Settle follows each one: a short stillness in which nothing moves and nobody may act, so the table has come to rest before an Action Window opens or the next Hand can start. The Settle after the showdown is the longest within a Hand: it is the time to read the turned hands before the pot is pushed. Bets, folds, checks, seats, chips added to a stack, your own seat change and a seat's status have no phase: they play from the view that carried them and never hold up play. The whole table moves at one tempo, slow enough to follow by eye: the beats are about 1.5× the first motion pass, except that a split pot's awards land 300 ms apart, so each winner's figure is seen to change on its own. Each motion is timed from the server time of what it presents, so a late viewer joins it part-way, at the same point as everyone else, and nothing waits for it. A replay has no server time to follow, so its motion is timed by the client from each step input: Next plays the step's transition with the same beats, Back plays that motion in reverse, a jump (or a step back across a deal) draws its step at once, and any new input snaps motion still playing to its end state. The acting seat's brass edge clears clockwise to its Action Deadline, warming in the last five seconds. Seats settle in place; chips added to a stack come in from the table's edge while the amount floats up and the stack figure rolls to its new total in one piece, and a refill that comes with a deal (Practice's Rebuy & deal) lands before the blinds and cards go out. When you change seats the table is drawn turned: the ring of seats dissolves into its new places, the felt and board stay put, and a label says which seat you are in. Overlays are not table events and keep their own, quicker timings in the web app. They come from their source and return to it, however they close: the analysis panel slides from the right, a menu grows out of its trigger and shrinks back into it, a dialog grows out of the control that opened it (out of the menu, when a menu item opened it) and shrinks back into it, notices drop in, and a notice the app removes folds away so the ones below slide up. Exits are faster than entrances. Everything that settles shares `cubic-bezier(.16,1,.3,1)`; control color changes and the analysis switch use 150ms transitions. There is no motion preference. Score values appear immediately, without rolling or crossfade; only stack figures roll. Loading uses static tonal skeletons shaped like the content they replace; there is no shimmer or pulse.
## Shapes

Use compact rounded rectangles: tags and small cards, card stock, fields, controls, containers and dialogs follow their radius tokens. Seat bodies and action containers share gently curved corners. Dialogs reduce to the container radius on small screens. Circles belong to avatars, dealer markers and chips. The felt keeps its elliptical silhouette and dark structural rail; do not extend that silhouette to ordinary panels.

## Components

- **Buttons:** solid brass for primary operations; raised green for standard actions; transparent bordered controls for quiet actions; brass text for subordinate links. Controls are comfortably tall with semibold labels. Disabled buttons are dimmed. Hover changes fill and border; active states deepen the fill.
- **Focus:** buttons, fields, selects, summaries and links share one brass outline with an offset. Retain it across all variants.
- **Fields:** dark inset fill, a fine control border, full available width. Labels sit above. Checkboxes and range controls use brass accents; the Live Analysis switch uses a compact sliding thumb.
- **Choice surfaces:** table format and stack presets are labeled radio surfaces with muted captions. The selected choice takes a brass border and a warmer green fill. The primary Start control is full width and taller than ordinary buttons.
- **Navigation:** plain-text controls with muted inactive labels. The selected destination uses brass text and a brass bottom rule. Small screens keep labels and drop icons.
- **Tags:** small green status labels with soft sage text. The accepted-action marker uses a warm accent and identifies the player's action without grading it.
- **Containers and seats:** bordered green surfaces with modest padding. The acting seat receives a brass border and an explicit caption; the viewer's seat uses a distinct green tone. Folded cards are subdued without hiding the seat's identity. States such as disconnected or sitting out use a dashed border or a text label as well as dimming, so they never rest on colour alone.
- **Popover menus:** compact raised-green popovers open beside their trigger and keep brass focus, text labels and muted reasons for unavailable actions.
- **Notes and notices:** a pending after-hand change appears as a small olive note. Recovery notices use warm brown surfaces with pale text and explicit controls.
- **Playing cards:** ivory stock, dark or red suits, small corners and a short shadow. Face-down cards use a green back with pale inset linework. Compact variants drop the mirrored lower index but keep the upper rank and central suit, so suits stay recognisable at small sizes.
- **Recap tray:** a fine top rule separates the outcome from the table; headline and explanation sit left, actions right, stacking on phones.
- **Analysis panel:** tabs stay pinned while the rest of the panel scrolls. Decision rows share one bordered, rounded container with fine dividers and align their scores in fixed columns. An expanded row gets a warmer green summary and a rotated chevron; its detail sits on a distinct green surface.
- **Counterfactual Comparison:** in a replay, the reader's own decision shows each Strategy as a column set apart by a fine top rule, not a nested card. The Reference Strategy is always first and tagged; each added Strategy (up to 3, chosen from a select) names itself and has a quiet brass Remove. A column keeps its own pending, error and Retry states. Alone, or wide enough, a column puts its scores beside its distribution; narrower ones and phones stack them. The compared Strategies live in the address only.
- **Overall History:** the History tab is a filter panel above a ledger of the reader's own decisions, in the Table History language: one row per decision (Hand and table, hole cards beside the board as it was, street and Position as tags, the action and the pot in big blinds), the whole row a link to its Replay Step. Filters are brass-edged toggle chips that apply at once (Street, Action, Table, Position), date fields and big-blind fields for ranges; the panel's header carries the decision count and Clear filters. It is open on a wide screen and folded on a phone until a filter is set. Filters live in the address.
- **Overall History score filters:** a "Score, out of 100" group in the filter panel, four percentage fields (Decision Score and Action Rank Score, at least and at most) in the same field language as the pot range. While any analysis of the set is outstanding the ledger is replaced by an Analyzing block (a brass count and the fine brass rule), or by the red notice with Retry; no partial list is ever shown.
- **Overall History Score Summary:** a bordered surface between the filters and the ledger, asked for explicitly with a brass Summarize button that names the count. It names the Strategy it was taken against. The mean Decision Score is the largest figure, Action Rank Score secondary, the decision count beside them; "—" stands for no score. While analyses run, a brass "Analyzing 340 / 2,000" sits over a fine brass progress rule. Score ranges narrow it too, so with a range set its decision count reads "—" until the analyses finish. Failures show the warm Error notice with Retry. "Break down by" uses the same toggle chips (None, Street, Position, Action, Table) and lives in the address; a breakdown is a ruled table, one row a bucket with its decisions and both means, or its own Analyzing or Error in place of them.
- **Probability tree:** thin action-colored meters, right-aligned tabular probabilities and permanently expanded sizing children, connected by a quiet vertical rule. The selected reference action and the accepted player action carry distinct labels.
- **Side-by-side Score Summaries:** the same "Compare with" select as the replay's Counterfactual Comparison adds up to 3 Strategies (Overall History's and a table's Table History's Score Summary share it, held in the address as `compare`). Each Strategy is a ruled column, the Reference Strategy first with its Reference tag, the others with a brass Remove; columns sit in a row on wide screens, divided by a hairline, and stack on phones. Each column has its own means, Analyzing, Error and Retry, so one Strategy failing leaves the others as they are. Table History's panel asks explicitly ("Summarize my decisions").
- **Dialogs:** dialogs use the surface tone, a structural border, a dark backdrop and an elevated shadow. Single-purpose dialogs stack their content on one consistent rhythm and focus their main control on opening. Inline controls, such as a Copy link button, sit on the same row as their field.

## Do's and Don'ts

### Do:

- **Do** keep cards brighter than the surrounding shell and felt.
- **Do** use brass consistently for primary operations, active state and keyboard focus.
- **Do** preserve tabular numerals and clear labels for probabilities, totals and scores.
- **Do** time motion from the server's clock and keep presentation independent of gameplay: no animation gates a turn, deadline or deal.

### Don't:

- **Don't** turn numerical alignment or action colors into advice, quality grades or celebratory judgments.
- **Don't** replace conventional card indices and suit distinctions with decorative symbols.
- **Don't** spread card and modal shadows across ordinary containers.
