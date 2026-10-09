import { build } from 'esbuild';
import { copyFile, mkdir } from 'node:fs/promises';
await mkdir('dist', { recursive: true });
await build({
  entryPoints: ['src/main.ts', 'src/db/init.ts'], outdir: 'dist', outbase: 'src',
  bundle: true, platform: 'node', format: 'esm', target: 'node24',
  external: ['fastify', '@fastify/cookie', '@fastify/websocket', 'ws', 'pg', 'drizzle-orm', 'drizzle-orm/*'],
});
await copyFile('src/db/schema.sql', 'dist/schema.sql');
await mkdir('dist/db', { recursive: true });
await copyFile('src/db/schema.sql', 'dist/db/schema.sql');
