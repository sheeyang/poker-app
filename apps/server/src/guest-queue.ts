/**
 * Runs each Guest's Current Table work one request at a time, whatever table it is for. Creating a table and joining
 * one both run in their Guest's turn: each checks the Guest's Current Table and then gives them a membership, so two
 * requests from two browser tabs cannot both pass the check. Leaving needs no turn: it can only free the Guest.
 *
 * Lock order: a Guest's turn first, then a handle on the table, then the table's FIFO. Never take a Guest's turn from
 * inside a table's FIFO, which a turn may be waiting on.
 */
export function createGuestQueue() {
  const turns = new Map<string, Promise<unknown>>();
  return {
    /** Runs `operation` once every earlier operation of this Guest has settled. */
    async run<T>(userId: string, operation: () => Promise<T>): Promise<T> {
      const next = (turns.get(userId) ?? Promise.resolve()).catch(() => undefined).then(operation);
      turns.set(userId, next);
      try { return await next; } finally { if (turns.get(userId) === next) turns.delete(userId); }
    },
  };
}
export type GuestQueue = ReturnType<typeof createGuestQueue>;
