---
status: superseded by ADR-0015
---

# Record Hands as Command and Event Transitions

The Poker Engine will process attempted decisions as commands and describe accepted state transitions with immutable events. Completed hands retain their initial conditions and ordered events so replay, analysis, alternate frontends, and a future authoritative server can use the same poker record instead of depending on UI snapshots.
