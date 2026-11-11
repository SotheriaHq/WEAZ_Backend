const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { Client } = require('pg');

module.exports = async ({ record }) => {
  const url = new URL(process.env.DATABASE_URL);
  assert(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname));
  assert(/^\/wiez_adaptive_test_[a-f0-9]{32}$/.test(url.pathname));
  const schema = `wiez_session_test_${randomUUID().replaceAll('-', '')}`;
  assert(/^wiez_session_test_[a-f0-9]{32}$/.test(schema));
  const client = new Client({ connectionString: url.toString() }); await client.connect(); let created = false;
  try {
    assert.equal((await client.query('SELECT current_database() AS name')).rows[0].name, url.pathname.slice(1));
    await client.query(`CREATE SCHEMA "${schema}"`); created = true;
    await client.query(`SET search_path TO "${schema}"`);
    await client.query('CREATE TABLE "RefreshToken" (id INTEGER PRIMARY KEY)');
    await client.query('INSERT INTO "RefreshToken" (id) VALUES (1)');
    const sql = fs.readFileSync(path.join(__dirname, '../prisma/migrations/20261102220000_bind_session_authority_revision/migration.sql'), 'utf8');
    await client.query(sql);
    assert.equal((await client.query('SELECT "issuedAuthVersion" FROM "RefreshToken" WHERE id=1')).rows[0].issuedAuthVersion, -1);
    await client.query('INSERT INTO "RefreshToken" (id,"issuedAuthVersion") VALUES (2,7)');
    assert.equal((await client.query('SELECT "issuedAuthVersion" FROM "RefreshToken" WHERE id=2')).rows[0].issuedAuthVersion, 7);
    await assert.rejects(client.query('INSERT INTO "RefreshToken" (id,"issuedAuthVersion") VALUES (3,-2)'), error => error.code === '23514');
    record('session-authority migration leaves pre-existing rows unbound, preserves explicit new revisions and rejects invalid negative revisions without guessing history');
  } finally {
    await client.query('ROLLBACK'); await client.query('SET search_path TO public');
    if (created) await client.query(`DROP SCHEMA "${schema}" CASCADE`);
    await client.end();
  }
};
