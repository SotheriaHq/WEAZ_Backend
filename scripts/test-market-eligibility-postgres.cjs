// Uses a new loopback-only database; never writes fixtures to an app database.
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Client } = require('pg');
const {
  Prisma,
  PrismaClient,
  CollectionStatus,
  CollectionVisibility,
  UserStatus,
} = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');
require('dotenv').config({ quiet: true });
require('ts-node').register({ transpileOnly: true });
const {
  eligibleProductWhere,
  eligibleProductSql,
  eligibleStoreCollectionWhere,
  eligibleStoreCollectionSql,
  isEligibleProduct,
  PRODUCT_ELIGIBILITY_FIELDS,
  PRODUCT_ELIGIBILITY_BRAND_FIELDS,
} = require('../src/market/eligibility/market-eligibility');

async function main() {
  const source = new URL(process.env.DATABASE_URL || '');
  assert(
    ['localhost', '127.0.0.1', '[::1]'].includes(source.hostname),
    'Requires a loopback PostgreSQL connection',
  );
  const database =
    'wiez_market_eligibility_' + randomUUID().replaceAll('-', '');
  assert(/^wiez_market_eligibility_[a-f0-9]{32}$/.test(database));
  const adminUrl = new URL(source);
  adminUrl.pathname = '/postgres';
  const testUrl = new URL(source);
  testUrl.pathname = '/' + database;
  const admin = new Client({ connectionString: adminUrl.toString() });
  const db = new Client({ connectionString: testUrl.toString() });
  let created = false,
    connected = false,
    prisma;
  const now = new Date('2026-11-14T12:00:00Z');
  await admin.connect();
  try {
    await admin.query('CREATE DATABASE "' + database + '"');
    created = true;
    await db.connect();
    connected = true;
    for (const [name, values] of Object.entries({
      CollectionStatus,
      CollectionVisibility,
      UserStatus,
    })) {
      // Names and values are generated schema constants, never external input.
      await db.query(
        'CREATE TYPE "' +
          name +
          '" AS ENUM (' +
          Object.values(values)
            .map((value) => "'" + value + "'")
            .join(',') +
          ')',
      );
    }
    // Only the existing model columns read by this policy are needed. The real
    // generated Prisma client still executes all joins and relation predicates.
    await db.query(`
      CREATE TABLE "User" ("_id" uuid PRIMARY KEY, status "UserStatus" NOT NULL);
      CREATE TABLE "Brand" ("_id" uuid PRIMARY KEY, "ownerId" uuid NOT NULL REFERENCES "User", "isStoreOpen" boolean NOT NULL);
      CREATE TABLE "Product" (
        "_id" uuid PRIMARY KEY, "brandId" uuid NOT NULL REFERENCES "Brand",
        "isActive" boolean NOT NULL, "publicationStatus" "CollectionStatus" NOT NULL,
        "deletedAt" timestamp, "archivedAt" timestamp, "publishAt" timestamp,
        price numeric(10,2) NOT NULL, thumbnail text, images text[] NOT NULL,
        "totalStock" integer NOT NULL, "customOrderEnabled" boolean NOT NULL
      );
      CREATE TABLE "StoreCollection" (
        "_id" uuid PRIMARY KEY, "ownerId" uuid NOT NULL REFERENCES "User",
        status "CollectionStatus" NOT NULL, visibility "CollectionVisibility" NOT NULL DEFAULT 'PUBLIC',
        "isAvailableInStore" boolean NOT NULL, "deletedAt" timestamp
      );
      CREATE TABLE "StoreCollectionProduct" (
        "_id" uuid PRIMARY KEY, "collectionId" uuid NOT NULL REFERENCES "StoreCollection",
        "productId" uuid NOT NULL REFERENCES "Product", "orderIndex" integer NOT NULL DEFAULT 0
      );
    `);
    prisma = new PrismaClient({
      adapter: new PrismaPg({ connectionString: testUrl.toString() }),
    });
    const expected = new Set();
    const expectedCollections = new Set();
    const ids = [];
    let seed = 20261114;
    const random = (n) => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed % n;
    };
    for (let i = 0; i < 240; i++) {
      const id = randomUUID(),
        owner = randomUUID(),
        brand = randomUUID();
      ids.push(id);
      const failures = i < 20 ? i : random(16);
      const row = {
        active: failures !== 1,
        status: [
          'PUBLISHED',
          'DRAFT',
          'IN_REVIEW',
          'CHANGES_REQUESTED',
          'REJECTED',
          'ARCHIVED',
        ][failures >= 2 && failures <= 6 ? failures - 1 : 0],
        deleted: failures === 7 ? now : null,
        archived: failures === 8 ? now : null,
        scheduled:
          failures === 9
            ? new Date(now.getTime() + 1)
            : i % 3 === 0
              ? now
              : null,
        open: failures !== 10,
        ownerStatus: failures === 11 ? 'SUSPENDED' : 'ACTIVE',
        stock: failures === 12 || i % 5 === 0 ? 0 : 2,
        custom: failures !== 12 && i % 5 === 0,
        price: failures === 13 ? 0 : 10000,
        thumbnail: null,
        images: failures === 14 ? [] : ['https://media.example/card.webp'],
        hiddenCollection: failures === 15,
      };
      // Failures16-19 are explicit positive thumbnail/custom/collection cases.
      if (failures === 16) {
        row.thumbnail = 'https://media.example/thumb.webp';
        row.images = [];
      }
      await db.query('INSERT INTO "User" VALUES ($1,$2)', [
        owner,
        row.ownerStatus,
      ]);
      await db.query('INSERT INTO "Brand" VALUES ($1,$2,$3)', [
        brand,
        owner,
        row.open,
      ]);
      await db.query(
        'INSERT INTO "Product" VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',
        [
          id,
          brand,
          row.active,
          row.status,
          row.deleted?.toISOString() ?? null,
          row.archived?.toISOString() ?? null,
          row.scheduled?.toISOString() ?? null,
          row.price,
          row.thumbnail,
          row.images,
          row.stock,
          row.custom,
        ],
      );
      if (row.hiddenCollection || failures === 17 || failures === 18) {
        const c = randomUUID();
        const visibility = failures === 17 ? 'PRIVATE' : 'PUBLIC';
        if (!row.hiddenCollection && visibility === 'PUBLIC')
          expectedCollections.add(c);
        await db.query(
          'INSERT INTO "StoreCollection" ("_id","ownerId",status,visibility,"isAvailableInStore") VALUES ($1,$2,$3,$4,true)',
          [c, owner, row.hiddenCollection ? 'DRAFT' : 'PUBLISHED', visibility],
        );
        await db.query(
          'INSERT INTO "StoreCollectionProduct" ("_id","collectionId","productId") VALUES ($1,$2,$3)',
          [randomUUID(), c, id],
        );
        if (failures === 18) {
          const draft = randomUUID();
          await db.query(
            'INSERT INTO "StoreCollection" ("_id","ownerId",status,"isAvailableInStore") VALUES ($1,$2,\'DRAFT\',true)',
            [draft, owner],
          );
          await db.query(
            'INSERT INTO "StoreCollectionProduct" ("_id","collectionId","productId") VALUES ($1,$2,$3)',
            [randomUUID(), draft, id],
          );
        }
      }
      if (failures === 0 || failures >= 16) expected.add(id);
    }
    const select = {
      id: true,
      ...PRODUCT_ELIGIBILITY_FIELDS,
      brand: { select: PRODUCT_ELIGIBILITY_BRAND_FIELDS },
    };
    const allRows = await prisma.product.findMany({ select });
    const prismaRows = await prisma.product.findMany({
      where: eligibleProductWhere(now),
      select: { id: true },
    });
    const fragment = eligibleProductSql(now);
    const sqlRows = await prisma.$queryRaw(
      Prisma.sql`SELECT p."_id" AS id FROM "Product" p WHERE ${fragment}`,
    );
    const sorted = (rows) => rows.map((r) => r.id).sort();
    const wanted = [...expected].sort();
    assert.deepEqual(
      sorted(prismaRows),
      wanted,
      'Prisma must match fixture truth',
    );
    assert.deepEqual(
      sorted(sqlRows),
      wanted,
      'Actual parameterized SQL must match fixture truth',
    );
    assert.deepEqual(
      sorted(allRows.filter((row) => isEligibleProduct(row, now))),
      wanted,
      'Hydrated gate must match fixture truth',
    );
    console.log(
      'PASS 240 deterministic rows: actual Prisma, PostgreSQL SQL and hydrated gate agree with fixture truth',
    );
    assert.equal(
      await prisma.product.count({
        where: eligibleProductWhere(now, [{ price: { gte: 0, lte: 0 } }]),
      }),
      0,
      'Caller price bounds cannot remove the positive-price rule',
    );
    const collectionSql = eligibleStoreCollectionSql(now);
    const collectionSqlRows = await prisma.$queryRaw(
      Prisma.sql`SELECT sc."_id" AS id FROM "StoreCollection" sc WHERE ${collectionSql}`,
    );
    const collectionPrismaRows = await prisma.storeCollection.findMany({
      where: eligibleStoreCollectionWhere(now),
      select: { id: true },
    });
    assert.deepEqual(
      sorted(collectionSqlRows),
      [...expectedCollections].sort(),
    );
    assert.deepEqual(
      sorted(collectionPrismaRows),
      [...expectedCollections].sort(),
    );
    console.log(
      'PASS collection SQL/Prisma policies agree and caller zero-price bounds cannot override eligibility',
    );
    const previouslyEligible = wanted[0];
    await db.query(
      'UPDATE "Product" SET "publicationStatus"=\'DRAFT\' WHERE "_id"=$1',
      [previouslyEligible],
    );
    const current = await prisma.product.findMany({
      where: eligibleProductWhere(now, [{ id: previouslyEligible }]),
      select,
    });
    assert.equal(current.length, 0, 'A cached/curated ID must be revalidated');
    const fresh = await prisma.product.findUnique({
      where: { id: previouslyEligible },
      select,
    });
    assert.equal(isEligibleProduct(fresh, now), false);
    console.log(
      'PASS previously cached/curated product becomes ineligible immediately after unpublishing',
    );
    assert.throws(() => eligibleProductSql(now, 'p;DROP TABLE "Product"'));
    assert.equal(
      (await db.query('SELECT COUNT(*)::int AS n FROM "Product"')).rows[0].n,
      ids.length,
    );
    console.log(
      'PASS hostile identifier is rejected and no application database was used',
    );
  } finally {
    if (prisma) await prisma.$disconnect();
    if (connected) await db.end();
    if (created) await admin.query('DROP DATABASE "' + database + '"');
    await admin.end();
    console.log('Disposable eligibility database removed');
  }
}
main().catch((error) => {
  console.error(error.name + ': ' + error.message);
  process.exitCode = 1;
});
