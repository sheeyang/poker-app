import { setTimeout as delay } from 'node:timers/promises';
import { Client } from 'pg';

/** One direct session owns hosted authority until all application work stops. */
export class ServerAuthority {
  private readonly client: Client;
  private closing = false;
  private lost = false;
  constructor(databaseUrl: string, private readonly namespace: string, onLost: (error: Error) => void) {
    if (new URL(databaseUrl).hostname.includes('-pooler.')) throw new Error('Hosted authority requires a direct PostgreSQL URL, not the Neon pooler.');
    this.client = new Client({ connectionString: databaseUrl, application_name: 'poker-app-authority:' + namespace, connectionTimeoutMillis: 10000, query_timeout: 10000, keepAlive: true });
    const fail = () => {
      if (this.closing || this.lost) return;
      this.lost = true;
      onLost(new Error('Server authority connection was lost.'));
    };
    this.client.on('error', fail);
    this.client.on('end', fail);
  }
  async acquire(signal: AbortSignal) {
    signal.throwIfAborted();
    await this.client.connect();
    while (!signal.aborted && !this.closing && !this.lost) {
      const result = await this.client.query<{ locked: boolean }>(
        "SELECT pg_try_advisory_lock(hashtext('poker-app-server'), hashtext($1)) AS locked", [this.namespace],
      );
      if (result.rows[0]?.locked) { signal.throwIfAborted(); return; }
      await delay(250, undefined, { signal });
    }
    throw new Error('Server authority acquisition stopped.');
  }
  async close() { this.closing = true; await this.client.end(); }
}
