# M1-01: Create an owned, persistent Table Session

## What to build

A local user opens the Playground, creates an empty configured Table Session, and can reopen that same owned session after a reload. Establish the minimum runnable workspace, trusted engine construction, real database persistence, safe server contracts, and Playground wiring as part of this path. Participant/controller identities are allocated and retained independently of seating; playing and Bot execution are added by later tickets.

M1 scope; apply accepted ADRs 0001, 0011–0015, 0017, 0018, 0020, 0022, 0025. This is a vertical slice of the playable foundation, not an invitation to implement later Trainer, product UX, replay tooling, Solver, or simulation milestones.

## Acceptance criteria

- [ ] The pnpm workspace contains the documented Contracts, Engine, Strategies, Solver, Simulation, and Research boundaries, plus Server and Playground applications; unimplemented later capabilities remain boundaries only. Browser imports cannot reach authoritative engine or Research implementations.
- [ ] Local startup and database initialization are documented and executable with the documented Node.js/Fastify, PostgreSQL/Drizzle, and React/Vite browser stack. This is one backend process and one local application user.
- [ ] A server-issued opaque HttpOnly cookie identifies the local user. The creator becomes Table Owner; supplied owner/Participant identifiers cannot override authentication. Stable human and configured Bot ParticipantIds and controller descriptors are application data, not poker commands.
- [ ] Creation validates observable settings independently of occupancy: 2–9 seats with default 6, blinds 10/20, ante 0, buy-in minimum/default/maximum 1000, representable integer chip amounts, positive small blind, big blind at least small blind, nonnegative ante, ordered buy-in limits, and seat changes enabled by default.
- [ ] The server creates the hidden master seed and rejects a client-provided seed or other hidden settings. Configuration is immutable; changed settings and a fresh game require a new Table Session, with no Reset Table command.
- [ ] A fresh version-1 CashGame record contains complete trusted configuration and zero accepted commands. The persisted aggregate also retains ownership, controller bindings, version metadata, and committed pokerRevision/sessionRevision; neither revision belongs to CashGame.
- [ ] Creation and its authenticated-user/requestId fingerprint and small definitive outcome commit atomically. A matching retry returns the same TableSessionId and bindings; conflicting requestId contents are rejected. A missing definitive outcome caused by infrastructure failure is not a stored domain rejection, and an ambiguous commit is not automatically retried.
- [ ] The Playground has configuration/create/reopen controls and a safe empty-table view. The server returns only field-by-field observable DTOs, never a master seed, authoritative record, or live CashGame object.
- [ ] Real PostgreSQL-backed HTTP tests and a browser smoke verify create/read/reload, invalid settings, hidden-field rejection, owner authorization, matching creation retry, and conflicting request reuse. No committed table is advertised before database commit.

## Blocked by

None (can start immediately).

