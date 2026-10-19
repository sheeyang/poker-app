# Bind Observability with ParticipantCashGame

CashGame will expose a participant-scoped ParticipantCashGame facade that binds one stable ParticipantId and constructs participant-safe views, historical projections, and presentation events. WebSocket updates contain a complete Observable Game View for synchronization plus optional Observable Presentation Events for animation; raw CashGame state and CashGameEvents remain server-side. Complete views make reconnects and missed updates self-healing, while presentation events are never an authoritative state delta.

The facade is projection-only: authenticated server orchestration submits mutations through CashGame, and binding an observer does not establish authorization. The server explicitly maps these projections to plain wire DTOs owned by `packages/contracts`, which does not depend on the engine.

Each facade is lightweight and short-lived, bound to one specific CashGame instance and ParticipantId; connections retain stable identifiers and obtain a new facade from the latest committed instance when needed. Its current and historical reads return immutable snapshots, with `getView({ at: { decisionId } })` preserving visibility at the historical decision. Asynchronous work receives those snapshots rather than retaining a facade or a live game reference.

`getView()` is the primary participant read. Callers use `view.configuration`, `view.state`, and `view.history` from the same snapshot rather than assembling a view through separate `getConfiguration`, `getState`, or `getHistory` calls. Do not add those convenience getters without a concrete use case that cannot be served adequately by the complete view. `projectEvents()` retains its distinct responsibility for participant-safe presentation events. Neither CashGame nor ParticipantCashGame exposes `getRevision()`; revision tracking and reads belong to the backend aggregate, not the engine or participant facade.

## Observable contracts

Explicitly classify every configuration field as observable or hidden rather than defining visibility by subtracting known secrets with `Omit<GameConfiguration, "seed">`. ObservableGameConfiguration contains seat capacity, blinds, ante, minimum/default/maximum buy-ins, seat-change policy, and other settings participants may legally know. HiddenGameConfiguration contains the authoritative master seed and any future private settings; their intersection forms GameConfiguration for trusted construction, persistence, and replay.

Legal actions come from CashGame's shared internal legality calculation, also used by `act`. Bet/Raise descriptions expose inclusive integer sizing bounds or a single permitted short-all-in amount rather than every possible chip amount, following ADR-0025. They describe the requested snapshot's possibilities, not a guarantee that a later action submission remains legal after the game changes.

Use ObservableCashGameState as the single canonical participant-visible state type, including visible cards, public participant facts, board, street, pot information, current actor, and the observer's legal actions when applicable. Do not introduce a substantially duplicate ObservableDecisionState. The participant facade exposes configuration, state, and history together through its full-view projection, alongside separate presentation-event projection; its complete snapshot has the following composition:

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
  readonly type: "table-update";
  readonly tableSessionId: TableSessionId;
  readonly pokerRevision: Revision;
  readonly sessionRevision: Revision;
  readonly view: ObservableGameView;
  readonly presentationEvents: readonly ObservablePresentationEvent[];
}
```

The backend supplies both pokerRevision and sessionRevision from the committed aggregate and obtains only the complete view and projected presentation events from the committed game's participant facade. The revisions and projection must describe the same committed aggregate; publish only after durable commit. Revision metadata stays in the server-owned update envelope rather than becoming part of ObservableGameView or Policy input. The view is the synchronization authority; presentationEvents may be empty and never need to be applied to reconstruct state.

Order updates within each Table Session by sessionRevision, which also advances for committed controller or Trainer configuration changes even when pokerRevision is unchanged. Ignore older updates and do not replay presentation events from an already processed revision. A newer complete view can be accepted despite missing intermediate revisions. On initial table subscription or resubscription after reconnect, send the latest complete participant-safe view with both revisions; missed presentation events need not be replayed. Use pokerRevision for expectedPokerRevision on poker mutations and sessionRevision for expectedSessionRevision on application configuration mutations. These expectations belong to server request metadata, not CashGame method arguments.

## Shared browser connection and live-message contracts

M2 extends the existing connection modules to open one shared WebSocket per browser tab after local identity is established and keep it connected while the app is open. The server authenticates the identity cookie and automatically enables a user-scoped channel for analysis and summary notifications the user is authorized to access. A server-originated readiness signal identifies when that channel is active, independently of any live table subscription.

Opening a Table Session subscribes to its live views and runtime status; closing it unsubscribes without replacing the socket. The server authorizes every subscription and correlates its acceptance, rejection, or removal with the client's request. Closing the connection cleans up all its table subscriptions and user-channel delivery. Historical analysis needs no live table subscription: HTTP returns cached results or starts missing work, and the user-scoped channel notifies when work completes or fails.

`packages/contracts` owns the canonical shared server and client message unions, used by both connection modules rather than locally duplicated message types. Retain the session-related payload union and compose it with connection/subscription control messages:

```typescript
type TableLiveMessage =
  | ObservableTableUpdate // type: 'table-update'
  | TableRuntimeStatus   // type: 'table-status'
  | AnalysisUpdate;      // type: 'analysis-update'

type ServerLiveMessage =
  | UserChannelReady
  | TableSubscriptionResult
  | TableLiveMessage;

type ClientLiveMessage = SubscribeTable | UnsubscribeTable;
```

Every session-related message carries `tableSessionId`. `AnalysisUpdate` is a completion/failure notification identifying the exact immutable analysis request and execution attempt; numerical results and summary averages are fetched over HTTP. Successful results must be persisted and readable through HTTP before completion is notified, and failures must be recorded before their notifications. Clients ignore obsolete requests/attempts and refresh only relevant results. Analysis notifications do not advance pokerRevision or sessionRevision and must not pass through gameplay-revision filtering.

Relevant notifications trigger HTTP refreshes without normal polling. If a notification arrives during an HTTP request, the client must still reconcile afterward; an older pending response cannot hide the completed or failed state. Discard responses from retired connections and guard table snapshots by sessionRevision while guarding analysis by its exact request and execution attempt.

After user-channel readiness on the initial connection, refresh relevant analysis over HTTP to recover work that finished before the socket connected. On reconnect, restore the desired live table subscriptions and refresh currently relevant table and analysis state over HTTP. This handles missed notifications and transient queued/running/failure state being lost on server restart without requiring a durable event backlog or a live table subscription for analysis. Extend the existing modules for delivery, typed dispatch, cleanup, and reconnection without a new connection class; scheduling, caching, deduplication, and retry remain in the analysis module.
