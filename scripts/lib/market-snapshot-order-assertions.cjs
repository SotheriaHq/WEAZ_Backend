const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const {
  marketSnapshotPageSql,
} = require('../../src/market/catalog/market-snapshot-order.sql');

/** Called only inside the owning script's guarded disposable database. */
module.exports = async function assertSnapshotOrder({ db, query, now }) {
  await db.query(`
    CREATE TABLE market_feature_epochs (
      id uuid PRIMARY KEY,status text,"epochStart" timestamptz,"acceptUntil" timestamptz,
      "readyAt" timestamptz,"sourceAsOf" timestamptz,"featureSchemaVersion" int,"policyVersion" int);
    CREATE TABLE market_item_feature_snapshots (
      "epochId" uuid REFERENCES market_feature_epochs,"productId" uuid REFERENCES "Product" ON DELETE CASCADE,
      "sourceFeatureSchemaVersion" int,"sourcePolicyVersion" int,"sourceAsOf" timestamptz,
      "sourceComputedAt" timestamptz,coverage jsonb,"decayedPopularity" float8,"trendEligible" boolean,
      "trendScore" float8,"actors7d" int,"units28d" int,"savesCount" int,
      PRIMARY KEY("epochId","productId"));
    CREATE INDEX ON market_item_feature_snapshots ("epochId","decayedPopularity" DESC,"productId");
    CREATE INDEX ON market_item_feature_snapshots ("epochId","savesCount" DESC,"productId");
    CREATE INDEX ON market_item_feature_snapshots ("epochId","units28d" DESC,"productId");
    CREATE INDEX ON market_item_feature_snapshots ("epochId","trendEligible" DESC,"trendScore" DESC,"decayedPopularity" DESC,"productId");
  `);
  const epochId = randomUUID();
  const end = new Date(now.getTime() + 3600000);
  await db.query(
    `INSERT INTO market_feature_epochs VALUES ($1,'READY',$2,$3,$2,$2,1,1)`,
    [epochId, now, end],
  );
  const metric = (days) => ({
    completeness: 'COMPLETE',
    reason: 'SOURCE_COMPLETE',
    requiredWindowStart: new Date(
      now.getTime() - days * 86400000,
    ).toISOString(),
    requiredWindowEnd: now.toISOString(),
    observedFrom: new Date(now.getTime() - days * 86400000).toISOString(),
    observedThrough: now.toISOString(),
  });
  const coverage = {
    decayedPopularity: metric(28),
    units28d: metric(28),
    savesCount: metric(0),
    actors7d: metric(7),
    trendScore: metric(28),
  };
  await db.query(
    `INSERT INTO market_item_feature_snapshots
    SELECT $1,"_id",1,1,$2,$2,$3::jsonb,(n%5)::float8,n%3=0,
      CASE WHEN n%3=0 THEN (n%7)::float8-3 ELSE NULL END,6,(n%8)::int,(n%11)::int
    FROM (SELECT "_id",row_number() OVER(ORDER BY "_id") n FROM "Product" ORDER BY "_id" LIMIT 200) p`,
    [epochId, now, JSON.stringify(coverage)],
  );
  const read = (sort, after, clock = now) =>
    (async () => {
      const sql = marketSnapshotPageSql({
        epochId,
        sort,
        filters: {},
        now: clock,
        limit: 7,
        ...(after ? { after } : {}),
      });
      try {
        return await query(sql);
      } catch (error) {
        const plan = (
          await db.query('EXPLAIN (FORMAT JSON) ' + sql.text, sql.values)
        ).rows[0]['QUERY PLAN'][0];
        console.error(
          JSON.stringify({
            fixtureOnly: true,
            stage: 'frozen-score',
            sort,
            plan,
          }),
        );
        throw error;
      }
    })();
  const key = (sort, row) =>
    sort === 'trending'
      ? [row.trendEligible ? 1 : 0, row.trendScore, row.score, row.id]
      : [row.score, row.id];
  let checks = 0;
  const orders = {
    popular: '"decayedPopularity" DESC,"productId" ASC',
    trending:
      '"trendEligible" DESC,CASE WHEN "trendEligible" THEN "trendScore" END DESC NULLS LAST,"decayedPopularity" DESC,"productId" ASC',
    best_selling: '"units28d" DESC,"productId" ASC',
    most_saved: '"savesCount" DESC,"productId" ASC',
  };
  for (const [sort, order] of Object.entries(orders)) {
    // order is an internal closed map, never a request value.
    const oracle = (
      await db.query(
        `SELECT "productId" AS id FROM market_item_feature_snapshots WHERE "epochId"=$1 ORDER BY ${order}`,
        [epochId],
      )
    ).rows.map((row) => row.id);
    const ids = [];
    let after;
    while (true) {
      const rows = await read(sort, after);
      if (!rows.length) break;
      ids.push(...rows.map((row) => row.id));
      after = key(sort, rows[rows.length - 1]);
      assert(
        ids.length <= 200,
        'Frozen keyset must terminate without duplicates',
      );
    }
    assert.deepEqual(
      ids,
      oracle,
      sort + ': complete keyset must match full SQL oracle',
    );
    assert.equal(new Set(ids).size, ids.length);
    checks++;
  }
  const paged = await read('popular');
  const planSql = marketSnapshotPageSql({
    epochId,
    sort: 'popular',
    filters: {},
    now,
    limit: 7,
    after: key('popular', paged[paged.length - 1]),
  });
  const plan = (
    await db.query(
      'EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ' + planSql.text,
      planSql.values,
    )
  ).rows[0]['QUERY PLAN'][0];
  const nodes = [];
  const visit = (node) => {
    nodes.push(node);
    for (const child of node.Plans || []) visit(child);
  };
  visit(plan.Plan);
  assert(
    nodes.some(
      (node) =>
        node['Relation Name'] === 'Product' &&
        node['Index Name'] === 'Product_pkey' &&
        node['Index Cond']?.includes('productId'),
    ),
    'Live eligibility must use a correlated product primary-key lookup',
  );
  assert(
    !nodes.some(
      (node) =>
        node['Relation Name'] === 'Product' &&
        node['Index Name'] === 'Product_market_first_publication_idx',
    ),
    'Frozen-score pagination must not repeatedly traverse the newest-product index',
  );
  assert(
    nodes.some(
      (node) =>
        node['Relation Name'] === 'market_item_feature_snapshots' &&
        node['Index Cond']?.includes('decayedPopularity'),
    ),
    'Frozen-score key bound must participate in the score index',
  );
  checks++;
  const first = (await read('popular'))[0];
  await db.query(
    `UPDATE "Product" SET "publicationStatus"='DRAFT' WHERE "_id"=$1`,
    [first.id],
  );
  assert(
    !(await read('popular')).some((row) => row.id === first.id),
    'Frozen scores never override live publication',
  );
  checks++;
  await db.query(
    `UPDATE "Product" SET "publicationStatus"='PUBLISHED' WHERE "_id"=$1`,
    [first.id],
  );
  assert.equal((await read('popular'))[0].id, first.id);
  assert.equal(
    (await read('popular', undefined, end)).length,
    0,
    'Expired epoch must not be read',
  );
  checks++;
  await db.query(
    `UPDATE market_feature_epochs SET status='BUILDING' WHERE id=$1`,
    [epochId],
  );
  assert.equal(
    (await read('popular')).length,
    0,
    'Incomplete epoch must not be read',
  );
  checks++;
  await db.query(
    `UPDATE market_feature_epochs SET status='READY' WHERE id=$1`,
    [epochId],
  );
  await db.query(
    `UPDATE market_item_feature_snapshots SET coverage='{}' WHERE "productId"=$1`,
    [first.id],
  );
  assert(
    !(await read('popular')).some((row) => row.id === first.id),
    'Missing evidence is not zero',
  );
  checks++;
  await db.query(
    `UPDATE market_item_feature_snapshots SET coverage=$2,"sourcePolicyVersion"=2 WHERE "productId"=$1`,
    [first.id, JSON.stringify(coverage)],
  );
  assert(
    !(await read('popular')).some((row) => row.id === first.id),
    'Policy mismatch must not mix scores',
  );
  checks++;
  await db.query(
    `UPDATE market_item_feature_snapshots SET "sourcePolicyVersion"=1,coverage=jsonb_set(coverage,'{decayedPopularity,requiredWindowStart}',to_jsonb($2::text)) WHERE "productId"=$1`,
    [first.id, new Date(now.getTime() - 86400000).toISOString()],
  );
  assert(
    !(await read('popular')).some((row) => row.id === first.id),
    'One day of evidence cannot claim 28 days',
  );
  checks++;
  // These are an intentionally minimal reader fixture. G3's separate full-schema
  // suite proves READY immutability/publication guards, not this fixture's updates.
  await db.query(
    'DROP TABLE market_item_feature_snapshots; DROP TABLE market_feature_epochs',
  );
  return checks;
};
