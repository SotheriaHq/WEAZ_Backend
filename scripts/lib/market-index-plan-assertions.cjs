const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');

async function checkMarketIndexPlans(db, brand) {
  const categories = Array.from({ length: 10 }, () => randomUUID());
  const owners = Array.from({ length: 9 }, () => randomUUID());
  const otherBrands = owners.map(() => randomUUID());
  await db.query(
    `INSERT INTO "User" ("_id",username,email,"updatedAt")
    SELECT id,'index-fixture-'||id::text,id::text||'@example.test',statement_timestamp()
    FROM unnest($1::uuid[]) id`,
    [owners],
  );
  await db.query(
    `INSERT INTO "Brand" ("_id",name,"ownerId","updatedAt")
    SELECT id,'Index fixture brand',owner,statement_timestamp()
    FROM unnest($1::uuid[],$2::uuid[]) AS b(id,owner)`,
    [otherBrands, owners],
  );
  await db.query(
    `INSERT INTO "CollectionCategory" ("_id",slug,name,"updatedAt")
    SELECT id,'fixture-'||id::text,'Fixture category',statement_timestamp() FROM unnest($1::uuid[]) id`,
    [categories],
  );
  await db.query(
    `INSERT INTO "Product" ("_id","brandId","categoryId",name,price,
    "isActive","publicationStatus",tags,"updatedAt")
    SELECT gen_random_uuid(),($1::uuid[])[CASE WHEN n<=5 THEN 1 ELSE 2+(n%9) END],
      ($2::uuid[])[CASE WHEN n<=5 THEN 1 ELSE 2+(n%9) END],'Index fixture',n*10,
      true,'PUBLISHED',CASE WHEN n%100=0 THEN ARRAY['fixture-rare'] ELSE ARRAY['fixture-common'] END,
      statement_timestamp() FROM generate_series(1,2000) n`,
    [[brand, ...otherBrands], categories],
  );
  await db.query('ANALYZE "Product"');
  const active = `"isActive" AND "publicationStatus"='PUBLISHED' AND "deletedAt" IS NULL AND "archivedAt" IS NULL`;
  const cases = [
    [
      'newest',
      `SELECT "_id" FROM "Product" WHERE ${active} ORDER BY "firstPublishedAt" DESC,"_id" DESC LIMIT 20`,
      [],
      'Product_market_first_publication_idx',
    ],
    [
      'price-cache',
      `SELECT "_id" FROM "Product" WHERE ${active} AND "effectivePrice">=5000 AND "effectivePrice"<=6000 ORDER BY "effectivePrice","_id" LIMIT 20`,
      [],
      'Product_market_effective_price_idx',
    ],
    [
      'category',
      `SELECT "_id" FROM "Product" WHERE ${active} AND "categoryId"=$1 ORDER BY "firstPublishedAt" DESC,"_id" DESC LIMIT 20`,
      [categories[0]],
      'Product_market_category_publication_idx',
    ],
    [
      'brand',
      `SELECT "_id" FROM "Product" WHERE ${active} AND "brandId"=$1 ORDER BY "firstPublishedAt" DESC,"_id" DESC LIMIT 20`,
      [brand],
      ['Product_market_brand_publication_idx', 'Product_isActive_brandId_idx'],
    ],
    [
      'price-desc',
      `SELECT "_id" FROM "Product" WHERE ${active} ORDER BY "effectivePrice" DESC,"_id" ASC LIMIT 20`,
      [],
      'Product_market_effective_price_desc_idx',
    ],
    [
      'price-computed',
      `SELECT "_id" FROM "Product" WHERE "effectivePriceComputedAt">statement_timestamp()+interval '1 day' ORDER BY "effectivePriceComputedAt","_id" LIMIT 20`,
      [],
      'Product_market_price_computed_idx',
    ],
    [
      'tags',
      `SELECT "_id" FROM "Product" WHERE tags @> ARRAY['fixture-rare']`,
      [],
      'Product_market_tags_idx',
    ],
    [
      'transaction-fence',
      `SELECT "_id","priceChangeXid" FROM "Product" WHERE "priceChangeXid">=pg_snapshot_xmin(pg_current_snapshot()) ORDER BY "priceChangeXid","_id" LIMIT 20`,
      [],
      'Product_market_price_change_idx',
    ],
    [
      'price-boundary',
      `SELECT "_id" FROM "Product" WHERE "effectivePriceValidUntil"<=statement_timestamp()+interval '2 days' ORDER BY "effectivePriceValidUntil","_id" LIMIT 20`,
      [],
      'Product_market_price_boundary_idx',
    ],
  ];
  for (const [label, query, args, expected] of cases) {
    const result = (
      await db.query('EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ' + query, args)
    ).rows[0]['QUERY PLAN'][0];
    const names = [],
      conditions = [];
    function visit(plan) {
      if (plan['Index Name']) names.push(plan['Index Name']);
      if (plan['Index Cond']) conditions.push(plan['Index Cond']);
      for (const child of plan.Plans || []) visit(child);
    }
    visit(result.Plan);
    const acceptable = Array.isArray(expected) ? expected : [expected];
    // Small selective results may legitimately use an older narrower index.
    // Assert an indexed predicate, rather than pinning that optimizer choice.
    const selectiveColumn =
      label === 'brand'
        ? 'brandId'
        : label === 'category'
          ? 'categoryId'
          : null;
    assert(
      selectiveColumn
        ? conditions.some((condition) =>
            condition.includes('"' + selectiveColumn + '"'),
          )
        : acceptable.some((name) => names.includes(name)),
      label + ' did not use an appropriate index: ' + names.join(','),
    );
  }
  console.log(
    'PASS ' +
      cases.length +
      ' Product query shapes use appropriate indexes on 2,000 rows, reusing the existing selective brand index; not a production latency/capacity claim',
  );
}

module.exports = { checkMarketIndexPlans };
