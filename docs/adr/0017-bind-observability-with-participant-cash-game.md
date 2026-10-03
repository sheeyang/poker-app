# Bind Observability with ParticipantCashGame

CashGame will expose a participant-scoped ParticipantCashGame facade that binds one stable ParticipantId and constructs participant-safe views, historical projections, and presentation events. WebSocket updates contain a complete Observable Game View for synchronization plus optional Observable Presentation Events for animation; raw CashGame state and CashGameEvents remain server-side. Complete views make reconnects and missed updates self-healing, while presentation events are never an authoritative state delta.

The facade is projection-only: authenticated server orchestration submits mutations through CashGame, and binding an observer does not establish authorization. The server explicitly maps these projections to plain wire DTOs owned by `packages/contracts`, which does not depend on the engine.

Each facade is lightweight and short-lived, bound to one specific CashGame instance and ParticipantId; connections retain stable identifiers and obtain a new facade from the latest committed instance when needed. Its current and historical reads return immutable snapshots, with `getView({ at: { decisionId } })` preserving visibility at the historical decision. Asynchronous work receives those snapshots rather than retaining a facade or a live game reference.

## Observable contracts

Explicitly classify every configuration field as observable or hidden rather than defining visibility by subtracting known secrets with `Omit<GameConfiguration, "seed">`. ObservableGameConfiguration contains seat capacity, blinds, ante, minimum/default/maximum buy-ins, seat-change policy, and other settings participants may legally know. HiddenGameConfiguration contains the authoritative master seed and any future private settings; their intersection forms GameConfiguration for trusted construction, persistence, and replay.

Use ObservableCashGameState as the single canonical participant-visible state type, including visible cards, public participant facts, board, street, pot information, current actor, and the observer's legal actions when applicable. Do not introduce a substantially duplicate ObservableDecisionState. The participant facade offers configuration, state, history, revision, full-view, and presentation-event projections; its complete snapshot has the following composition:

```typescript
interface ObservableGameConfiguration {
  readonly seatCount: number;
  readonly smallBlind: ChipAmount;
  readonly bigBlind: ChipAmount;
  readonly ante: ChipAmount;
  readonly minimumBuyIn: ChipAmount;
  readonly defaultBuyIn: ChipAmount;
  readonly maximumBuyIn: ChipAmount;
  readonly allowSeatChanges: boolean;
}

interface HiddenGameConfiguration {
  readonly seed: RandomSeed;
}

type GameConfiguration =
  ObservableGameConfiguration & HiddenGameConfiguration;

interface ObservableGameView {
  readonly configuration: Readonly<ObservableGameConfiguration>;
  readonly state: ObservableCashGameState;
  readonly history: ObservableSessionHistory;
}
```

Construct the runtime objects field by field. Returning authoritative objects under narrower TypeScript types is not an information boundary: hidden configuration, unrevealed opponent cards, future cards, deck order, and hidden event payloads must not physically remain in the projection. Hidden hole cards may instead be represented by visibility and card-count facts; a burn presentation event conveys only that a face-down card was burned, never its identity.

ObservableSessionHistory is an immutable derived view of authoritative replay history for the bound ParticipantId, when they joined, and the requested historical point. New participants receive only information legally observable from when they joined; leaving and rejoining preserves stable identity and previously observed history without inventing information they were not allowed to observe. Moving seats neither resets that history nor transfers it to the next occupant. Reveals at later showdown or in Research never retroactively expose earlier hidden facts, and Policies never receive raw events they are expected to filter themselves.

## Committed WebSocket update envelope

The server sends a separately constructed update to each authorized participant, using a fresh facade over the latest committed CashGame. The wire contract identifies the Table Session and includes both committed revisions from ADR-0018:

```typescript
interface ObservableTableUpdate {
  readonly tableSessionId: TableSessionId;
  readonly pokerRevision: Revision;
  readonly sessionRevision: Revision;
  readonly view: ObservableGameView;
  readonly presentationEvents: readonly ObservablePresentationEvent[];
}
```

The backend supplies sessionRevision and obtains pokerRevision, the complete view, and projected presentation events from the committed game and participant facade. Publish only after durable commit. The view is the synchronization authority; presentationEvents may be empty and never need to be applied to reconstruct state.

Order updates within each Table Session by sessionRevision, which also advances for committed controller or Trainer configuration changes even when pokerRevision is unchanged. Ignore older updates and do not replay presentation events from an already processed revision. A newer complete view can be accepted despite missing intermediate revisions. On reconnect, send the latest complete participant-safe view with both revisions; missed presentation events need not be replayed. Use pokerRevision for expectedRevision on poker mutations and sessionRevision for expectedSessionRevision on application configuration mutations.
