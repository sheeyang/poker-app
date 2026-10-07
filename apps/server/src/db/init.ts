import { openDatabase, initializeDatabase } from './database.js';
const url = process.env.DATABASE_URL;
if (!url) throw new Error('Set DATABASE_URL before initializing PostgreSQL.');
const { pool } = openDatabase(url);
try { await initializeDatabase(pool); console.log('Database initialized.'); } finally { await pool.end(); }
