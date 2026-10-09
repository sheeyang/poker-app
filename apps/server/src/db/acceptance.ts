import { Pool, type Client, type PoolClient } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from './schema.js';
import type { openDatabase } from './database.js';

export class CommitOutcomeUnknown extends Error {}
export interface AttemptScope { readonly kind: 'creation' | 'table'; readonly id: string; readonly requestId: string }
export interface Attempt extends AttemptScope { readonly fingerprint: string; readonly transactionId: string; readonly state: 'pending' | 'noncommit'; readonly tableSessionId?: string }
export interface TransactionContext { readonly requestId: string; readonly tableSessionId?: string }
/** Trusted real-SQL fault tooling. A detached client remains owned and cleaned up by its fixture. */
export interface AcceptanceFaults {
  readonly openClient?: (context: TransactionContext) => Promise<{ client: Client | PoolClient; release: (destroy?: boolean) => void } | undefined>;
  readonly terminalCommit?: (client: Client | PoolClient, context: TransactionContext) => Promise<void>;
}
type Database = Omit<ReturnType<typeof openDatabase>['db'], '$client'>;
export class AcceptanceTransactions {
  private readonly journal: Pool;
  private readonly closing = Promise.withResolvers<never>();
  private stopped = false;
  constructor(private readonly targets: Pool, databaseUrl: string, namespace = 'public') {
    // Target clients must never exhaust the capacity needed to durably journal them.
    this.journal = new Pool({ connectionString: databaseUrl, options: '-c search_path=' + namespace, max: 2, connectionTimeoutMillis: 2000, query_timeout: 2000, statement_timeout: 2000 });
    void this.closing.promise.catch(() => {});
  }
  stop() { if (!this.stopped) { this.stopped = true; this.closing.reject(new Error('Server is closing.')); } }
  async close() { await this.journal.end(); }
  private active() { if (this.stopped) throw new Error('Server is closing.'); }
  async run<T>(scope: AttemptScope, fingerprint: string, callback: (tx: Database) => Promise<T>, options: AcceptanceFaults & { beforeCommit?: () => Promise<void>; afterCommit?: () => Promise<void>; tableSessionId?: (result: T) => string | undefined } = {}): Promise<T> {
    this.active();
    const context = { requestId: scope.requestId, ...(scope.kind === 'table' ? { tableSessionId: scope.id } : {}) };
    const supplied = await options.openClient?.(context);
    const client = supplied?.client ?? await this.targets.connect();
    const release = supplied?.release ?? ((destroy?: boolean) => (client as PoolClient).release(destroy));
    let terminal = false;
    let unusable = false;
    let journaled = false;
    try {
      await client.query('BEGIN');
      const xid = await client.query<{ xid: string }>('SELECT pg_current_xact_id()::text AS xid');
      const result = await callback(drizzle({ client, schema }));
      await Promise.race([options.beforeCommit?.() ?? Promise.resolve(), this.closing.promise]);
      this.active();
      await this.journal.query('INSERT INTO acceptance_attempts(scope_kind, scope_id, request_id, fingerprint, transaction_id, state, table_session_id) VALUES ($1,$2,$3,$4,$5,$6,$7)', [scope.kind, scope.id, scope.requestId, fingerprint, xid.rows[0]!.xid, 'pending', scope.kind === 'table' ? scope.id : options.tableSessionId?.(result) ?? null]);
      journaled = true;
      this.active();
      terminal = true;
      if (options.terminalCommit) await options.terminalCommit(client, context);
      else await client.query('COMMIT');
      await options.afterCommit?.();
      // Journal cleanup cannot turn a positively confirmed acceptance into a failure.
      await this.forget(scope).catch(() => {});
      return result;
    } catch (error) {
      if (terminal) { unusable = true; throw new CommitOutcomeUnknown('COMMIT acknowledgement was not confirmed.', { cause: error }); }
      try {
        await client.query('ROLLBACK');
        // No terminal COMMIT was dispatched; ordinary pre-COMMIT faults remain retryable.
        if (journaled) await this.forget(scope);
      } catch { /* A surviving journal conservatively gates recovery. */ }
      throw error;
    } finally {
      // Disposition cannot replace an established outcome (or its original failure).
      try { release(unusable); } catch { /* The client owner remains responsible for cleanup. */ }
    }
  }
  async attempts(): Promise<Attempt[]> {
    const result = await this.journal.query('SELECT scope_kind, scope_id, request_id, fingerprint, transaction_id, state, table_session_id FROM acceptance_attempts');
    return result.rows.map(row => ({ kind: row.scope_kind, id: row.scope_id, requestId: row.request_id, fingerprint: row.fingerprint, transactionId: row.transaction_id, state: row.state, ...(row.table_session_id ? { tableSessionId: row.table_session_id } : {}) }));
  }
  async find(scope: AttemptScope) { return (await this.attempts()).find(entry => entry.kind === scope.kind && entry.id === scope.id && entry.requestId === scope.requestId); }
  async status(attempt: Attempt): Promise<'committed' | 'noncommit' | 'pending'> {
    if (attempt.state === 'noncommit') return 'noncommit';
    try {
      // A fresh READ COMMITTED primary statement, separate from outcome/aggregate reads.
      const result = await this.journal.query<{ status: string | null }>('SELECT pg_xact_status($1::xid8) AS status', [attempt.transactionId]);
      if (result.rows[0]?.status === 'committed') return 'committed';
      if (result.rows[0]?.status === 'aborted') {
        await this.journal.query("UPDATE acceptance_attempts SET state='noncommit' WHERE scope_kind=$1 AND scope_id=$2 AND request_id=$3", [attempt.kind, attempt.id, attempt.requestId]);
        return 'noncommit';
      }
    } catch { /* NULL, missing evidence and oracle errors never establish noncommit. */ }
    return 'pending';
  }
  async forget(scope: AttemptScope) { await this.journal.query('DELETE FROM acceptance_attempts WHERE scope_kind=$1 AND scope_id=$2 AND request_id=$3', [scope.kind, scope.id, scope.requestId]); }
}
