// Read-only schema preflight. Never log database URLs or application records.
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');
require('dotenv').config({ quiet: true });

async function main() {
  if (!process.env.DATABASE_URL) throw Error('Database configuration required');
  const connection = new Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 10000, statement_timeout: 10000 });
  try {
    await connection.connect();
    await connection.query('BEGIN READ ONLY');
    const exists = await connection.query("SELECT to_regclass('public._prisma_migrations') AS name");
    const rows = exists.rows[0].name ? (await connection.query('SELECT migration_name, finished_at, rolled_back_at FROM "_prisma_migrations"')).rows : [];
    if (rows.some(row => !row.finished_at && !row.rolled_back_at)) throw Error('Unresolved migration');
    const applied = new Set(rows.filter(row => row.finished_at && !row.rolled_back_at).map(row => row.migration_name));
    const pending = fs.readdirSync(path.resolve(__dirname, '../prisma/migrations'), { withFileTypes: true }).filter(row => row.isDirectory() && !applied.has(row.name));
    await connection.query('ROLLBACK');
    console.log(pending.length);
  } finally { await connection.end(); }
}
main().catch(() => { console.error('Cannot verify schema migration safety; deployment stopped.'); process.exitCode = 1; });
