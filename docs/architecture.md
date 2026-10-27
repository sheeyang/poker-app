# Workspace architecture

This is the current package map. Architectural decisions and their rationale live
in [the ADRs](adr/); concrete server behavior is described in
[the server protocol reference](server-protocol.md).

| Path | Responsibility |
| --- | --- |
| [`packages/contracts`](../packages/contracts) | Explicit participant-safe HTTP/WebSocket and observable game types. |
| [`packages/engine`](../packages/engine) | Trusted CashGame construction, rules, records, replay, forks, and ParticipantCashGame projections. |
| [`packages/strategies`](../packages/strategies) | Policy/Action Selector implementation and validation. |
| [`packages/solver`](../packages/solver) | Deferred Solver capability boundary. |
| [`packages/simulation`](../packages/simulation) | Deferred automated simulation boundary. |
| [`packages/research`](../packages/research) | Server-only analysis and authorized completed-Hand inspection. |
| [`apps/server`](../apps/server) | Fastify authorization, identity, ownership, controllers, PostgreSQL/Drizzle persistence, and durable orchestration. |
| [`apps/web`](../apps/web) | React/Vite, TanStack Router/Query, and Zustand Trainer UI. |
| [`packages/client`](../packages/client) | Shared HTTP, live synchronization, and analysis-resource reconciliation. |

## Dependency enforcement

[`scripts/check-boundaries.mjs`](../scripts/check-boundaries.mjs), run by
`pnpm check:boundaries` and `pnpm check`, checks transitive workspace dependencies:

- Browser packages (`@poker/client` and `@poker/web`) and Contracts cannot reach
  authoritative packages.
- Engine cannot depend on Strategies or Research.
- Strategies, Solver, and Simulation cannot depend on Research.

The [Trainer Vite configuration](../apps/web/vite.config.ts) also rejects
authoritative runtime imports, including relative imports into authoritative
package implementations.

## Related decisions

- [ADR-0001](adr/0001-separate-engine-and-strategies.md): Engine, Strategies, and Research boundaries.
- [ADR-0013](adr/0013-use-an-authoritative-server-from-m1.md): server authority and browser trust boundary.
- [ADR-0017](adr/0017-bind-observability-with-participant-cash-game.md): participant-safe projections and live contracts.
- [ADR-0012](adr/0012-use-atomic-mutable-cash-game-operations.md) and [ADR-0015](adr/0015-persist-seed-and-accepted-commands.md): atomic Engine operations, record export, and restoration.
- [ADR-0025](adr/0025-document-standard-cash-game-rules.md): Cash Game configuration and rules.
- [ADR-0028](adr/0028-introduce-the-product-trainer-interface.md): Trainer interface and shared Client.
- [ADR-0029](adr/0029-retire-the-playground.md): retirement of the independent Playground.

Seed derivation, random sources, deck order/shuffle, and selector sampling are
specified in [random v1](random-v1.md).
