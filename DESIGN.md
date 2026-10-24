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
  display:
    fontFamily: '"Segoe UI", -apple-system, BlinkMacSystemFont, sans-serif'
    fontSize: "2.7rem"
    fontWeight: 500
    letterSpacing: "-.025em"
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

This system belongs to the participant-facing Trainer. Its visual authority is the implemented `apps/web` interface and the confirmed classic poker-room direction in PRODUCT.md.

**Key Characteristics:**

- Dark green tonal surfaces with warm brass interaction accents.
- Ivory playing cards with conventional serif indices and suit colors.
- Compact system typography, clear borders and tabular numerical data.
- Shallow material depth and brief, optional presentation motion.

## Colors

The palette combines subdued cardroom greens with warm controls and differentiated numerical data. Frontmatter values are normative; the sidecar supplies display metadata and preview ramps.

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

**Body and interface font:** Segoe UI with platform system sans fallbacks. **Card font:** Georgia with Times New Roman and serif fallbacks. No downloaded font is required.

The pairing is compact and familiar: neutral interface text surrounds conventional printed card indices. The root size is (14px); prose uses a relaxed line height and a maximum width of (70ch).

- **Display:** retain the established display role. The practice entry uses a local heading treatment of (2.4rem), weight (600), reducing to (1.9rem) on small screens.
- **Headline / title:** page and section headings, using the frontmatter's slightly tightened spacing.
- **Body / label:** readable prose and semibold field labels; supporting metadata uses smaller, quieter text.
- **Card index:** bold serif rank above its suit, with a mirrored lower index on full-size cards.
- **Numerical emphasis:** stacks, pots, probabilities and scores use tabular numerals. Main scores use (2.7rem), weight (500), line height (1.2); small `/100` denominators stay subordinate.

## Layout

Use compact control groups and consistent gaps from the extracted spacing scale. Distinguish sections with tonal surfaces or fine borders. Allow labels, summaries and forms to wrap; keep ordinary prose within its readable measure.

The implemented shell caps its width at (1720px). Large screens increase lateral padding at (1500px); controls condense at (1200px). At (1000px), adjacent study content becomes a following section. At (650px), forms stack, shell padding shrinks and action buttons become shallower horizontal groups. The narrow-screen adjustment at (370px) tightens street and board gaps; the supported body minimum is (320px). These are observed product breakpoints, not a separate grid framework.

The practice entry caps its width at (1120px), with (52px 40px 64px) outer padding. Configuration and saved tables occupy columns of (1.05fr 1fr), separated by (72px); the gap reduces to (36px) at (1000px). At (650px), the columns stack with a (44px) gap and (30px 20px 48px) outer padding. Format choices remain a three-column group, while stack presets form a compact horizontal row. Advanced rules stay behind a disclosure.

Completed-Hand review stays visible below the table and above the next-hand controls, within the same (980px) content width. Its decision list and summary occupy two columns with a (32px) gap. At (650px), these sections stack; decision links wrap horizontally and the two score averages remain side by side. On larger screens, a completed Hand condenses the table to `min(44vh, 440px)` with a (360px) minimum height so review and continuation sit closer together.

On phones up to (650px), the table is (330px) tall, with a (28px 20px) felt inset. Board cards are (34px × 49px), human cards (36px × 51px), and seats (84px) wide with a (100px) human seat. Tables above six players use (70px) seats, a (90px) human seat and (30px × 44px) board cards; wager labels occupy the caption space while a wager is present. Active-hand controls stick to the viewport bottom with safe-area padding. They become static when analysis is open and for completed-Hand continuation, keeping the recap unobscured. Opening review focuses analysis and, at (1000px) or below, scrolls it into view; closing returns focus and scroll position to the play controls.

## Elevation & Depth

Most interface surfaces use tonal layering and one-pixel borders. Shadows express physical separation for the felt rail and playing cards, and elevation for modal dialogs. Do not apply them indiscriminately to every container. Exact shadow values live in the sidecar.

Card dealing lasts (360ms) and face-down burn presentation lasts (500ms), sharing an easing curve of `cubic-bezier(.16,1,.3,1)`. Control color changes and the analysis switch use (150ms) transitions. Reduced-motion preference removes animations and transitions. Presentation motion never determines when a legal action becomes available.

## Shapes

Use compact rounded rectangles: tags and small cards, card stock, fields, controls, containers and dialogs follow their extracted radii. Seat bodies and action containers share gently curved corners. Dialogs reduce to the container radius on small screens. Circles belong to avatars, dealer markers and chips. The felt retains its elliptical silhouette and dark structural rail; avoid extending that silhouette to ordinary interface panels.

## Components

