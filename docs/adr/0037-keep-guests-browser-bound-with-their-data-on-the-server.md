---
status: accepted
---

# Keep Guests Browser-Bound, with Their Data on the Server

A Guest is a server row reached by a long-lived cookie. There is no login, and none is planned for now. The usual pattern for guest identity is a server-side anonymous ID carried by a cookie, with the guest's data hanging off that ID so that a later account can adopt it. The app followed that for the display name and table membership, but kept last-opened times in browser storage, never expired a Guest, and let the cookie lapse a year after it was first set whatever the Guest did.

## Decisions

- **A Guest stays bound to one browser.** Clearing site data or using another browser makes a new Guest. This is stated in the Guest glossary entry, and the Trainer says it once, when the Guest first sets a display name.
- **Last-opened times move to the server**, keyed by Guest and table, beside membership. Browser storage keeps only device preferences: card animations and the analysis panel (card animations were later removed; see ADR-0038). Times already in a browser are not imported; saved lists start unordered and order themselves as tables are opened.
- **A Guest with no tables and no display name is purged** after a period of inactivity, starting at 90 days. This needs a last-seen time on the Guest, updated at most once a day. A Guest who owns or belongs to a table is never purged.
- **The cookie slides.** Each visit sets it again with a fresh year, at most once a day, so a regular player does not become a new Guest on an anniversary.

## Consequences

- If accounts are added, a Guest's tables, display name and last-opened times already belong to one server row, so it can be upgraded in place rather than migrated from browser storage.
- Saved lists order the same way whatever the browser's storage holds, so the "listed last" note and the "never opened in this browser" fallback go.
- Guests who have tables are kept indefinitely, so storage grows with them. Deleting inactive Guests with tables is a separate decision.
- The browser binding stays a limit: nothing here lets a Guest reach their tables from another device.
