# Table flow comparison

From the repository root, run `pnpm --filter @poker/web dev`, then open
[`http://127.0.0.1:5174/seat-flows.html`](http://127.0.0.1:5174/seat-flows.html).
The demo needs only the web dev server; no database or API server is required.

This is a standalone React + Vite + Tailwind comparison of seven seating and
stack-management improvements. It uses synthetic local state and makes no API
requests. The Trainer remains at `/`. The HTML entry loads its own React root and
stylesheet; it does not use the Trainer router or session state. Vite also builds
the demo as a separate HTML entry with `pnpm --filter @poker/web build`.

Choose a numbered scenario, complete either version independently, and use
**Replay both** to restore the starting state. The initial display represents
the result of the gesture described above the frames. Interaction counts include
that gesture, plus subsequent panel, disclosure, seat-selection and action
button activations. Editing a numeric field does not increment them; pressing an
amount-preset button does.
Automatic navigation in the proposed Join Link flow starts at zero. After's
scenarios 2–6 also have **Try After as** and **Hand in progress** controls. These
exploration controls reset only After; they do not affect the Before recreation
or increment the flow's interaction count.

On desktop, both versions are visible together. On phones, use **Before** and
**After** to switch between them; each version retains its own state. Changing
scenario or using **Replay both** resets both versions. **Next change** walks the
same priority order and returns to Rebuy after Join link. Refreshing the page
returns to the initial Rebuy comparison; nothing is persisted.

| Priority | Scenario | Try in After |
| --- | --- | --- |
| 1 · High impact | Rebuy | Confirm the prefilled 2,000 chips in the focused dialog, or edit the amount/use a preset. Before requires expanding You in Table options. |
| 2 · High impact | Move seat | The seat-4 menu is open. Choose Move here to move, keeping the 2,000-chip stack. Opening or dismissing the menu never moves you. |
| 3 · High impact | Add a Bot | The owner's seat-4 menu offers Move here and Add a Bot here. Choose Add a Bot here, edit the name, strategy or buy-in, then add it. The resulting seat shows the submitted name and stack. |
| 4 · Small fix | Participant actions | Your participant menu is open. Choose a seat highlights open seats on the table. Click a +, choose Take this seat, then confirm the buy-in. Click your seated participant or a Bot to explore their actions. Before keeps participant controls in Table options. |
| 5 · Small fix | Top-up | Choose Top up from your participant menu, then confirm the valid 4,000-chip total, adding 1,990 to the current 2,010. Before starts at the invalid 2,000-chip total and needs correction. |
| 6 · Polish | Last open seat | Click highlighted seat 4, choose Take this seat, then confirm the buy-in. The same explicit menu is used even with one open seat; there is no separate seat picker or redundant Choose a seat button in the tray or your participant menu. |
| 7 · Polish | Join link | Observe the already-open table and zero interactions. Before requires pressing Open table on the recognition card. |

The Before flows are focused recreations of the relevant current controls,
rather than full copies of every Table options setting. Amount limits in this
demo are 400–4,000 whole chips, with a default buy-in of 2,000. Top-ups must
increase the target participant's current stack, so the initial Top-up example
has a minimum of 2,011. Invalid amounts disable submission. Actual table limits
remain server-owned in the product.

The seats, stacks, Bot strategy options and Join Link recognition are synthetic.
Choosing or applying a strategy only changes local demo state; the demo does not deal Hands,
run Bots, navigate a real Join Link or model server timing, authorization,
concurrency, networking and recovery states. The Before forms intentionally show
the relevant existing detours rather than implementing a second full Trainer.

After has no Table options control or dialog. Click an occupied participant for
their actions, or **You · Watching** in the tray for your watching actions.

| Participant | Available actions |
| --- | --- |
| You, watching | Choose a seat when several seats are open; Leave table |
| You, seated | Top up or Rebuy; Sit out or Return to play; Move seat; Stand up; Leave table |
| Bot, viewed by the owner | Top up or Rebuy; Sit out or Return to play; Move seat; Playing Strategy; Remove Bot |
| Bot, viewed by a guest | Read-only stack summary |

Move seat highlights and focuses open seats on the table. For a Bot, select a
destination + and confirm **Move [Bot name] here**. Top-up and strategy forms
belong to the selected participant. Leaving and removing a Bot require a
confirmation. A completed local leave exposes **Return to table** in the tray.

Every open seat in After is a + button with an accessible Seat-actions label,
and opens the same menu pattern:

| Viewer | Menu actions |
| --- | --- |
| Watching guest | Take this seat |
| Seated guest | Move here |
| Watching owner | Take this seat; Add a Bot here |
| Seated owner | Move here; Add a Bot here |

Move here applies immediately and keeps the stack. Routine action subtitles are
omitted. During a Hand, Move and Top up/Rebuy are disabled with “Available
between hands”; Return to play is also unavailable. Taking a seat and adding a
Bot remain available for the next Hand. Sit out, Stand up, Leave and Remove Bot
record an after-this-hand request when applicable, shown beside the participant.
Conflicting participant actions are disabled while a request is pending, and
Top up is disabled at the maximum stack.

The demo never advances or settles a Hand. Pending requests remain local UI
state; changing **Hand in progress** resets After rather than applying them.
Selecting a seat happens only on the table. The buy-in and Bot
forms retain the clicked seat and offer **Choose a different seat** to return to
the highlighted table. There is no After seat dropdown or seat-button picker.

Menus dismiss on outside click, Escape or their close control. Enter opens a
focused seat or participant's menu; Arrow Up/Down and Home/End navigate its enabled actions.
Choosing an action with Enter opens its form or moves the player. Escape returns
focus to the menu's seat or participant; closing a form returns focus to its
seat or participant.

The visual authority remains the root `DESIGN.md`, `PRODUCT.md` and
`.impeccable/design.json`. This surface inherits their dark green shell, felt,
brass accents and system typography. Its compact comparison frames and phone
version switch are local prototype choices, not changes to the shared system.
Review captures are stored in `.impeccable/review/` as
`participant-desktop.png`, `participant-mobile.png`,
`participant-topup-mobile.png`, `participant-watching-mobile.png` and
`participant-seat-mobile.png`; they are review evidence, not shipping image
assets.
