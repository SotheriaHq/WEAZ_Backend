require('dotenv').config({ quiet: true });
require('ts-node/register/transpile-only');
const { Client } = require('pg');
const { randomUUID } = require('node:crypto');
const assert = require('node:assert/strict');
const { privateCollectionCountsForOwners } = require('../src/collections/collection-counts.util');
const url = new URL(process.env.DATABASE_URL);
if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('Local PostgreSQL required');
const client = new Client({ connectionString: url.toString() });
async function main() {
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query('CREATE TEMP TABLE "Collection" ("_id" uuid, "ownerId" uuid, visibility text, status text, "deletedAt" timestamp)');
    const owner = randomUUID(), empty = randomUUID();
    for (const [visibility, status, deletedAt] of [['PRIVATE', 'PUBLISHED', null], ['PRIVATE', 'PUBLISHED', null], ['PUBLIC', 'PUBLISHED', null], ['PRIVATE', 'DRAFT', null], ['PRIVATE', 'PUBLISHED', new Date()]])
      await client.query('INSERT INTO "Collection" VALUES ($1,$2,$3,$4,$5)', [randomUUID(), owner, visibility, status, deletedAt]);
    let calls = 0;
    const prisma = { $queryRaw: async (sql) => { calls++; return (await client.query(sql.text, sql.values)).rows; } };
    const counts = await privateCollectionCountsForOwners(prisma, [owner, owner, empty]);
    assert.equal(counts.get(owner), 2); assert.equal(counts.get(empty), 0); assert.equal(calls, 1);
    assert.equal((await privateCollectionCountsForOwners(prisma, [])).size, 0); assert.equal(calls, 1);
    await client.query('ALTER TABLE "Collection" ADD COLUMN title text, ADD COLUMN "coverMediaId" uuid, ADD COLUMN "viewsCount" int, ADD COLUMN "likesCount" int');
    await client.query('CREATE TEMP TABLE "Product" ("_id" uuid PRIMARY KEY, name text, thumbnail text, images text[], price numeric(10,2), "salePrice" numeric(10,2), currency text, "viewsCount" int, "likesCount" int)');
    await client.query('CREATE TEMP TABLE "CollectionMedia" ("_id" uuid PRIMARY KEY, "fileUploadId" uuid)');
    await client.query('CREATE TEMP TABLE "FileUpload" ("_id" uuid PRIMARY KEY, "s3Url" text)');
    const product = randomUUID(), design = randomUUID(), media = randomUUID(), file = randomUUID();
    await client.query(`INSERT INTO "Product" VALUES ($1,'Jacket','',ARRAY['fallback.jpg'],120.00,90.50,'NGN',8,4)`, [product]);
    await client.query(`INSERT INTO "Collection" ("_id", title, "coverMediaId", "viewsCount", "likesCount") VALUES ($1,'Print', $2, 12, 7)`, [design, media]);
    await client.query(`INSERT INTO "CollectionMedia" VALUES ($1,$2)`, [media, file]);
    await client.query(`INSERT INTO "FileUpload" VALUES ($1,'cover.jpg')`, [file]);
    const items = [
      { id: randomUUID(), entityType: 'PRODUCT', entityId: product },
      { id: randomUUID(), entityType: 'DESIGN', entityId: design },
      { id: randomUUID(), entityType: 'PRODUCT', entityId: randomUUID() },
      { id: randomUUID(), entityType: 'DESIGN', entityId: randomUUID() },
      { id: randomUUID(), entityType: 'UNKNOWN', entityId: product },
    ];
    const { loadFeaturedSummaries } = require('../src/admin/featured/featured-summary.util');
    const before = calls;
    const summaries = await loadFeaturedSummaries(prisma, [...items, items[0]]);
    assert.equal(calls - before, 1); assert.equal(summaries.size, 5);
    assert.deepEqual(summaries.get(items[0].id).entityPrice, { price: '120', salePrice: '90.5', currency: 'NGN' });
    assert.equal(summaries.get(items[0].id).entityThumbnail, 'fallback.jpg');
    assert.equal(summaries.get(items[0].id).threadsDelta, 4);
    assert.equal(summaries.get(items[1].id).entityThumbnail, 'cover.jpg');
    assert.equal(summaries.get(items[1].id).threadsDelta, 7);
    assert.equal(summaries.get(items[2].id).entityName, 'Deleted product');
    assert.equal(summaries.get(items[3].id).entityName, 'Deleted design');
    assert.equal(summaries.get(items[4].id).entityPrice, null);
    assert.equal((await loadFeaturedSummaries(prisma, [])).size, 0);
    assert.equal(calls - before, 1);
    await client.query('ALTER TABLE "FileUpload" ADD COLUMN "assetVersion" int DEFAULT 2');
    await client.query('CREATE TEMP TABLE "FileVariant" ("fileUploadId" uuid, "assetVersion" int, "variantKind" "ImageVariantKind", format text, "s3Key" text, "s3Url" text)');
    for (const [version,kind,key] of [[1,'CARD','stale'],[2,'CARD','current'],[2,'AVATAR','avatar']]) await client.query('INSERT INTO "FileVariant" VALUES ($1,$2,$3, $4,$5,$5)', [file,version,kind,'WEBP',key]);
    const { loadActiveDisplayVariants } = require('../src/upload/variant-display.util');
    const beforeVariants = calls;
    const variants = await loadActiveDisplayVariants(prisma, [file,file,randomUUID()], 'CARD');
    assert.equal(calls-beforeVariants,1); assert.equal(variants.length,1); assert.equal(variants[0].s3Key,'current');
    assert.equal((await loadActiveDisplayVariants(prisma, [], 'CARD')).length,0); assert.equal(calls-beforeVariants,1);
    console.log('PostgreSQL LEFT JOIN counts, featured summaries and active-version media passed: bounded SELECTs, deleted targets, mapped columns, decimal strings, version/kind isolation and empty inputs.');
  } finally { await client.query('ROLLBACK'); await client.end(); }
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
