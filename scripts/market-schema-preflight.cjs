const { Client } = require('pg');
require('dotenv').config({ quiet: true });

async function main() {
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  try {
    await db.query('BEGIN READ ONLY');
    await db.query(
      "SET LOCAL statement_timeout='15s'; SET LOCAL lock_timeout='2s'",
    );
    const environment = (
      await db.query(`SELECT current_database() AS database,
      current_setting('server_version') AS "postgresVersion",current_setting('TimeZone') AS timezone,
      current_setting('server_encoding') AS encoding,
      (SELECT datctype FROM pg_database WHERE datname=current_database()) AS "characterLocale"`)
    ).rows[0];
    const columns = (
      await db.query(
        `SELECT column_name FROM information_schema.columns
      WHERE table_schema='public' AND table_name='Product' AND column_name=ANY($1::text[])`,
        [['firstPublishedAt', 'effectivePriceComputedAt', 'priceChangeXid']],
      )
    ).rows.map((row) => row.column_name);
    const invalidPrices = (
      await db.query(`SELECT count(*)::text AS count FROM "Product" WHERE
      NOT(price>=0 AND price<'Infinity'::numeric)
      OR ("salePrice" IS NOT NULL AND NOT("salePrice">=0 AND "salePrice"<'Infinity'::numeric))
      OR ("saleStartAt" IS NOT NULL AND NOT isfinite("saleStartAt"))
      OR ("saleEndAt" IS NOT NULL AND NOT isfinite("saleEndAt"))`)
    ).rows[0].count;
    const invalidPublicationDates = (
      await db.query(`SELECT count(*)::text AS count FROM "Product"
      WHERE NOT isfinite("createdAt") OR ("publishAt" IS NOT NULL AND NOT isfinite("publishAt"))`)
    ).rows[0].count;
    const indexState = (
      await db.query(
        `SELECT c.relname AS name,i.indisvalid,i.indisready,
      pg_get_indexdef(c.oid) AS definition FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
      WHERE c.relname LIKE 'Product_market_%' OR c.relname=ANY($1::text[]) ORDER BY c.relname`,
        [
          [
            'idx_product_search_vector',
            'idx_product_name_trgm',
            'idx_product_brand_name_cache_trgm',
          ],
        ],
      )
    ).rows;
    const tableOptions = (
      await db.query(
        `SELECT n.nspname AS schema,c.relname AS name,c.reloptions
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'
      AND c.relname=ANY($1::text[]) ORDER BY c.relname`,
        [
          [
            'user_feed_signals',
            'user_seen_items',
            'market_section_signals',
            'suggestion_signals',
            'market_item_features',
          ],
        ],
      )
    ).rows;
    const pendingConstraints = (
      await db.query(`SELECT c.conname AS name,c.conrelid::regclass::text AS "table"
      FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace
      WHERE n.nspname='public' AND NOT c.convalidated ORDER BY c.conname`)
    ).rows;
    await db.query('COMMIT');
    console.log(
      JSON.stringify(
        {
          environment,
          additiveColumnsPresent: columns,
          invalidPrices,
          invalidPublicationDates,
          indexState,
          tableOptions,
          pendingConstraints,
          mutations: false,
          note: 'Presence does not prove completed backfill, capacity or release readiness',
        },
        null,
        2,
      ),
    );
    if (
      invalidPrices !== '0' ||
      invalidPublicationDates !== '0' ||
      indexState.some((index) => !index.indisvalid || !index.indisready)
    )
      process.exitCode = 1;
  } finally {
    await db.query('ROLLBACK');
    await db.end();
  }
}
main().catch((error) => {
  console.error(error.code || 'Schema preflight failed');
  process.exitCode = 1;
});
