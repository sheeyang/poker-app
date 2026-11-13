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
- Shallow material depth and brief presentation motion timed by the server's clock.

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

On phones the table takes the remaining viewport height with a felt inset, and board cards, hole cards and seats shrink to fit. Larger tables use smaller seats and cards still. Active-hand controls respect safe-area padding. Short viewports put the three action buttons on one row and move the human's cards beside their seat to keep the board clear.

## Elevation & Depth

Most surfaces use tonal layering and one-pixel borders. Shadows express physical separation for the felt rail and playing cards, and elevation for modal dialogs. Do not apply them to every container.

Table motion follows ADR-0038: cards leave the deck one at a time in dealing order (340ms each, 75ms apart) and turn face up about their own axis; chips slide to the betting line, are swept into the pot, and the pot is pushed onto the winner's stack; opponents' folded hands are mucked. Each motion is timed from the server time of what it presents, so a late viewer joins it part-way, and nothing waits for it. The acting seat's brass edge clears clockwise to its Action Deadline, warming in the last five seconds. Seats settle in place; chips added to a stack come in from the table's edge while the amount floats up and the stack figure rolls to its new total in one piece, and a refill that comes with a deal (Practice's Rebuy & deal) lands before the blinds and cards go out. When you change seats the table is drawn turned: the ring of seats dissolves into its new places, the felt and board stay put, and a label says which seat you are in. Overlays come from their source and return to it, however they close: the analysis panel slides from the right, a menu grows out of its trigger and shrinks back into it, a dialog grows out of the control that opened it (out of the menu, when a menu item opened it) and shrinks back into it, notices drop in, and a notice the app removes folds away so the ones below slide up. Exits are faster than entrances. Everything that settles shares `cubic-bezier(.16,1,.3,1)`; control color changes and the analysis switch use 150ms transitions. There is no motion preference. Score values appear immediately, without rolling or crossfade; only stack figures roll. Loading uses static tonal skeletons shaped like the content they replace; there is no shimmer or pulse.
## Shapes

Use compact rounded rectangles: tags and small cards, card stock, fields, controls, containers and dialogs follow their radius tokens. Seat bodies and action containers share gently curved corners. Dialogs reduce to the container radius on small screens. Circles belong to avatars, dealer markers and chips. The felt keeps its elliptical silhouette and dark structural rail; do not extend that silhouette to ordinary panels.

## Components

- **Buttons:** solid brass for primary operations; raised green for standard actions; transparent bordered controls for quiet actions; brass text for subordinate links. Controls are comfortably tall with semibold labels. Disabled buttons are dimmed. Hover changes fill and border; active states deepen the fill.
- **Focus:** buttons, fields, selects, summaries and links share one brass outline with an offset. Retain it across all variants.
- **Fields:** dark inset fill, a fine control border, full available width. Labels sit above. Checkboxes and range controls use brass accents; the Live Analysis switch uses a compact sliding thumb.
- **Choice surfaces:** table format and stack presets are labeled radio surfaces with muted captions. The selected choice takes a brass border and a warmer green fill. The primary Start control is full width and taller than ordinary buttons.
- **Navigation:** plain-text controls with muted inactive labels. The selected destination uses brass text and a brass bottom rule. Small screens keep labels and drop icons.
- **Tags:** small green status labels with soft sage text. The accepted-action marker uses a warm accent and identifies the player's action without grading it.
- **Containers and seats:** bordered green surfaces with modest padding. The acting seat receives a brass border and an explicit caption; the human seat uses a distinct green tone. Folded cards are subdued without hiding the seat's identity. States such as disconnected or sitting out use a dashed border or a text label as well as dimming, so they never rest on colour alone.
- **Popover menus:** compact raised-green popovers open beside their trigger and keep brass focus, text labels and muted reasons for unavailable actions.
- **Notes and notices:** a pending after-hand change appears as a small olive note. Recovery notices use warm brown surfaces with pale text and explicit controls.
- **Playing cards:** ivory stock, dark or red suits, small corners and a short shadow. Face-down cards use a green back with pale inset linework. Compact variants drop the mirrored lower index but keep the upper rank and central suit, so suits stay recognisable at small sizes.
- **Recap tray:** a fine top rule separates the outcome from the table; headline and explanation sit left, actions right, stacking on phones.
- **Analysis panel:** tabs stay pinned while the rest of the panel scrolls. Decision rows share one bordered, rounded container with fine dividers and align their scores in fixed columns. An expanded row gets a warmer green summary and a rotated chevron; its detail sits on a distinct green surface.
- **Probability tree:** thin action-colored meters, right-aligned tabular probabilities and permanently expanded sizing children, connected by a quiet vertical rule. The selected reference action and the accepted player action carry distinct labels.
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
