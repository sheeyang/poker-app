import { fileURLToPath } from 'node:url';
import { startHostedServer } from './hosting.js';
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('Set DATABASE_URL to a PostgreSQL database.');
const production = process.env.NODE_ENV === 'production';
const server = startHostedServer({
  databaseUrl, logger: true, secureCookies: production,
  adminMode: process.env.POKER_ADMIN_MODE !== 'false',
  host: process.env.HOST ?? '127.0.0.1', port: Number(process.env.PORT ?? 3001),
  revision: process.env.RENDER_GIT_COMMIT ?? process.env.DEPLOYMENT_REVISION ?? 'local',
  singleAuthority: production || process.env.SINGLE_SERVER_GUARD === 'true',
  ...(process.env.SERVE_WEB === 'true' ? { webRoot: fileURLToPath(new URL('../../web/dist/', import.meta.url)) } : {}),
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, async () => {
  try { await server.close(); process.exit(0); } catch { process.exit(1); }
});
try { await server.ready; await server.failure; }
catch (error) { console.error(error); process.exit(1); }
