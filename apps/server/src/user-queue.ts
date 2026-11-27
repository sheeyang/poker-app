/**
 * Runs each User's Current Table work one request at a time, whatever table it is for. Creating a table and joining
 * one both run in their User's turn: each checks the User's Current Table and then gives them a membership, so two
 * requests from two browser tabs cannot both pass the check. Leaving needs no turn: it can only free the User.
 *
 * Lock order: a User's turn first, then a handle on the table, then the table's FIFO. Never take a User's turn from
 * inside a table's FIFO, which a turn may be waiting on.
 */
export function createUserQueue() {
  const turns = new Map<string, Promise<unknown>>();
  return {
    /** Runs `operation` once every earlier operation of this User has settled. */
    async run<T>(userId: string, operation: () => Promise<T>): Promise<T> {
      const next = (turns.get(userId) ?? Promise.resolve()).catch(() => undefined).then(operation);
      turns.set(userId, next);
      try { return await next; } finally { if (turns.get(userId) === next) turns.delete(userId); }
    },
  };
}
export type UserQueue = ReturnType<typeof createUserQueue>;
