require('dotenv').config({ quiet: true });
process.env.TS_NODE_TRANSPILE_ONLY = 'true';
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');
const { Client } = require('pg');
const { randomUUID } = require('crypto');
const assert = require('assert/strict');
const {
  BrandCustomersService,
} = require('../src/brands/brand-customers.service');
const url = new URL(process.env.DATABASE_URL);
if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
  throw new Error('Local PostgreSQL required');
const client = new Client({ connectionString: url.toString() });
async function main() {
  await client.connect();
  await client.query('BEGIN');
  // Session-local tables shadow the real tables; rollback leaves the application untouched.
  await client.query(`CREATE TEMP TABLE "User" ("_id" uuid,username text,type text,status text);
    CREATE TEMP TABLE "UserProfile" ("userId" uuid,"firstName" text,"lastName" text);
    CREATE TEMP TABLE "Order" ("brandId" uuid,"buyerId" uuid,"createdAt" timestamp,"paymentStatus" text,status text);
    CREATE TEMP TABLE "CustomOrder" ("brandId" uuid,"buyerId" uuid,"createdAt" timestamp,"paymentStatus" text,status text,"cancelledAt" timestamp,"anonymizedAt" timestamp);`);
  const brand = randomUUID(),
    otherBrand = randomUUID(),
    a = randomUUID(),
    b = randomUUID(),
    c = randomUUID();
  for (const [id, username, status] of [
    [a, 'shopper-a', 'ACTIVE'],
    [b, 'shopper-b', 'ACTIVE'],
    [c, 'shopper-c', 'SUSPENDED'],
  ])
    await client.query('INSERT INTO "User" VALUES ($1,$2,\'REGULAR\',$3)', [
      id,
      username,
      status,
    ]);
  await client.query(
    "INSERT INTO \"UserProfile\" VALUES ($1,'Ada','Shopper')",
    [a],
  );
  for (const [buyer, paid, status, owner] of [
    [a, 'PAID', 'PROCESSING', brand],
    [a, 'PAID', 'RETURNED', brand],
    [a, 'PAID', 'CANCELLED', brand],
    [a, 'REFUNDED', 'DELIVERED', brand],
    [null, 'PAID', 'DELIVERED', brand],
    [c, 'PAID', 'DELIVERED', brand],
    [a, 'PAID', 'DELIVERED', otherBrand],
  ])
    await client.query('INSERT INTO "Order" VALUES ($1,$2,NOW(),$3,$4)', [
      owner,
      buyer,
      paid,
      status,
    ]);
  await client.query(
    `INSERT INTO "CustomOrder" VALUES ($1,$2,NOW(),'PAID','COMPLETED',NULL,NULL),($1,$2,NOW(),'PAID','QUEUED',NOW(),NULL),($1,$3,NOW(),'PAID','REFUND_IN_PROGRESS',NULL,NULL)`,
    [brand, a, b],
  );
  let threshold = 3;
  const service = new BrandCustomersService(
    {
      $queryRaw: (query) =>
        client.query(query.text, query.values).then((result) => result.rows),
    },
    { resolveBrandContext: async () => ({ brandId: brand }) },
    { assertPermission: async () => {} },
    { get: async () => ({ effectiveMinimumOrders: threshold }) },
  );
  const paid = await service.list('owner', brand, { page: 1, limit: 25 });
  assert.equal(paid.total, 1);
  assert.equal(paid.items[0].id, a);
  assert.equal(paid.items[0].orderCount, 3);
  assert.equal(paid.items[0].name, 'Ada Shopper');
  threshold = 1;
  const free = await service.list('owner', brand, { page: 1, limit: 25 });
  assert.equal(free.total, 3);
  assert.equal(free.items.find((item) => item.id === c).name, 'Shopper');
  assert.equal(free.items.find((item) => item.id === c).username, null);
  const second = await service.list('owner', brand, { page: 2, limit: 2 });
  assert.equal(second.items.length, 1);
  assert.equal(second.total, 3);
  assert.equal(
    (await service.list('owner', brand, { page: 1, limit: 25, search: '%' }))
      .total,
    0,
  );
  assert.equal(
    (await service.list('owner', brand, { page: 1, limit: 25, search: 'ada' }))
      .total,
    1,
  );
  console.log(
    'Customer SQL passed: standard/custom union, 3+ threshold, free visibility, cancellations/refunds, pending refunds, returns, guest orders, brand isolation, private inactive identity, pagination and literal search.',
  );
}
main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await client.query('ROLLBACK').catch(() => {});
    await client.end();
  });
