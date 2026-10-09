import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from './schema.js';
export function openDatabase(databaseUrl: string, namespace = 'public') {
  if (!/^[a-z][a-z0-9_]*$/.test(namespace)) throw new Error('Invalid database schema name.');
  const pool = new Pool({ connectionString: databaseUrl, options: '-c search_path=' + namespace });
  return { pool, db: drizzle({ client: pool, schema }) };
}
export async function initializeDatabase(pool: Pool) {
  const migration = await readFile(new URL('./schema.sql', import.meta.url), 'utf8');
  await pool.query(migration);
}
