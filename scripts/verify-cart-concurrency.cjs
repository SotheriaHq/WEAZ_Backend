require('dotenv').config({ quiet: true });
require('ts-node/register/transpile-only');
const { Client, Pool } = require('pg');
const { Prisma } = require('@prisma/client');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const { withCartTransaction, consumePaidCartLines } = require('../src/bagging/cart-transaction.util');
const source = new URL(process.env.DATABASE_URL);
if (!['localhost', '127.0.0.1', '[::1]'].includes(source.hostname)) throw new Error('Local PostgreSQL required');
const name = 'wiez_cart_race_' + Date.now();
const adminUrl = new URL(source); adminUrl.pathname = '/postgres';
const testUrl = new URL(source); testUrl.pathname = '/' + name;
const admin = new Client({ connectionString: adminUrl.toString() });
let pool;
function adapter(connection) {
  const query = async (sql, ...values) => {
    const statement = Array.isArray(sql) ? Prisma.sql(sql, ...values) : sql;
    return connection.query(statement.text, statement.values);
  };
  return { $queryRaw: async (...args) => (await query(...args)).rows, $executeRaw: async (...args) => (await query(...args)).rowCount };
}
async function main() {
  await admin.connect();
  await admin.query(`CREATE DATABASE "${name}"`);
  pool = new Pool({ connectionString: testUrl.toString(), max: 10 });
  await pool.query(`CREATE TABLE "CartItem" ("_id" uuid PRIMARY KEY, "userId" uuid NOT NULL, "productId" uuid NOT NULL, quantity int NOT NULL, "selectedSize" text, "selectedColor" text, "updatedAt" timestamp(3) DEFAULT NOW())`);
  await pool.query(`CREATE UNIQUE INDEX "CartItem_userId_productId_selectedSize_selectedColor_key" ON "CartItem" ("userId","productId","selectedSize","selectedColor")`);
  await pool.query(fs.readFileSync('prisma/migrations/20261021125000_cart_selection_integrity/migration.sql', 'utf8'));
  const prisma = { $transaction: async (operation) => {
    const connection = await pool.connect();
    try {
      await connection.query('BEGIN');
      await connection.query("SET LOCAL lock_timeout='3s'");
      const result = await operation(adapter(connection));
      await connection.query('COMMIT'); return result;
    } catch (error) { await connection.query('ROLLBACK'); throw error; }
    finally { connection.release(); }
  } };
  const buyer = randomUUID(), other = randomUUID(), product = randomUUID();
  const started = performance.now();
  await Promise.all(Array.from({ length: 20 }, () => withCartTransaction(prisma, buyer, async (tx) => {
    const rows = await tx.$queryRaw`SELECT "_id", quantity FROM "CartItem" WHERE "userId"=${buyer}::uuid AND "productId"=${product}::uuid AND "selectedSize" IS NULL AND "selectedColor" IS NULL`;
    if (rows.length) await tx.$executeRaw`UPDATE "CartItem" SET quantity=${rows[0].quantity + 1} WHERE "_id"=${rows[0]._id}::uuid`;
    else await tx.$executeRaw`INSERT INTO "CartItem" ("_id","userId","productId",quantity) VALUES (${randomUUID()}::uuid,${buyer}::uuid,${product}::uuid,1)`;
  })));
  const items = (await pool.query('SELECT * FROM "CartItem"')).rows;
  assert.equal(items.length, 1); assert.equal(items[0].quantity, 20);
  const cartItemId = items[0]._id;
  await prisma.$transaction((tx) => consumePaidCartLines(tx, buyer, [{ cartItemId, quantity: 2 }, { cartItemId, quantity: 3 }]));
  assert.equal((await pool.query('SELECT quantity FROM "CartItem"')).rows[0].quantity, 15);
  await prisma.$transaction((tx) => consumePaidCartLines(tx, other, [{ cartItemId, quantity: 15 }]));
  assert.equal((await pool.query('SELECT quantity FROM "CartItem"')).rows[0].quantity, 15);
  await prisma.$transaction((tx) => consumePaidCartLines(tx, buyer, [{ cartItemId, quantity: 15 }]));
  assert.equal((await pool.query('SELECT COUNT(*)::int count FROM "CartItem"')).rows[0].count, 0);
  const current = await pool.query('SELECT version()');
  const report = { generatedAt: new Date().toISOString(), scope: 'isolated local PostgreSQL, actual cart transaction/consumption helpers', logicalConcurrentAdds: 20, connectionLimit: 10, finalQuantity: 20, duplicateRows: 0, passed: ['no lost increments', 'NULL-safe selection identity', 'paid snapshot subtraction retains later additions', 'combined duplicate paid lines', 'cross-buyer isolation', 'exact consumption removes row'], elapsedMs: Math.round(performance.now()-started), databaseVersion: current.rows[0].version.split(' on ')[0] };
  fs.mkdirSync('docs/performance', { recursive: true });
  fs.writeFileSync('docs/performance/cart-concurrency-local-2026-10-21.json', JSON.stringify(report, null, 2)+'\n');
  console.log(JSON.stringify(report));
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; }).finally(async () => {
  if (pool) await pool.end();
  if (admin._connected && /^wiez_cart_race_\d+$/.test(name)) await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  await admin.end();
});
