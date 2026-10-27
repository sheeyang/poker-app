import { afterAll, afterEach, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, Pool } from 'pg';
import WebSocket from 'ws';
import { startHostedServer, type HostedServerOptions } from '../src/hosting.js';

const databaseUrl = process.env.TEST_DATABASE_URL!;
const administration = new Pool({ connectionString: databaseUrl });
const hosts: ReturnType<typeof startHostedServer>[] = [];
const schemas: string[] = [];
const directories: string[] = [];
const clients: Client[] = [];
async function schema() {
  const name = 'hosting_' + randomUUID().replaceAll('-', '');
  await administration.query('CREATE SCHEMA "' + name + '"'); schemas.push(name); return name;
}
function start(namespace: string, revision: string, webRoot?: string, overrides: Partial<HostedServerOptions> = {}) {
  const host = startHostedServer({ databaseUrl, schema: namespace, host: '127.0.0.1', port: 0,
    automaticBots: false, secureCookies: true, singleAuthority: true, revision, webRoot, ...overrides });
  hosts.push(host); return host;
}
afterEach(async () => {
  await Promise.allSettled(hosts.splice(0).map(host => host.close()));
  await Promise.allSettled(clients.splice(0).map(client => client.end()));
  for (const namespace of schemas.splice(0)) await administration.query('DROP SCHEMA "' + namespace + '" CASCADE');
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});
afterAll(async () => { await administration.end(); });

test('rolling replacement gates APIs until shutdown, then restores the same cookie-owned committed table', async () => {
  const namespace = await schema();
  const first = start(namespace, 'first'); const original = await first.listening; await first.ready;
  const identity = await fetch(original + '/api/identity');
  expect(identity.headers.get('set-cookie')).toMatch(/; Secure;/);
  const cookie = identity.headers.get('set-cookie')!.split(';')[0]!;
  const created = await (await fetch(original + '/api/table-sessions', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ requestId: randomUUID() }) })).json();
  const seated = await fetch(original + '/api/table-sessions/' + created.tableSessionId + '/seat-participant', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ requestId: randomUUID(), expectedPokerRevision: 0, participantId: created.bindings[0].participantId, seat: 1 }),
  });
  expect(seated.status).toBe(200);
  const socket = new WebSocket(original.replace('http:', 'ws:') + '/api/live', { headers: { cookie } });
  await once(socket, 'open');
  const replacement = start(namespace, 'second'); const next = await replacement.listening;
  expect((await fetch(next + '/healthz')).status).toBe(200);
  expect((await fetch(next + '/readyz')).status).toBe(503);
  expect((await fetch(next + '/api/identity')).status).toBe(503);
  expect((await fetch(next + '/api/table-sessions', { headers: { cookie } })).status).toBe(503);
  expect((await fetch(original + '/readyz')).status).toBe(200);
  const closed = once(socket, 'close');
  await first.close(); await closed; await replacement.ready;
  expect(await (await fetch(next + '/readyz')).json()).toEqual({ ok: true, revision: 'second', status: 'ready' });
  const restored = await fetch(next + '/api/table-sessions/' + created.tableSessionId, { headers: { cookie } });
  expect(restored.status).toBe(200);
  expect((await restored.json()).pokerRevision).toBe(1);
});

test('a standby listener performs no database initialization before owning authority and can be stopped', async () => {
  const namespace = await schema();
  const blocker = new Client({ connectionString: databaseUrl }); clients.push(blocker); await blocker.connect();
  await blocker.query("SELECT pg_advisory_lock(hashtext('poker-app-server'), hashtext($1))", [namespace]);
  const standby = start(namespace, 'waiting'); const base = await standby.listening;
  expect((await fetch(base + '/healthz')).status).toBe(200);
  expect((await fetch(base + '/readyz')).status).toBe(503);
  expect((await administration.query('SELECT to_regclass($1) AS relation', [namespace + '.local_users'])).rows[0].relation).toBeNull();
  await standby.close();
  await expect(standby.ready).rejects.toBeDefined();
  await blocker.query("SELECT pg_advisory_unlock(hashtext('poker-app-server'), hashtext($1))", [namespace]);
  const active = start(namespace, 'active'); await active.listening; await active.ready;
});

