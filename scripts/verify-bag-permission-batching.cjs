const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Client } = require('pg');
require('dotenv').config({ quiet: true });
require('ts-node').register({ transpileOnly: true });
require('tsconfig-paths/register');
const { CustomOrdersService } = require('../src/custom-orders/custom-orders.service');
const { BrandPermissionService } = require('../src/brands/permissions/brand-permission.service');
const { BRAND_PERMISSIONS } = require('../src/brands/permissions/brand-permissions');
const { CustomOrderQueueService } = require('../src/custom-orders/queue/custom-order-queue.service');

async function main() {
  const source = new URL(process.env.DATABASE_URL || '');
  assert(['localhost', '127.0.0.1', '[::1]'].includes(source.hostname), 'Loopback database required');
  const client = new Client({ connectionString: source.toString() });
  const schema = `wiez_bag_test_${randomUUID().replaceAll('-', '')}`;
  const id = () => randomUUID();
  let created = false;
  await client.connect();
  try {
    await client.query(`CREATE SCHEMA "${schema}"`); created = true;
    await client.query(`SET search_path TO "${schema}", public`);
    await client.query("SET TIME ZONE 'UTC'");
    await client.query(`CREATE TABLE "Brand" ("_id" uuid PRIMARY KEY, "ownerId" uuid, name text);
      CREATE TABLE "Product" ("_id" uuid PRIMARY KEY, "brandId" uuid, name text, thumbnail text, images text[]);
      CREATE TABLE "Collection" ("_id" uuid PRIMARY KEY, "ownerId" uuid, title text, domain text, "coverMediaId" uuid);
      CREATE TABLE "CollectionMedia" ("_id" uuid PRIMARY KEY, "fileUploadId" uuid, "collectionId" uuid, "mediaType" text, "orderIndex" int);
      CREATE TABLE "FileUpload" ("_id" uuid PRIMARY KEY, "s3Url" text);
      CREATE TABLE "BrandMember" (id uuid PRIMARY KEY, "brandId" uuid, "userId" uuid, status text, role "BrandMemberRole");
      CREATE TABLE "BrandPermissionGrant" ("brandMemberId" uuid, "permissionCode" text);`);
    await client.query(`ALTER TABLE "Brand" ADD COLUMN "verificationStatus" text DEFAULT 'APPROVED', ADD COLUMN "customOrderIntakeBlockedAt" timestamp;
      CREATE TABLE "User" ("_id" uuid PRIMARY KEY, status text);
      CREATE TABLE "SubscriptionTier" (key text PRIMARY KEY);
      CREATE TABLE "BrandSubscription" ("brandId" uuid, "tierKey" text, status text, "currentPeriodEnd" timestamp, "createdAt" timestamp);`);
    const owner = id(), staff = id(), stranger = id(), brand = id(), product = id(), design = id(), store = id(), gone = id();
    await client.query('INSERT INTO "Brand" ("_id","ownerId",name) VALUES ($1,$2,$3)', [brand, owner, 'Atelier']);
    await client.query('INSERT INTO "Product" VALUES ($1,$2,$3,$4,$5)', [product, brand, 'Shirt', '', ['https://media.example/shirt.jpg']]);
    await client.query('INSERT INTO "Collection" VALUES ($1,$2,null,$3,null),($4,$2,$5,$6,null)', [design, owner, 'DESIGN', store, 'Store-only', 'STORE']);
    const media = id(), file = id();
    await client.query('INSERT INTO "FileUpload" VALUES ($1,$2)', [file, 'https://media.example/design.jpg']);
    await client.query('INSERT INTO "CollectionMedia" VALUES ($1,$2,$3,$4,0)', [media, file, design, 'POST_IMAGE']);
    const prisma = { $queryRaw: async (query) => (await client.query(query.text, query.values)).rows };
    const service = Object.assign(Object.create(CustomOrdersService.prototype), { prisma });
    const sources = await service.loadCheckoutBagSourceSnapshots([
      { sourceType: 'PRODUCT', sourceId: product }, { sourceType: 'DESIGN', sourceId: design },
      { sourceType: 'DESIGN', sourceId: store }, { sourceType: 'PRODUCT', sourceId: gone },
    ]);
    assert.deepEqual(sources.get(`PRODUCT:${product}`), { title: 'Shirt', primaryMediaUrl: 'https://media.example/shirt.jpg', brandName: 'Atelier' });
    assert.deepEqual(sources.get(`DESIGN:${design}`), { title: 'Untitled design', primaryMediaUrl: 'https://media.example/design.jpg', brandName: 'Atelier' });
    assert.equal(sources.size, 2, 'Missing and wrong-domain sources must not be hydrated');
    const permissions = new BrandPermissionService(prisma);
    const member = id();
    await client.query('INSERT INTO "BrandMember" VALUES ($1,$2,$3,$4,$5)', [member, brand, staff, 'ACTIVE', 'CATALOG_MANAGER']);
    await client.query('INSERT INTO "BrandPermissionGrant" VALUES ($1,$2)', [member, BRAND_PERMISSIONS.ORDERS_READ]);
    assert((await permissions.getPermittedBrandIds(owner, [brand], BRAND_PERMISSIONS.ORDERS_READ)).has(brand));
    assert((await permissions.getPermittedBrandIds(staff, [brand], BRAND_PERMISSIONS.ORDERS_READ)).has(brand));
    assert.equal((await permissions.getPermittedBrandIds(stranger, [brand], BRAND_PERMISSIONS.ORDERS_READ)).size, 0);
    await client.query('UPDATE "BrandMember" SET status=$1', ['SUSPENDED']);
    assert.equal((await permissions.getPermittedBrandIds(staff, [brand], BRAND_PERMISSIONS.ORDERS_READ)).size, 0);
    await client.query('UPDATE "BrandMember" SET status=$1, role=$2', ['ACTIVE', 'OWNER']);
    assert((await permissions.getPermittedBrandIds(staff, [brand], BRAND_PERMISSIONS.ORDERS_READ)).has(brand));
    await client.query('INSERT INTO "User" VALUES ($1,$2)', [owner, 'ACTIVE']);
    await client.query("INSERT INTO \"SubscriptionTier\" VALUES ('THREAD')");
    const intake = Object.assign(Object.create(CustomOrderQueueService.prototype), { prisma: {
      ...prisma, user: { findUnique: async () => ({ type: 'REGULAR', status: 'ACTIVE' }) },
    } });
    await assert.rejects(intake.assertIntakeForBrands(stranger, [brand]), /CUSTOM_ORDER_INTAKE_UNAVAILABLE/);
    await client.query(`INSERT INTO "BrandSubscription" VALUES ($1,'THREAD','ACTIVE',now()+interval '1 day',now())`, [brand]);
    await intake.assertIntakeForBrands(stranger, [brand]);
    await client.query(`UPDATE "BrandSubscription" SET "currentPeriodEnd"=now()-interval '1 second'`);
    await assert.rejects(intake.assertIntakeForBrands(stranger, [brand]), /CUSTOM_ORDER_INTAKE_UNAVAILABLE/);
    await client.query(`UPDATE "BrandSubscription" SET "currentPeriodEnd"=now()+interval '1 day', status='CANCELLED'`);
    await assert.rejects(intake.assertIntakeForBrands(stranger, [brand]), /CUSTOM_ORDER_INTAKE_UNAVAILABLE/);
    await client.query(`UPDATE "BrandSubscription" SET status='ACTIVE'`);
    await client.query(`UPDATE "Brand" SET "customOrderIntakeBlockedAt"=now()`);
    await assert.rejects(intake.assertIntakeForBrands(stranger, [brand]), /CUSTOM_ORDER_INTAKE_UNAVAILABLE/);
    await client.query(`UPDATE "Brand" SET "customOrderIntakeBlockedAt"=null, "verificationStatus"='PENDING'`);
    await assert.rejects(intake.assertIntakeForBrands(stranger, [brand]), /CUSTOM_ORDER_INTAKE_UNAVAILABLE/);
    await client.query(`UPDATE "Brand" SET "verificationStatus"='APPROVED'`);
    await client.query(`UPDATE "User" SET status='SUSPENDED'`);
    await assert.rejects(intake.assertIntakeForBrands(stranger, [brand]), /CUSTOM_ORDER_INTAKE_UNAVAILABLE/);
    console.log('PASS: joined bag sources and domain isolation; owner/staff/suspended/stranger permissions; free, active, expired, cancelled, blocked, unverified and suspended-owner intake.');
  } finally {
    if (created) {
      assert(/^wiez_bag_test_[a-f0-9]{32}$/.test(schema));
      await client.query(`DROP SCHEMA "${schema}" CASCADE`);
    }
    await client.end();
  }
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
