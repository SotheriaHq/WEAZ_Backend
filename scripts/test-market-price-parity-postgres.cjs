// All fixture writes use a newly created loopback-only database.
const fs = require('node:fs'),
  path = require('node:path'),
  assert = require('node:assert/strict'),
  { randomUUID } = require('node:crypto');
const work = path.resolve(__dirname, '..');
const { Client } = require(path.join(work, 'node_modules/pg')),
  dotenv = require(path.join(work, 'node_modules/dotenv'));
const { Prisma, PrismaClient } = require(
    path.join(work, 'node_modules/@prisma/client'),
  ),
  { PrismaPg } = require(path.join(work, 'node_modules/@prisma/adapter-pg'));
require(path.join(work, 'node_modules/ts-node')).register({
  transpileOnly: true,
});
const { resolveProductPrice } = require(
  path.join(work, 'src/common/pricing/product-price'),
);
const { productEffectivePriceSql } = require(
  path.join(work, 'src/common/pricing/product-price.sql'),
);
const source = new URL(
  (dotenv.config({ quiet: true }), process.env.DATABASE_URL) || '',
);
if (!['localhost', '127.0.0.1', '[::1]'].includes(source.hostname))
  throw Error('Loopback only');
const name = 'wiez_market_price_parity_' + randomUUID().replaceAll('-', '');
if (!/^wiez_market_price_parity_[a-f0-9]{32}$/.test(name))
  throw Error('Invalid database');
const au = new URL(source);
au.pathname = '/postgres';
const tu = new URL(source);
tu.pathname = '/' + name;
const start = new Date('2026-11-15T12:00:00.000Z'),
  end = new Date('2026-11-15T13:00:00.000Z');
const cases = [];
for (const time of [
  start.getTime() - 1,
  start.getTime(),
  end.getTime(),
  end.getTime() + 1,
])
  cases.push({
    price: '99999999.99',
    salePrice: '99999999.98',
    saleStartAt: start,
    saleEndAt: end,
    now: new Date(time),
  });
for (const salePrice of [null, '0', '-1', '100', '101', 'NaN', '90'])
  cases.push({ price: '100', salePrice, now: start });
for (const price of ['0', '-0.00', '-1', 'NaN'])
  cases.push({ price, salePrice: '0', now: start });
for (const [field, value] of [
  ['saleStartAt', '-infinity'],
  ['saleEndAt', 'infinity'],
])
  cases.push({ price: '100', salePrice: '90', [field]: value, now: start });
cases.push({
  price: '100',
  salePrice: '90',
  saleStartAt: end,
  saleEndAt: start,
  now: start,
});
(async () => {
  const admin = new Client({ connectionString: au.toString() });
  await admin.connect();
  let created = false,
    db,
    prisma;
  try {
    await admin.query('CREATE DATABASE "' + name + '"');
    created = true;
    db = new Client({ connectionString: tu.toString() });
    await db.connect();
    await db.query(
      'CREATE TABLE prices (id integer PRIMARY KEY,price numeric(10,2) NOT NULL,"salePrice" numeric(10,2),"saleStartAt" timestamp(3),"saleEndAt" timestamp(3))',
    );
    const migration = fs.readFileSync(
      path.join(
        work,
        'prisma/migrations/20261115090100_product_effective_price/migration.sql',
      ),
      'utf8',
    );
    await db.query(
      migration.match(
        /CREATE FUNCTION wiez_product_effective_price\([\s\S]*?\$\$;/,
      )[0],
    );
    for (let i = 0; i < cases.length; i++) {
      const c = cases[i];
      await db.query(
        "INSERT INTO prices VALUES ($1,$2,$3,$4::timestamptz AT TIME ZONE 'UTC',$5::timestamptz AT TIME ZONE 'UTC')",
        [
          i,
          c.price,
          c.salePrice,
          c.saleStartAt instanceof Date
            ? c.saleStartAt.toISOString()
            : (c.saleStartAt ?? null),
          c.saleEndAt instanceof Date
            ? c.saleEndAt.toISOString()
            : (c.saleEndAt ?? null),
        ],
      );
    }
    prisma = new PrismaClient({
      adapter: new PrismaPg({ connectionString: tu.toString() }),
    });
    for (const zone of ['UTC', 'Africa/Lagos', 'America/New_York']) {
      await prisma.$transaction(async (tx) => {
        await tx.$queryRaw(
          Prisma.sql(["SELECT set_config('TimeZone',", ',true)'], zone),
        );
        for (let i = 0; i < cases.length; i++) {
          const c = cases[i];
          const expression = productEffectivePriceSql(c.now);
          const [row] = await tx.$queryRaw(
            Prisma.sql(
              [
                'SELECT ',
                ' AS effective, wiez_product_effective_price(p.price,p."salePrice",p."saleStartAt",p."saleEndAt",',
                '::timestamptz) AS persisted FROM prices p WHERE p.id=',
                '',
              ],
              expression,
              c.now.toISOString(),
              i,
            ),
          );
          const expected =
            resolveProductPrice(c, c.now)?.effectivePrice.toFixed(2) ?? null;
          assert.equal(
            row.effective === null
              ? null
              : new Prisma.Decimal(row.effective).toFixed(2),
            expected,
            zone + ' case ' + i,
          );
          assert.equal(
            row.persisted === null
              ? null
              : new Prisma.Decimal(row.persisted).toFixed(2),
            expected,
            zone + ' persisted function case ' + i,
          );
        }
      });
      console.log(
        'PASS ' +
          zone +
          ': ' +
          cases.length +
          ' actual Prisma SQL/TS price cases',
      );
    }
  } finally {
    if (prisma) await prisma.$disconnect();
    if (db) await db.end();
    if (created) await admin.query('DROP DATABASE "' + name + '"');
    await admin.end();
    console.log('Disposable price-parity database removed');
  }
})().catch((e) => {
  console.error(
    e.code === 'ERR_ASSERTION' ? e.message : e.code || 'Probe failed',
  );
  process.exitCode = 1;
});
