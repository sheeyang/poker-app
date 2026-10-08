/** Isolated real server/PostgreSQL fixture with task-owned lifecycle control. */
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { Pool } from 'pg';
import { createServer } from '../../src/server.js';
const databaseUrl = process.env.TEST_DATABASE_URL!;
const schema = 'browser_inspection_' + randomUUID().replaceAll('-', '');
const administration = new Pool({ connectionString: databaseUrl });
await administration.query('CREATE SCHEMA "' + schema + '"');
let server = await createServer({ databaseUrl, schema });
await server.listen({ host: '127.0.0.1', port: 3014 });
const control = http.createServer(async (request, response) => {
  const url = new URL(request.url!, 'http://localhost');
  if (url.pathname === '/restart') {
    await server.close();
    server = await createServer({ databaseUrl, schema, adminMode: url.searchParams.get('admin') !== 'false' });
    await server.listen({ host: '127.0.0.1', port: 3014 });
    response.end('Restarted');
  } else if (url.pathname === '/stop') {
    await server.close();
    await administration.query('DROP SCHEMA "' + schema + '" CASCADE');
    await administration.end();
    response.end('Stopped ' + schema);
    control.close();
  } else response.writeHead(404).end();
});
control.listen(3016, '127.0.0.1');
console.log('Inspection browser fixture 3014/control 3016, schema ' + schema);
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, async () => { await server.close(); await administration.query('DROP SCHEMA "' + schema + '" CASCADE'); await administration.end(); control.close(); });
