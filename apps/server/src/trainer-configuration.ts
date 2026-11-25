import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { defaultTrainerConfiguration, type StrategyDescriptor, type TrainerConfiguration, type TrainerConfigurationAcknowledgement, type TrainerConfigurationOutcome } from '@poker/contracts';
import { immutableData, isSupportedStrategy } from '@poker/strategies';
import type { openDatabase } from './db/database.js';
import { guestRequests, localUsers } from './db/schema.js';
import { canonical } from './canonical.js';
import { reject } from './rejections.js';
import { validateTrainerConfiguration } from './validation.js';
type Database = Omit<ReturnType<typeof openDatabase>['db'], '$client'>;

/** A stored Trainer Configuration that is no longer a supported one: it is not guessed at. */
export class TrainerConfigurationRestorationError extends Error {
  constructor() { super('The stored Trainer Configuration is not a supported one.'); }
}

/**
 * Each Guest's Trainer Configuration (ADR-0041): one Reference Strategy and Live Analysis setting for every table, kept
 * with their identity and never in a table's record. A Guest who never changed it has the default.
 *
 * Changing it is a Guest-scoped request, idempotent by request ID, and carries no table revision. Once a change has
 * committed, `announce` tells the Guest's connections, which read it again over HTTP. Table views and analysis read
 * the current value through `current`; a live table's synchronous projections use `known` for a Guest already read.
 */
export function createTrainerConfigurations(db: Database, announce: (userId: string) => void, supportsStrategy: (descriptor: unknown) => boolean = isSupportedStrategy) {
  // This process is the only writer, so a value read or written here stays current until this process changes it.
  const cache = new Map<string, TrainerConfiguration>();
  // A Guest's reads that miss the cache and their changes run one at a time, so a slow read never overwrites a change.
  const turns = new Map<string, Promise<unknown>>();
  function inTurn<T>(userId: string, operation: () => Promise<T>): Promise<T> {
    const next = (turns.get(userId) ?? Promise.resolve()).catch(() => undefined).then(operation);
    turns.set(userId, next);
    return next.finally(() => { if (turns.get(userId) === next) turns.delete(userId); });
  }
  async function stored(userId: string): Promise<TrainerConfiguration> {
    const [row] = await db.select({ trainerConfiguration: localUsers.trainerConfiguration }).from(localUsers).where(eq(localUsers.id, userId));
    const value = row?.trainerConfiguration;
    if (!value) return defaultTrainerConfiguration;
    if (validateTrainerConfiguration(value, supportsStrategy)) throw new TrainerConfigurationRestorationError();
    return immutableData(value);
  }
  async function current(userId: string): Promise<TrainerConfiguration> {
    return cache.get(userId) ?? inTurn(userId, async () => {
      const value = cache.get(userId) ?? await stored(userId);
      cache.set(userId, value);
      return value;
    });
  }
  /** Applies a change once per request ID. A request ID already used for a different configuration is a conflict. */
  async function set(userId: string, request: unknown): Promise<TrainerConfigurationOutcome> {
    const body = request as Record<string, unknown> | null;
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => key !== 'requestId' && key !== 'trainerConfiguration'))
      return reject('invalid-trainer-configuration', 'Supply only a requestId and a complete trainerConfiguration.');
    const invalid = validateTrainerConfiguration(body.trainerConfiguration, supportsStrategy);
    if (invalid) return invalid;
    const requestId = body.requestId as string;
    const trainerConfiguration = immutableData(body.trainerConfiguration as TrainerConfiguration);
    const fingerprint = createHash('sha256').update('trainer-configuration-v1:' + canonical(trainerConfiguration)).digest('hex');
    return inTurn(userId, async () => {
      let applied = false;
      let outcome: TrainerConfigurationOutcome;
      try {
        outcome = await db.transaction(async tx => {
          // The Guest's row orders their concurrent changes, from this process or any other transaction.
          await tx.select({ id: localUsers.id }).from(localUsers).where(eq(localUsers.id, userId)).for('update');
          const [prior] = await tx.select().from(guestRequests).where(and(eq(guestRequests.userId, userId), eq(guestRequests.requestId, requestId)));
          if (prior) return prior.fingerprint === fingerprint ? prior.outcome : reject('request-id-conflict', 'This requestId was already used for a different Trainer Configuration.');
          const acknowledgement: TrainerConfigurationAcknowledgement = { ok: true, trainerConfiguration };
          await tx.update(localUsers).set({ trainerConfiguration }).where(eq(localUsers.id, userId));
          await tx.insert(guestRequests).values({ userId, requestId, fingerprint, outcome: acknowledgement });
          applied = true;
          return acknowledgement;
        });
      } catch (error) {
        // Whether it committed may be unknown: read the value again, in the Guest's next turn, rather than trust either
        // one. A retry of the same request resolves its outcome from the record.
        void inTurn(userId, async () => { cache.set(userId, await stored(userId)); }).catch(() => cache.delete(userId));
        throw error;
      }
      if (applied) { cache.set(userId, trainerConfiguration); announce(userId); }
      return outcome;
    });
  }
  return {
    current,
    set,
    /** The Strategy a study runs under: the supported one the request names, else the Guest's Reference Strategy. Never changes the Trainer Configuration. */
    async studyStrategy(userId: string, strategy?: StrategyDescriptor): Promise<StrategyDescriptor> { return strategy ? immutableData(strategy) : (await current(userId)).referenceStrategy; },
    /** The Guest's configuration if this process has read or written it, for projections that cannot wait. */
    known: (userId: string): TrainerConfiguration | undefined => cache.get(userId),
  };
}
export type TrainerConfigurations = ReturnType<typeof createTrainerConfigurations>;
