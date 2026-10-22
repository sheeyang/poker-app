# Retire the Playground

The independent engineering Playground is no longer needed now that the Trainer
is available. Remove `apps/playground`, its development command, and its
Playground-specific browser smoke scripts. `apps/web` remains the Trainer, using
the existing shared client, safe Contracts, and authoritative server.

This supersedes ADR-0022's ongoing Playground requirement and ADR-0028's
two-browser-app arrangement. Validate capabilities through automated tests,
retained server transport fixtures, and the relevant product interfaces; later
milestones do not require a separate Playground first. Historical milestone
specifications and implementation evidence describe the interface used at the
time and are retained as history.
