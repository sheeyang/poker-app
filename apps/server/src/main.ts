import { createServer } from './server.js';
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('Set DATABASE_URL to a PostgreSQL database.');
const server = await createServer({ databaseUrl, logger: true, adminMode: process.env.POKER_ADMIN_MODE !== 'false' });
await server.listen({ host: '127.0.0.1', port: Number(process.env.PORT ?? 3001) });
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, async () => { await server.close(); process.exit(0); });