test('losing the authority connection stops the old listener and permits restoration by a replacement', async () => {
  const namespace = await schema();
  const first = start(namespace, 'first'); const original = await first.listening; await first.ready;
  const replacement = start(namespace, 'second'); await replacement.listening;
  const row = await administration.query<{ pid: number }>('SELECT pid FROM pg_stat_activity WHERE application_name=$1', ['poker-app-authority:' + namespace]);
  const lock = await administration.query<{ pid: number }>("SELECT pid FROM pg_locks WHERE locktype='advisory' AND granted AND pid=ANY($1::integer[])", [row.rows.map(entry => entry.pid)]);
  expect(lock.rows).toHaveLength(1);
  await administration.query('SELECT pg_terminate_backend($1)', [lock.rows[0]!.pid]);
  await expect(first.failure).rejects.toThrow('authority connection was lost');
  await first.close(); await replacement.ready;
  await expect(fetch(original + '/api/identity')).rejects.toBeDefined();
});

test('built frontend and SPA routes are served while missing APIs and assets retain 404 responses', async () => {
  const namespace = await schema();
  const directory = await mkdtemp(join(tmpdir(), 'poker-hosting-web-')); directories.push(directory);
  await mkdir(join(directory, 'assets'));
  await writeFile(join(directory, 'index.html'), '<html><script type="module" src="/assets/app.js"></script></html>');
  await writeFile(join(directory, 'assets/app.js'), 'console.log("trainer");');
  const host = start(namespace, 'static', directory); const base = await host.listening; await host.ready;
  expect((await fetch(base)).headers.get('content-type')).toContain('text/html');
  expect((await fetch(base + '/tables/saved')).status).toBe(200);
  expect((await fetch(base + '/assets/app.js')).headers.get('content-type')).toContain('javascript');
  expect((await fetch(base + '/assets/missing.js')).status).toBe(404);
  expect((await fetch(base + '/assets/missing')).status).toBe(404);
  expect((await fetch(base + '/api/missing')).status).toBe(404);
});

test('authority loss with an in-flight pre-COMMIT mutation rolls back before the replacement accepts new work', async () => {
  const namespace = await schema();
  const held = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
  const first = start(namespace, 'first', undefined, { mutationTransactionFaults: { beforeCommit: async () => { held.resolve(); await release.promise; } } });
  const original = await first.listening; await first.ready;
  const identity = await fetch(original + '/api/identity'); const cookie = identity.headers.get('set-cookie')!.split(';')[0]!;
  const created = await (await fetch(original + '/api/table-sessions', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ requestId: randomUUID() }) })).json();
  const contents = { expectedPokerRevision: 0, participantId: created.bindings[0].participantId, seat: 1 };
  const pending = fetch(original + '/api/table-sessions/' + created.tableSessionId + '/seat-participant', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ ...contents, requestId: randomUUID() }),
  }).catch(() => undefined);
  await held.promise;
  const replacement = start(namespace, 'second'); const next = await replacement.listening;
  const lock = await administration.query<{ pid: number }>("SELECT a.pid FROM pg_stat_activity a JOIN pg_locks l ON l.pid=a.pid WHERE a.application_name=$1 AND l.locktype='advisory' AND l.granted", ['poker-app-authority:' + namespace]);
  await administration.query('SELECT pg_terminate_backend($1)', [lock.rows[0]!.pid]);
  try {
    await expect(first.failure).rejects.toThrow('authority connection was lost');
    // Deliberately do not await first.close(): exercise takeover during its drain.
    await replacement.ready;
    const view = await (await fetch(next + '/api/table-sessions/' + created.tableSessionId, { headers: { cookie } })).json();
    expect(view.pokerRevision).toBe(0);
    const accepted = await fetch(next + '/api/table-sessions/' + created.tableSessionId + '/seat-participant', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ ...contents, requestId: randomUUID() }),
    });
    expect(accepted.status).toBe(200);
    expect((await accepted.json()).pokerRevision).toBe(1);
  } finally { release.resolve(); await pending; }
});
