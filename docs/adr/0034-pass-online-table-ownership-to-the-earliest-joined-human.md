# Pass Online Table Ownership to the Earliest-Joined Human

[ADR-0032](0032-extend-table-sessions-for-shared-online-play.md) made ownership permanent and held one of an Online Table's 20 places for an owner who had left, so they could always return to manage it. A table whose owner has gone would then have no one to manage its Bots, rules, or Table Password. Instead, when a Table Owner's Leave Table takes effect, ownership passes to the human Participant who joined earliest among those still at the table, including one who is only watching. A Bot never owns a table. If no other human is at the table, it becomes a Closed Table.

## Consequences

- The new owner has every owner capability, including setting a new Table Password. They never learn the previous one.
- A former owner returns like any other Guest, through the Join Link and any Table Password. No place is held for them, and the owner's separate return route is no longer needed.
- Leaving during a Hand is an After-Hand Request, so ownership passes when the Hand ends.
- Leaving tells the owner who will take over, or that the table will close.