- **Buttons:** solid brass for primary operations; raised green for standard actions; transparent bordered controls for quiet actions; brass text for subordinate links. Default controls have a minimum height of (40px), semibold labels and the frontmatter padding. Disabled buttons use opacity (.45). Hover changes fill and border; active states deepen the fill.
- **Focus:** buttons, fields, selects, summaries and links use a brass outline (2px) with an offset of (4px). Retain it across all variants.
- **Fields:** dark inset fill, a fine control border, full available width and a minimum height of (42px). Labels sit above with an (8px) gap. Checkboxes and range controls use brass accents; the Live Analysis switch uses a compact sliding thumb.
- **Practice choices:** Heads-up, 6-max and Full ring use labeled radio surfaces with muted player-count captions. Selected choices use a brass border and a warmer green fill; stack presets (50, 100 and 200 BB) use the same selected treatment. The full-width Start practice control has a minimum height of (48px). The preview states chip stacks and blinds and explains that this gesture seats everyone and starts the first Hand. Preparation uses a centered status and a specific recovery control when paused.
- **Saved tables:** full-width, left-aligned navigation rows separated by fine top borders. Lead with table format; follow with blinds, completed-Hand count, progress and the human stack. A small brass label marks the current table. The Continue caption reduces to its arrow on phones; the table metadata remains visible.
- **Navigation:** plain-text controls with muted inactive labels. The selected destination uses brass text and a brass bottom rule. Small screens retain labels while removing navigation icons.
- **Tags:** small green status labels with soft sage text. The separate accepted-action marker uses a warm accent and identifies the player's action without grading it.
- **Containers and seats:** bordered green surfaces with modest padding. The acting seat receives a brass border and explicit caption; the human seat uses a distinct green tone. Folded cards are subdued without hiding the seat's identity.
- **Playing cards:** ivory stock, dark or red suits, small corners and a short shadow. Face-down cards use a green back with pale inset linework. Compact variants remove the mirrored lower index but retain the upper rank and central suit; this preserves suit recognition at small sizes.
- **Hand recap and continuation:** a fine top rule separates the visible outcome, current human stack and decision count from the table. Street-labeled accepted-action links open review. The complete Hand summary appears beside those links, with mean Decision Score and mean Action Rank Score in two columns; pending, failed and empty summaries retain their explicit states. The next-hand tray follows the recap. It identifies exhausted stacks and the refill amount through Rebuy & deal, or offers a specific return or opponent-management action when needed. Every following Hand requires an explicit deal gesture.
- **Pinned decision review:** the stable Hand N analysis heading identifies the Hand, with the Reference Strategy name and chip units below it. Live and This hand tabs separate current reference actions from the shared accepted-decision box. The chosen view stays steady as play advances; selecting Live while disabled offers an explicit enable control. Arrow keys and Home/End navigate the tabs. Analysis settings opens in a small, nonmodal popover anchored to its header button, without moving review content. It closes with Escape, an outside click or its close control. The Your decisions heading and all human decision rows share one bordered, rounded container, with fine dividers between rows. Collapsed rows align their two scores in fixed columns. On phones, action, both full score labels/values and chevron share one compact grid row with a (64px) minimum height; hiding expanded header scores preserves that same row rather than reserving a second line. Expanded rows show only the action and chevron in the sticky header, with the large Decision Score and secondary Action Rank Score first inside the detail, followed by Reference actions, the full sizing tree and sampled/selected action, then the street and frozen situation. A warmer green summary and rotated chevron mark the expanded decision. Street labels and community cards stay inside the open detail, on a distinct green surface. Its static mini poker table shows the original human cards, board, seats, stacks, dealer and each opponent's latest earlier action, with previous-street labels and folded/all-in status. Only the amount to call and seat/blind context appear as separate facts. Earlier actions and Analysis details disclose history and technical explanations on request. Manual selection applies within the current Hand until another human action is accepted; a new Hand resets review and the sidebar follows its decisions. Latest decision appears for older reviews within This hand, while the Live tab opens the current live reference and retains the review selection. Review hand and Review decisions explicitly open This hand. One About these scores disclosure explains numerical meaning and limitations. Table administration likewise uses expandable sections.
- **Probability tree:** thin action-colored meters, right-aligned tabular probabilities and permanently expanded sizing children. A quiet vertical rule connects sizing rows. Selected reference action and accepted player action have distinct labels.
- **Dialogs and notices:** dialogs use the surface tone, a structural border, dark backdrop and elevated shadow. Recovery notices use warm brown surfaces with pale text and explicit controls. Pending analysis uses static tonal placeholders, preserving visible confirmed play.

## Do's and Don'ts

### Do:

- **Do** keep cards brighter than the surrounding shell and felt.
- **Do** use brass consistently for primary operations, active state and keyboard focus.
- **Do** preserve tabular numerals and clear labels for probabilities, totals and scores.
- **Do** preserve reduced-motion behavior and keep presentation independent of gameplay.

### Don't:

- **Don't** turn numerical alignment or action colors into advice, quality grades or celebratory judgments.
- **Don't** replace conventional card indices and suit distinctions with decorative symbols.
- **Don't** spread card and modal shadows across ordinary containers.
