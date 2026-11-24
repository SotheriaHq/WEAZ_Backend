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

const PRIVACY_AGE_INDEXES = {
  feed: ['user_feed_signals', 'user_feed_signals_createdAt__id_idx'],
  seen: ['user_seen_items', 'user_seen_items_createdAt__id_idx'],
  sections: [
    'market_section_signals',
    'market_section_signals_createdAt__id_idx',
  ],
  suggestions: ['suggestion_signals', 'suggestion_signals_createdAt__id_idx'],
  receipts: [
    'market_signal_batch_receipts',
    'market_signal_batch_receipts_createdAt__id_idx',
  ],
};

// Plans the exact production age statements (EXPLAIN without ANALYZE never
// executes the DELETE) in the steady state the every-minute sweep sees: 20,000
// fresh rows per identity table and only a few expired ones.
async function checkPrivacyIndexPlans(db) {
  require('ts-node').register({ transpileOnly: true });
  const {
    marketRetentionSteps,
  } = require('../../src/market/intelligence/market-intelligence.sql');
  // The application stores UTC wall-clock timestamps and connects in UTC.
  await db.query("SET TIME ZONE 'UTC'");
  // Append-only order: four expired rows first, then ~22 hours of fresh rows.
  const age = `(statement_timestamp() AT TIME ZONE 'UTC')-CASE WHEN n<=4
    THEN interval '2 days'-make_interval(secs=>n) ELSE make_interval(secs=>(20000-n)*3.9) END`;
  await db.query(`INSERT INTO user_feed_signals ("_id","targetType","targetId","signalType","createdAt")
    SELECT gen_random_uuid(),'PRODUCT','t'||n,'ITEM_IMPRESSION',${age} FROM generate_series(1,20000) n`);
  await db.query(`INSERT INTO user_seen_items ("_id","targetType","targetId",surface,"seenAt","createdAt")
    SELECT gen_random_uuid(),'PRODUCT','t'||n,'MARKET_HOME',${age},${age} FROM generate_series(1,20000) n`);
  await db.query(`INSERT INTO market_section_signals ("_id","sectionKey","signalType","createdAt")
    SELECT gen_random_uuid(),'fixture','SECTION_VIEW',${age} FROM generate_series(1,20000) n`);
  await db.query(`INSERT INTO suggestion_signals ("_id","blockKey","signalType","createdAt")
    SELECT gen_random_uuid(),'fixture','SECTION_VIEW',${age} FROM generate_series(1,20000) n`);
  await db.query(`INSERT INTO market_signal_batch_receipts ("_id","batchId","createdAt")
    SELECT gen_random_uuid(),'batch-'||n,${age} FROM generate_series(1,20000) n`);
  const cutoff = (
    await db.query(
      `SELECT date_trunc('milliseconds',statement_timestamp()-interval '24 hours') AS cutoff`,
    )
  ).rows[0].cutoff;
  let planned = 0;
  for (const [kind, [table, index]] of Object.entries(PRIVACY_AGE_INDEXES)) {
    await db.query('ANALYZE ' + table);
    const [step] = marketRetentionSteps(kind, cutoff);
    // The selection must be index-driven; joining its <=2,000 keys back to a
    // tiny fixture table may legitimately hash a sequential scan.
    for (const [statement, scanFree] of [
      [step.delete, false],
      [step.remaining, true],
    ]) {
      const plan = (
        await db.query(
          'EXPLAIN (FORMAT JSON) ' + statement.text,
          statement.values,
        )
      ).rows[0]['QUERY PLAN'][0].Plan;
      const names = [];
      const seqScans = [];
      (function visit(node) {
        if (node['Index Name']) names.push(node['Index Name']);
        if (node['Node Type'] === 'Seq Scan')
          seqScans.push(node['Relation Name']);
        for (const child of node.Plans || []) visit(child);
      })(plan);
      assert(
        names.includes(index) && !(scanFree && seqScans.includes(table)),
        kind +
          ' privacy age statement must use ' +
          index +
          ': ' +
          names.join(',') +
          '; sequential: ' +
          seqScans.join(','),
      );
      planned++;
    }
  }
  await db.query('RESET TIME ZONE');
  console.log(
    'PASS ' +
      planned +
      ' production privacy age statements use (createdAt,_id) indexes on 20,000 rows per table; not a production latency/capacity claim',
  );
}

module.exports = { checkMarketIndexPlans, checkPrivacyIndexPlans };
