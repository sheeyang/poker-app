# Use the Online Table's Address as Its Join Link

Giving every table its own URL raised the question of what a friend sees when someone copies the address bar instead of the separate secret Join Link. We decided that the two are one thing: an Online Table's address, `/online/$tableSessionId`, is its Join Link. It never changes, and a Guest who opens it joins the table. A Table Owner who wants to restrict joining sets an optional Table Password. This revises [ADR-0032](0032-extend-table-sessions-for-shared-online-play.md), which gave each Online Table a secret token that only the owner could see and replace, and which made Removal bar a Guest from joining again.

## Decisions

- **Who needs the Table Password.** Anyone not currently at the table, including a Guest who left or was removed, and a former Table Owner, since ownership passes on when the owner leaves ([ADR-0034](0034-pass-online-table-ownership-to-the-earliest-joined-human.md)). Otherwise a stranger who joined through a leaked link and then left could return after the owner added a password.
- **Removal no longer bars a Guest.** It is a Leave Table imposed by the Table Owner, and the Guest may join again like anyone else, keeping the same Participant. Nothing records that a Guest was removed. Barring can be added later if it proves necessary.
- **The password is stored hashed.** People reuse passwords, so a database leak should not expose them. An owner who forgets it sets a new one.

## Considered options

- **Keeping a separate secret link and adding a password.** Rejected: it leaves two addresses for one table, and copying the address bar would remain a mistake that a friend hits as a dead end.
- **Keeping Replace Join Link.** Rejected: changing the password shuts out newcomers in the same way, without invalidating an address everyone has already saved.

## Consequences

- Every Participant holds the invitation, because it is in their address bar. Without a Table Password, anyone at the table can bring in others, where previously only the owner could.
- A table with no Table Password has no way to keep a removed Guest out. The owner sets or changes the password to do so, and every later newcomer then needs it.
- An earlier `/join/<token>` link stops working, as [ADR-0014](0014-allow-pre-release-record-breaking-changes.md) allows before release.
- The M9 item to make Removal survive cleared browser storage no longer applies.
