import type { ServerClock } from './clock.js';

/** How long a table stays in memory after the last handle on it is released (ADR-0035). */
export const unloadGraceMs = 60_000;

/**
 * One claim that a table is needed, like a reference-counted pointer: the table stays in memory while any handle on
 * it is unreleased. Release it in a `finally`, so that a failed request cannot leak it. Releasing it again does nothing.
 */
export interface TableHandle { release(): void }

export interface TableRegistryOptions<T> {
  /** Loads a table from its record, or `undefined` when there is no such table. */
  readonly load: (id: string) => Promise<T | undefined>;
  /** Runs as soon as a table is in memory, before any acquire that loaded it returns. */
  readonly loaded?: (id: string, table: T) => void;
  /** Settles once the table's queued work has finished. An unload waits for it. */
  readonly drain: (id: string) => Promise<void>;
  /** Runs as a table leaves memory, after its queued work. */
  readonly unloaded: (id: string, table: T) => void;
  readonly clock: ServerClock;
}

interface Entry<T> {
  /** The table in memory; `undefined` while it loads. */
  table?: T;
  loading?: Promise<T | undefined>;
  /** Handles not yet released. */
  holds: number;
  cancelUnload?: () => void;
  unloading?: Promise<void>;
}

/**
 * The only way to reach a table in memory (ADR-0035). `acquire` returns a handle on the table, loading it from its
 * record unless it is already loaded. A table unloads `unloadGraceMs` after its last handle is released; acquiring it
 * within that time cancels the unload. An unload waits for the table's queued work, and an acquire that arrives
 * meanwhile waits for the unload to finish, then loads a fresh copy.
 */
export function createTableRegistry<T>(options: TableRegistryOptions<T>) {
  const entries = new Map<string, Entry<T>>();
  let closed = false;

  function handle(id: string, entry: Entry<T>): TableHandle {
    let released = false;
    return { release() { if (released) return; released = true; entry.holds--; idle(id, entry); } };
  }
  /** Takes a hold on a loaded entry: any unload not yet under way is cancelled. */
  function hold(id: string, entry: Entry<T>): TableHandle {
    entry.holds++;
    entry.cancelUnload?.(); entry.cancelUnload = undefined;
    return handle(id, entry);
  }
  /** Starts the grace period once nothing holds the table. An unload under way decides for itself when its wait ends. */
  function idle(id: string, entry: Entry<T>) {
    if (closed || entry.holds > 0 || entry.unloading || entry.cancelUnload || entries.get(id) !== entry || entry.table === undefined) return;
    entry.cancelUnload = options.clock.setTimer(options.clock.now() + unloadGraceMs, () => { entry.cancelUnload = undefined; unload(id, entry); }, 'housekeeping');
  }
  function unload(id: string, entry: Entry<T>) {
    if (closed || entry.holds > 0 || entry.unloading || entries.get(id) !== entry) return;
    entry.unloading = (async () => {
      await options.drain(id).catch(() => {});
      // Queued work may have found more to do, and taken a hold for it: then the table stays.
      if (closed || entry.holds > 0) return;
      entries.delete(id);
      try { options.unloaded(id, entry.table!); } catch { /* The table has left memory whatever its clean-up does. */ }
    })().finally(() => { entry.unloading = undefined; idle(id, entry); });
  }

  return {
    /** A handle on the table, loaded from its record when it is not in memory; `undefined` when there is no such table. */
    async acquire(id: string): Promise<TableHandle | undefined> {
      for (;;) {
        const existing = entries.get(id);
        if (existing?.unloading) { await existing.unloading; continue; }
        let entry = existing;
        if (!entry) {
          const created: Entry<T> = { holds: 0 };
          entry = created;
          entries.set(id, created);
          created.loading = options.load(id);
          // Registered first, so the table is in place before any acquirer resumes.
          created.loading.then(table => {
            created.loading = undefined;
            if (table === undefined) { entries.delete(id); return; }
            created.table = table;
            try { options.loaded?.(id, table); } catch { /* The table is loaded whatever its follow-up work does. */ }
          }, () => { entries.delete(id); });
        }
        const claim = hold(id, entry);
        try { await entry.loading; }
        catch (error) { claim.release(); throw error; }
        if (entry.table === undefined) { claim.release(); return undefined; }
        return claim;
      }
    },
    /**
     * A further handle on a table already in memory, for work it has started there (scheduled work, a queued
     * operation); `undefined` when it is not loaded. Work queued during an unload keeps the table.
     */
    retain(id: string): TableHandle | undefined {
      const entry = entries.get(id);
      return entry?.table === undefined ? undefined : hold(id, entry);
    },
    /** The table in memory, if it is loaded. Holds nothing. */
    get(id: string): T | undefined { return entries.get(id)?.table; },
    /** Replaces the copy of a loaded table, as each commit does. A table not in memory stays unloaded. */
    set(id: string, table: T) { const entry = entries.get(id); if (entry?.table !== undefined) entry.table = table; },
    /** The IDs of the tables in memory now. */
    loadedIds(): string[] { return [...entries].filter(([, entry]) => entry.table !== undefined).map(([id]) => id); },
    /** Every table in memory, by ID. */
    loadedTables(): [string, T][] { return [...entries].flatMap(([id, entry]) => entry.table === undefined ? [] : [[id, entry.table] as [string, T]]); },
    /** Stops unloading: the server is closing, and its memory goes with it. */
    close() {
      closed = true;
      for (const entry of entries.values()) { entry.cancelUnload?.(); entry.cancelUnload = undefined; }
    },
  };
}
export type TableRegistry<T> = ReturnType<typeof createTableRegistry<T>>;
