# Close Idle Online Tables and Load Tables Only While Needed

[ADR-0032](0032-extend-table-sessions-for-shared-online-play.md) loaded every table at server startup and capped each Guest at 10 owned tables with a seated human, so that one Guest could not exhaust the single server. Practice Tables are now never left or closed, so a cap would end a Guest's practice history and loading every table would grow without bound. Instead, there is no cap, and a table is in memory only while something needs it.

## Decisions

- **Online Tables close; Practice Tables never do.** An Online Table becomes a Closed Table after 24 hours without a committed change, or when its Table Owner leaves with no other human at it ([ADR-0034](0034-pass-online-table-ownership-to-the-earliest-joined-human.md)). A Closed Table is never loaded and cannot be opened until replay arrives in M6.
- **A table stays loaded only while it is needed.** It is needed while an open tab is subscribed to it, while a request is being handled at it, or while it has scheduled work: an Action Deadline, a Presentation Phase, a Next-Hand Countdown, a Bot decision, or After-Hand Requests to apply. When nothing has needed it for one minute, it is unloaded. Anything that needs it again within that minute keeps it loaded.
- **Startup loads only tables with scheduled work.** Each table stores `loadAtStartup`, which is true exactly while it has scheduled work. In practice that means an Online Table in play, or a timed Practice Table with a Hand in progress, so that its deadlines keep running without its human. Every other table loads the first time a request needs it.

## Consequences

- Each load reconstructs the table from its record ([ADR-0015](0015-persist-seed-and-accepted-commands.md)), so reopening a long practice session replays all of it. The one-minute grace saves that replay when a tab is only reloaded.
- Saved-table lists read stored facts and never load a table. Requests from anyone who is not at a table are answered from the database, so strangers cannot make the server load tables.
- Closing an idle table that is not loaded is a database update, with no load.
