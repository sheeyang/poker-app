# Persist the Master Seed and Accepted Commands

The authoritative Table Session Record will contain version 1 metadata, the complete Game Configuration including its hidden master seed, and the ordered successful Cash Game commands. Each Hand derives an independent seed from the master seed and a stable authoritative Hand sequence, then deterministically shuffles its deck. Shuffled decks, derived Hand seeds, card traces, burn cards, RNG state, rejected commands, and Cash Game events are not separately persisted because they can be reconstructed from the single authoritative record. Research obtains completed-Hand hidden information by replaying that record.

Game Configuration is immutable for the lifetime of a Table Session in M1; different settings require a new Table Session with a newly generated server seed.

There is no Reset Table operation; callers create a new Table Session when a fresh game is desired.

## Plain-data export and complete restoration

Do not persist or deserialize the live CashGame instance, its private plain-data state, mutable collections, RNG objects, or caches. Plain-data internal state is still an implementation detail, not the durable format. `CashGame.toRecord()` constructs a detached immutable plain-data record of replay inputs rather than exposing mutable internal references:

```typescript
interface TableSessionRecord {
  readonly schemaVersion: 1;
  readonly engineVersion: "v1";
  readonly configuration: GameConfiguration;
  readonly commands: readonly CashGameCommand[];
}
```

CashGameCommand represents each successful public mutation, including initial seating and button setup, leaving, moving seats, sitting out, top-ups, Hand starts, and actions. Mutable setup has no second authoritative initial-state representation. Rejected attempts remain outside this record, even when application idempotency or audit data remembers them.

`CashGame.create(configuration)` constructs a fresh authoritative game from trusted explicit inputs. `CashGame.fromRecord(record)` validates the plain-data format and supported versions, creates a fresh temporary game from the authoritative configuration, and replays every command through normal validated behavior. Validate the complete reconstruction and final invariants before returning a usable game. A malformed, incompatible, or rejected command produces a structured restoration failure; never return the state from a valid prefix. Successful restoration reproduces cards, stacks, contributions, pots, button, actor, street, Hand/session facts and domain identifiers, regenerated events, and observable histories.

Server concurrency revisions are not part of TableSessionRecord or CashGame restoration. The backend separately restores `pokerRevision` and `sessionRevision` from its PersistedTableSession aggregate alongside the reconstructed game, as defined in ADR-0018.

Normal callers cannot append recorded commands or events, replace internal state, or inject arbitrary history through methods such as `appendRecordedCommand`, `appendEvent`, `replaceState`, or `loadInternalState`. Trusted restoration may optimize replay internally only while preserving the same semantics. Pre-release compatibility remains governed by ADR-0014; this contract adds no migration or old-version compatibility guarantee.

The independent `CashGame.fork()` operation in ADR-0011 does not add a persisted command or a second durable state format. The deferred M7 scenario builder in ADR-0004 constructs validated transient Solver models; it is not an alternative restoration path for authoritative Table Sessions and does not alter this record schema.
