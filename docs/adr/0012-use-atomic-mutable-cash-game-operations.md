# Use Atomic Mutations on the Stateful CashGame

CashGame will be a stateful mutable domain object whose successful public methods atomically replace its internal authoritative state, record the accepted command, and return the derived transition events. Each operation computes and validates a private next state before commit, so an expected rejection or unexpected implementation failure leaves the live instance and accepted-command history unchanged.

## High-level commands

The public command surface comprises `seatParticipant`, `leaveParticipant`, `moveParticipant`, `setSittingOut`, `topUpTo`, `setButton`, `startHand`, and `act(participantId, action)`. All methods operate on the same CashGame instance. Humans, Bots, and replay submit the same ConcreteAction; `act` validates the current actor and legal action against current authoritative state without accepting a revision or attempting to identify the previous state from which an asynchronous caller computed it. Orchestration detects stale work before submission.

CashGame does not own, advance, expose, or restore a poker revision counter. Both `pokerRevision` and `sessionRevision`, expected-revision checks, requestId, authentication, mutation queues, and durable persistence belong to the server. Revision metadata is absent from CashGame method arguments, mutation results, observable views, and accepted poker commands. The engine never validates server request metadata; server revision ownership is defined in ADR-0018.

HandId and DecisionId remain engine-owned domain identifiers needed for deterministic replay and historical projections. They are not server concurrency revisions and do not require a revision counter on CashGame.

`startHand` determines eligible participants and blind positions, collects antes and blinds, shuffles and deals, and begins preflop action as one operation. `act` also performs every consequent betting-round closure, wager reset, burn, board deal, next-actor selection, required reveal, automatic runout, pot derivation, payout, and hand completion. Callers never need to orchestrate those mechanics or feed emitted events back as commands. CashGameEvents are descriptions returned for animation, logging, and replay presentation, not an authoritative persisted event history.

Expected domain failures return a structured rejection, including invalid actions or amounts, a wrong actor, insufficient eligible participants, invalid top-ups, and operations disallowed during an active Hand. They do not throw. Exceptions are reserved for implementation defects or broken internal invariants and still cannot partially commit the operation.

```typescript
type CashGameResult =
  | {
      readonly ok: true;
      readonly events: readonly CashGameEvent[];
    }
  | {
      readonly ok: false;
      readonly rejection: CashGameRejection;
    };
```

## Separate validation responsibilities

Configuration validity is independent of current table occupancy: validate representable non-negative chip amounts, positive small blind, big blind at least the small blind, non-negative ante, ordered minimum/default/maximum buy-ins, and the structural validity of other configured settings. A valid configuration may have no seated participants.

CashGame separately determines current table readiness and its eligible participant set. PokerCore defensively validates the requested Hand's fundamental structure: at least two unique valid participants, unique valid occupied seats, at least one chip per participant, a valid participating button seat, and no already-active Hand. Core checks do not impose sitting-out, buy-in, or other CashGame policies.
