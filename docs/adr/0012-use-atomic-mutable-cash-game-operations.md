# Use Atomic Mutations on the Stateful CashGame

CashGame will be a stateful mutable domain object whose successful public methods atomically replace its internal authoritative state, advance its monotonic revision, record the accepted command, and return the derived transition events. Each operation computes and validates a private next state before commit, so an expected rejection or unexpected implementation failure leaves the live instance, revision, and history unchanged.
