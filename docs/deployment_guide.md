# Deploy on Render Free with Neon Free

Deploy the Trainer, API, and WebSockets as one Render **Free Web Service**, with
PostgreSQL on **Neon Free**. The browser uses one HTTPS origin for everything.
No custom domain, second frontend service, Render database, or paid disk is needed.

Provider details checked on **27 October 2026**. This is a hobby/demo deployment:
both providers can sleep or stop service at their free limits.

**Repository preparation is required.** The current server binds to localhost
and does not serve the built frontend. Section 2 contains changes to apply before
deploying; this guide does not itself apply them to the application.

## 1. Accounts, tools, and free limits

You need Git, Node.js 24, pnpm 11.25.0, a GitHub repository containing this code,
and free [Render](https://dashboard.render.com/) and
[Neon](https://console.neon.tech/) accounts. If you already have this checkout,
use it; otherwise clone your repository and open a terminal at its root.

| Resource | Free setup and limits |
| --- | --- |
| Render | Choose the Free compute instance. It sleeps after 15 minutes without inbound HTTP traffic or WebSocket messages; waking takes about a minute. The workspace has 750 free instance hours per month, shared across its free services. Its filesystem is ephemeral. |
| Neon | Choose Free. At the date above, each project includes 100 CU-hours per month and 1 GB of database storage, with compute scaling to zero after five idle minutes. |

Sources: [Render Free](https://render.com/docs/free) and
[Neon pricing](https://neon.com/pricing). Check your dashboards for current quotas,
pipeline minutes, and transfer allowances. Keep both plans free and do not enable
paid add-ons. If a provider requires billing verification, review its current
terms before continuing; this guide does not require upgrading.

Use the default `onrender.com` HTTPS address. Let the services sleep rather than
adding uptime pings. A sleeping server does not run Bot or analysis work. Neon
retains committed data, but startup and database wake-up can both add delay.

## 2. Prepare the repository

### Install the static-file plugin

From the repository root:

```powershell
pnpm install --frozen-lockfile
pnpm --filter @poker/server add @fastify/static@^8
```

Commit the resulting manifest and lockfile changes with the source changes below.
The [plugin compatibility table](https://github.com/fastify/fastify-static#compatibility)
identifies version 8 as compatible with this repo's Fastify 5.

### Keep the plugin external in the server bundle

In [`scripts/build-server.mjs`](../scripts/build-server.mjs), add
`'@fastify/static'` to the existing `external` array. The resulting property is:

```javascript
external: ['fastify', '@fastify/cookie', '@fastify/websocket', '@fastify/static', 'ws', 'pg', 'drizzle-orm', 'drizzle-orm/*'],
```

Keep the rest of the build script, including its SQL asset copies.

### Add hosted startup, frontend serving, and an overlap guard

Replace [`apps/server/src/main.ts`](../apps/server/src/main.ts) with:

```typescript
import { access } from 'node:fs/promises';
import { extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import staticFiles from '@fastify/static';
import { Client } from 'pg';
import { createServer } from './server.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('Set DATABASE_URL to a PostgreSQL database.');

let stopping = false;
let singleton: Client | undefined;

// Acquire before createServer: restoration can resume Bot work.
if (process.env.SINGLE_SERVER_GUARD === 'true') {
  singleton = new Client({
    connectionString: databaseUrl,
    connectionTimeoutMillis: 10000,
    keepAlive: true,
  });
  singleton.on('error', () => {
    console.error('Singleton database connection lost; stopping the server.');
    process.exit(1);
  });
  singleton.on('end', () => {
    if (!stopping) process.exit(1);
  });
  await singleton.connect();
  const result = await singleton.query<{ locked: boolean }>(
    'SELECT pg_try_advisory_lock($1::bigint) AS locked',
    ['706001001'],
  );
  if (!result.rows[0]?.locked) {
    stopping = true;
    await singleton.end();
    throw new Error('Another Poker server owns this database. Stop it first.');
  }
}

const server = await createServer({
  databaseUrl,
  logger: true,
  adminMode: process.env.POKER_ADMIN_MODE !== 'false',
});

// Startup has already initialized the database and recovery gates.
// Do not create identities or run a database query on every health probe.
server.get('/healthz', async () => ({ ok: true }));

if (process.env.SERVE_WEB === 'true') {
  const webRoot = fileURLToPath(new URL('../../web/dist/', import.meta.url));
  await access(new URL('../../web/dist/index.html', import.meta.url));
  await server.register(staticFiles, { root: webRoot, wildcard: false });

  server.setNotFoundHandler((request, reply) => {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    const isPage = (request.method === 'GET' || request.method === 'HEAD')
      && pathname !== '/api'
      && !pathname.startsWith('/api/')
      && pathname !== '/assets'
      && !pathname.startsWith('/assets/')
      && extname(pathname) === '';
    if (isPage) {
      return reply.header('cache-control', 'no-store').sendFile('index.html');
    }
    return reply.code(404).send({ error: 'Not found' });
  });
}

async function shutdown() {
  if (stopping) return;
  stopping = true;
  try {
    await server.close();
    await singleton?.end();
    process.exit(0);
  } catch {
    process.exit(1);
  }
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => { void shutdown(); });
}

await server.listen({
  host: process.env.HOST ?? '127.0.0.1',
  port: Number(process.env.PORT ?? 3001),
});
```

`SERVE_WEB` is opt-in, so normal Vite development remains available. Both source
and compiled entrypoints resolve the frontend to `apps/web/dist`. Missing API
routes and assets return 404 instead of the SPA's HTML.

The guard uses a dedicated **direct** PostgreSQL session and a fixed application
advisory-lock key. Keep the same key in every hosted copy using this database.
[PostgreSQL session locks](https://www.postgresql.org/docs/18/explicit-locking.html#ADVISORY-LOCKS)
last until release or session termination. The process exits if its guard
connection fails or ends unexpectedly.

This refuses ordinary overlapping starts; it is not a distributed failover or
fencing design. Every authoritative process must use the guard. Never run an
unguarded local server against the hosted database. Keep one instance, turn off
previews sharing this database, and use the update procedure in section 7.
This preserves the single-process assumption in
[ADR-0016](adr/0016-separate-semantic-and-durable-authority.md).

### Mark the hosted identity cookie Secure

In [`apps/server/src/server.ts`](../apps/server/src/server.ts), extend the existing
`reply.setCookie('poker_local', ...)` options:

```typescript
reply.setCookie('poker_local', token, {
  httpOnly: true,
  sameSite: 'strict',
  secure: process.env.NODE_ENV === 'production',
  path: '/',
  maxAge: 31536000,
});
```

Keep the cookie host-only: do not add a `domain` option. Render terminates HTTPS
in front of the Node process. This explicit production setting does not require
trusting arbitrary forwarded headers.

### Run local checks

```powershell
pnpm check
```

Use local development/test databases for this check. Do not set `TEST_DATABASE_URL`
to the database holding your hosted tables. Expected build artifacts include
`apps/web/dist/index.html`, `apps/server/dist/main.js`, and the server's compiled
SQL assets. Do not commit `dist`, `.env`, or database credentials.

## 3. Create Neon Free PostgreSQL

1. Sign in to Neon and select **New Project**. Keep the organization on **Free**.
2. Name the project, for example `poker-trainer-preview`.
3. Pick a region near your Render service and players. If both consoles offer
   Singapore, it is a useful choice for players in Singapore; otherwise choose
   nearby regions available on both free plans.
4. Expand the Postgres settings and select **PostgreSQL 18**, matching the local
   major version. Leave unrelated backend services disabled.
5. Create the project. Use its initial branch and database (commonly `neondb`).
6. Open **Connect**, select that branch, database, and its database-owner role.
   **Disable connection pooling** and copy the direct PostgreSQL URL. A pooled
   hostname contains `-pooler`; this guide needs the direct hostname instead.
7. Keep all TLS parameters supplied by Neon, including `sslmode=require` and any
   channel-binding setting. Store the URL privately until the Render setup.

Sources: [create a project](https://neon.com/docs/manage/projects#create-a-project),
[supported PostgreSQL versions](https://neon.com/docs/reference/compatibility#postgres-versions),
and [connection details](https://neon.com/docs/get-started/connect-neon).

This app uses `pg` TCP connections, session `search_path` settings, and the guard's
session advisory lock. Neon's transaction pooler does not preserve those session
features. Use the **same direct primary URL** for application transactions,
recovery, and the guard; do not use an HTTP SQL driver or read replica.
See [Neon pooling limitations](https://neon.com/docs/connect/connection-pooling#connection-pooling-in-transaction-mode).

In Neon's SQL Editor, check the selected branch and run:

```sql
SELECT current_setting('server_version') AS server_version;
SELECT pg_xact_status(pg_current_xact_id()) AS transaction_status;
```

Expect PostgreSQL 18 and `in progress` for the current transaction. This checks
that the recovery primitive is callable; it does not replace the recovery tests.
The application initializes its tables automatically when `createServer` starts.
No manual schema import, migration command, or Render pre-deploy command is needed
for an empty database.

### Verify recovery on a separate Neon test project

Create a second Free PostgreSQL 18 project for integration tests, copy its direct
URL, then run locally in PowerShell:

```powershell
$env:TEST_DATABASE_URL = Read-Host 'Paste the direct URL for the Neon TEST project'
pnpm test apps/server/test/recovery.test.ts
Remove-Item Env:TEST_DATABASE_URL
```

The tests create and drop isolated schemas. A passing SQL Editor query alone
does not prove unknown-COMMIT recovery. Investigate any test failures before
relying on hosted recovery, as required by
[ADR-0027](adr/0027-use-embedded-postgresql-for-local-development-and-tests.md).
Keep the test URL out of the Render service's environment.

## 4. Build and smoke-test the hosted layout locally

Use the preview project's direct URL, not the integration-test URL. Stop any other
server using that preview database. In PowerShell:

```powershell
pnpm build
$env:DATABASE_URL = Read-Host 'Paste the direct URL for the Neon PREVIEW project'
$env:NODE_ENV = 'development'
$env:SERVE_WEB = 'true'
$env:SINGLE_SERVER_GUARD = 'true'
$env:POKER_ADMIN_MODE = 'false'
$env:HOST = '127.0.0.1'
$env:PORT = '3001'
node apps/server/dist/main.js
```

Open `http://127.0.0.1:3001`, create a practice table, and play a Hand. This uses
one server, with no Vite process. `NODE_ENV=development` allows the local HTTP
cookie; Render will use `production` over HTTPS.

Check `/healthz`, refresh a client-side route, and confirm an unknown `/api/...`
or missing `/assets/...` returns 404. In another terminal, starting a second guarded
server with the same database should fail with the ownership error **before**
restoring games. Stop that attempt and the original process with Ctrl+C. Wait for
the original to exit before deploying Render, so it releases the guard.

Use a fresh terminal afterward to avoid retaining these overrides. Commit the
source, manifest, and lockfile changes and push them to your deployment branch.
The repository's source and lockfile must be reachable by the Render GitHub
integration; generated build output stays ignored.

## 5. Create the Render Free Web Service

In Render, choose **New → Web Service**, connect GitHub, and select your repository.
Authorize only the repository access you need. Use these settings:

| Setting | Value |
| --- | --- |
| Service type | **Web Service**, not Static Site |
| Name | For example `poker-trainer-preview` |
| Branch | The branch containing the preparation changes |
| Region | Near the Neon project |
| Runtime | **Node** |
| Root Directory | Leave blank: commands run at repository root |
| Instance Type | **Free** |
| Build Command | `corepack enable && corepack pnpm install --frozen-lockfile --prod=false && corepack pnpm build` |
| Start Command | `node apps/server/dist/main.js` |
| Health Check Path | `/healthz` |
| Auto-Deploy | **Off** |
| Pull Request Previews | **Off** |

The root `packageManager` field pins pnpm 11.25.0. Development dependencies are
needed during the build even though the running app uses production mode. Start
the compiled server directly; `pnpm dev:trainer` and Vite are development tools.

Under environment variables, add:

| Variable | Value |
| --- | --- |
| `NODE_VERSION` | `24.21.0` |
| `NODE_ENV` | `production` |
| `HOST` | `0.0.0.0` |
| `SERVE_WEB` | `true` |
| `SINGLE_SERVER_GUARD` | `true` |
| `POKER_ADMIN_MODE` | `false` |
| `DATABASE_URL` | The **direct primary URL** for the preview Neon project |

Render supplies `PORT`; leave it unset. Do not add `TEST_DATABASE_URL`,
`POKER_POSTGRES_PORT`, or `POKER_API_TARGET`. The Vite proxy is only for development.
Keep `DATABASE_URL` in Render's environment settings, never in a `VITE_` variable,
repository file, screenshot, or browser bundle.

Create the service and watch its build and runtime logs. The first start creates
the database tables and restores recovery state before listening. A healthy
deployment exposes the app at the HTTPS `onrender.com` address shown by Render.

Sources: [web service setup and port binding](https://render.com/docs/web-services),
[Node version selection](https://render.com/docs/node-version), and
[pnpm/Corepack builds](https://render.com/tutorials/when-deploys-go-wrong/build-failures).
Free services do not require a paid pre-deploy command or interactive shell.

## 6. Verify the deployed app

1. Open `https://YOUR-SERVICE.onrender.com/healthz`; expect `{"ok":true}`.
2. Open the app, start practice, and confirm human actions and Bot responses work.
3. In browser developer tools, confirm `/api/live` upgrades to a **101 WebSocket**
   connection using `wss://` on the same hostname. No second backend URL is needed.
4. Confirm the `poker_local` cookie is HttpOnly, Secure, and SameSite=Strict.
5. Reload in the same browser and confirm the selected Table Session restores.
   A fresh browser profile establishes a separate identity and cannot access it.
6. Refresh a client-side route and check missing API/asset paths still return 404.
7. Close the browser, let the free service sleep, then return using the same
   profile. Allow for wake-up, reconnect, and restoration. Confirm the last
   committed table state survives; no local Render disk is used for persistence.

Render supports [WebSockets](https://render.com/docs/websocket) through the same
web service. Keep Admin Mode off for the hosted preview unless you deliberately
need completed-Hand inspection. This remains the current cookie-owned Trainer;
hosting it does not implement accounts or the planned shared multiplayer flow.

## 7. Updates and restarts

Render's default [rolling deploy sequence](https://render.com/docs/deploys#zero-downtime-deploys)
starts a replacement before stopping the old instance. Even **Restart service**
uses that sequence. With the guard enabled, a replacement should refuse startup
while the original owns the database; that is preferable to two game authorities.
Do not remove the guard to make such a deployment pass.

For this initial free preview, use a stop-before-start replacement when updating:

1. Finish testing the new commit locally and push it. Keep auto-deploy off.
2. In Render, **Suspend** the existing service and wait until its process has
   stopped. See [suspend/resume controls](https://render.com/changelog/suspend-and-resume-services-in-bulk-from-the-render-dashboard).
3. Create a replacement **Free Web Service** from the new commit using section 5's
   settings and the same Neon URL. Keep the old service suspended throughout.
4. Verify the replacement, then delete the old suspended Render service. Leave
   Neon intact. Only one authoritative service may run against it at a time.

This deliberately accepts downtime. A new service can have a different hostname;
the host-only identity cookie does not transfer. Existing tables remain in Neon,
but a new hostname/browser identity cannot claim them. Treat this preview as
disposable test data. Do not promise continuity across replacement URLs; a stable
origin and a validated same-service release/handoff mechanism are follow-up work.

For a restart of the **same build**, suspend, wait for shutdown, then resume the
same service. Verify its deployed commit and environment afterward. Platform
maintenance can also replace instances: a guarded replacement may fail to start
while the old owner remains. Resolve through stop-before-start recovery rather
than allowing concurrent writers. This recipe does not promise unattended
zero-downtime updates.

## 8. Troubleshooting and staying free

| Symptom | Check |
| --- | --- |
| No open port / 502 | `HOST=0.0.0.0`, Render's supplied `PORT`, the root directory, and the compiled start command. |
| `pnpm` / Corepack build failure | Node 24 is selected; enable Corepack as in the build command. Confirm `pnpm-lock.yaml` and the matching manifest are committed. |
| `@fastify/static` module error | The dependency and lockfile are committed, and the build script keeps the plugin external. |
| Missing `index.html` | Build the whole workspace; check `apps/web/dist/index.html`. Keep Render's Root Directory blank. |
| `Another Poker server owns this database` | Stop your local smoke-test server, another service, or the old deployment. Wait for its direct database session to close. Do not change the lock key. |
| Guard connection lost / server exits | Check Neon availability and quotas, then restart through the stop-before-start procedure. The guarded process intentionally stops on lost ownership. |
| Database connection or schema errors | Use the direct primary URL, preserve TLS settings, and confirm the selected branch/database/role. Never disable TLS verification as a workaround. |
| Creation stays unresolved | Follow the explicit same-request outcome check. Do not clear recovery rows, reset the database, or automatically resubmit with new IDs. See [server recovery](server-protocol.md#unknown-commit-resolution). |
| Slow first load | Render and/or Neon may be waking. Consult provider logs if the service does not recover. |
| Previously saved tables disappear from the list | Check the browser profile, cookie, hostname, and Neon branch. Ownership follows the cookie; it does not follow a browser-storage table ID. |
| Service suspended / quota reached | Inspect Render usage and Neon compute/storage. Stay on Free and wait for renewable quotas or remove unneeded test resources; do not upgrade unintentionally. |

Review usage after testing. A continuously active connection or guard lock may
keep database compute awake; do not assume scale-to-zero will always save quota.
100 CU-hours is not unlimited uptime: at 0.25 CU it corresponds to about 400 active
hours, before other usage. Let Render sleep, close test browsers and local
processes, and suspend the preview when it is unused. Do not connect external
uptime monitors that repeatedly wake the app.

Free quotas and database history retention are limited. Keep only test data for
now: [ADR-0014](adr/0014-allow-pre-release-record-breaking-changes.md) still permits
record-breaking changes before release. Never delete the Neon project to fix a
Render build problem. To take the preview down, suspend/delete the Render service;
retain Neon if you want its data, and delete Neon only when that data is no longer
needed.

## Verification status

This guide records the required preparation and provider settings. It is not
evidence of a completed cloud deployment. Before considering the setup verified,
apply section 2, pass local checks and the separate Neon recovery tests, and
complete the hosted smoke checks in section 6, including overlap refusal and
sleep/wake behavior.
