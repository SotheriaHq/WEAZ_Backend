/** Metadata and aggregate counts only. Never changes data or prints connection secrets. */
require('dotenv').config({ path: require('node:path').resolve(__dirname, '../.env'), quiet: true });
const { Client } = require('pg');
const { Prisma } = require('@prisma/client');
const fs = require('node:fs');
const path = require('node:path');
const url = new URL(process.env.DATABASE_URL);
const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
if (!local && !process.argv.includes('--allow-remote-read-only')) throw new Error('Remote audit requires --allow-remote-read-only');
const models = Prisma.dmmf.datamodel.models;
const client = new Client({ connectionString: url.toString(), statement_timeout: 30000 });
async function main() {
  await client.connect();
  try {
    await client.query('BEGIN READ ONLY');
    // Prisma 7 runtime DMMF omits relationFromFields/dbName. Read actual constraints.
    const uuidColumns = (await client.query(`SELECT columns.table_name, columns.column_name,
      EXISTS (SELECT 1 FROM pg_constraint constraint_row
        JOIN pg_class relation ON relation.oid=constraint_row.conrelid
        JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
        JOIN pg_attribute attribute ON attribute.attrelid=relation.oid AND attribute.attnum=ANY(constraint_row.conkey)
        WHERE constraint_row.contype IN ('f','p') AND namespace.nspname=columns.table_schema
          AND relation.relname=columns.table_name AND attribute.attname=columns.column_name) AS bound
      FROM information_schema.columns columns
      WHERE columns.table_schema=current_schema() AND columns.udt_name='uuid'
      ORDER BY columns.table_name,columns.column_name`)).rows;
    const report = {
      generatedAt: new Date().toISOString(), scope: local ? 'configured database via loopback (read-only)' : 'configured remote database (read-only)',
      serverVersion: (await client.query('SHOW server_version')).rows[0].server_version,
      schema: {
        models: models.length,
        relationalFields: models.flatMap((model) => model.fields.filter((field) => field.kind === 'object')).length,
        jsonFields: models.flatMap((model) => model.fields.filter((field) => field.type === 'Json')).length,
        relationMetadataSource: 'PostgreSQL pg_constraint/pg_attribute; runtime DMMF omits relation fields',
        uuidColumnsInspected: uuidColumns.length,
        // Polymorphic IDs and immutable actor/source snapshots can be intentional.
        unboundIdCandidates: uuidColumns.filter((column) => !column.bound && !['id','_id'].includes(column.column_name))
          .map((column) => `${column.table_name}.${column.column_name}`),
      }, counts: {}, migrationHealth: {},
    };
    const queries = {
      duplicateCartSelections: `SELECT COUNT(*)::int count FROM (SELECT 1 FROM "CartItem" GROUP BY "userId","productId","selectedSize","selectedColor" HAVING COUNT(*)>1) duplicates`,
      invalidCartQuantities: `SELECT COUNT(*)::int count FROM "CartItem" WHERE quantity NOT BETWEEN 1 AND 99`,
      orphanCartOwners: `SELECT COUNT(*)::int count FROM "CartItem" item LEFT JOIN "User" owner ON owner."_id"=item."userId" WHERE owner."_id" IS NULL`,
      orphanWishlistOwners: `SELECT COUNT(*)::int count FROM "WishlistItem" item LEFT JOIN "User" owner ON owner."_id"=item."userId" WHERE owner."_id" IS NULL`,
      activeFeaturedBrandDuplicates: `SELECT COUNT(*)::int count FROM (SELECT 1 FROM "FeaturedItem" WHERE "isActive" GROUP BY "brandId" HAVING COUNT(*)>1) duplicates`,
      inconsistentProductFilterBridge: `SELECT COUNT(*)::int count FROM "EntityFilter" WHERE ("entityType"='PRODUCT' AND "productId" IS DISTINCT FROM "entityId") OR ("entityType"<>'PRODUCT' AND "productId" IS NOT NULL)`,
      orphanProductFilterTargets: `SELECT COUNT(*)::int count FROM "EntityFilter" filters LEFT JOIN "Product" product ON product."_id"=filters."entityId" WHERE filters."entityType"='PRODUCT' AND product."_id" IS NULL`,
      multiplePrimaryProductMemberships: `SELECT COUNT(*)::int count FROM (SELECT "productId" FROM "StoreCollectionProduct" WHERE "isPrimary" GROUP BY "productId" HAVING COUNT(*)>1) duplicates`,
      inconsistentPrimaryProductMemberships: `SELECT COUNT(*)::int count FROM "Product" product LEFT JOIN LATERAL (
        SELECT "collectionId" FROM "StoreCollectionProduct" membership WHERE membership."productId"=product."_id"
        ORDER BY "isPrimary" DESC,"createdAt","orderIndex","collectionId" LIMIT 1
      ) membership ON TRUE WHERE product."collectionId" IS DISTINCT FROM membership."collectionId"`,
      inconsistentTagUsageCounts: `SELECT COUNT(*)::int count FROM "Tag" tag LEFT JOIN (
        SELECT "tagId",COUNT(*)::int usage FROM "TagBinding" GROUP BY "tagId"
      ) bindings ON bindings."tagId"=tag."_id" WHERE tag."usageCount" IS DISTINCT FROM COALESCE(bindings.usage,0)`,
      orphanTagBindingTargets: `SELECT COUNT(*)::int count FROM "TagBinding" binding
        LEFT JOIN "Product" product ON binding."entityType"='PRODUCT' AND product."_id"=binding."entityId"
        LEFT JOIN "Collection" design ON binding."entityType"='COLLECTION' AND design."_id"=binding."entityId"
        LEFT JOIN "StoreCollection" collection ON binding."entityType"='COLLECTION' AND collection."_id"=binding."entityId"
        LEFT JOIN "Brand" brand ON binding."entityType"='BRAND' AND brand."_id"=binding."entityId"
        LEFT JOIN "User" owner ON binding."entityType"='USER_BRAND' AND owner."_id"=binding."entityId"
        WHERE COALESCE(product."_id",design."_id",collection."_id",brand."_id",owner."_id") IS NULL`,
      storeCollectionsUsingDesignTagType: `SELECT COUNT(*)::int count FROM "TagBinding" binding
        JOIN "StoreCollection" collection ON collection."_id"=binding."entityId" WHERE binding."entityType"='COLLECTION'`,
      ordersMissingRelationalLines: `SELECT COUNT(*)::int count FROM "Order" orders
        WHERE jsonb_typeof(orders.items)='array' AND jsonb_array_length(orders.items)>0
        AND NOT EXISTS (SELECT 1 FROM "OrderItem" item WHERE item."orderId"=orders."_id")`,
      orderItemOwnershipMismatch: `SELECT COUNT(*)::int count FROM "OrderItem" item
        JOIN "Order" orders ON orders."_id"=item."orderId"
        JOIN "Product" product ON product."_id"=item."productId"
        WHERE item."brandId" IS DISTINCT FROM orders."brandId" OR item."brandId" IS DISTINCT FROM product."brandId"
          OR item."buyerId" IS DISTINCT FROM orders."buyerId"`,
    };
    // An older database may lack an audited feature. Preserve the read-only transaction after a missing-table error.
    for (const [key, sql] of Object.entries(queries)) {
      await client.query('SAVEPOINT audit_check');
      try { report.counts[key] = (await client.query(sql)).rows[0].count; }
      catch (error) { await client.query('ROLLBACK TO SAVEPOINT audit_check'); report.counts[key] = { unavailable: error.code }; }
      await client.query('RELEASE SAVEPOINT audit_check');
    }
    const columns = (await client.query(`SELECT column_name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='BrandPhysicalVerification' AND column_name=ANY($1::text[])`, [['reminderDayBeforeAt', 'reminderHourBeforeAt', 'awaitingReplyNudgedAt']])).rows.map((row) => row.column_name);
    report.migrationHealth.physicalVerificationReminderColumns = columns.sort();
    report.migrationHealth.missingPhysicalVerificationReminderColumns = ['reminderDayBeforeAt', 'reminderHourBeforeAt', 'awaitingReplyNudgedAt'].filter((column) => !columns.includes(column));
    if ((await client.query(`SELECT to_regclass('"_prisma_migrations"') IS NOT NULL AS exists`)).rows[0].exists) {
      report.migrationHealth.failedUnresolved = (await client.query(`SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NULL AND rolled_back_at IS NULL`)).rows.map((row) => row.migration_name);
    }
    await client.query('ROLLBACK');
    const flag = process.argv.indexOf('--output');
    if (flag >= 0) {
      const output = path.resolve(process.argv[flag + 1]);
      fs.mkdirSync(path.dirname(output), { recursive: true });
      fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
    }
    console.log(JSON.stringify({ scope: report.scope, serverVersion: report.serverVersion, models: models.length, counts: report.counts, migrationHealth: report.migrationHealth }));
  } finally { await client.end(); }
}
main().catch((error) => { console.error(error.code ?? error.message); process.exitCode = 1; });
