const { Client } = require('pg');
require('dotenv').config({ quiet: true });

const constraints = [
  ['Product', 'Product_first_publication_provenance_check'],
  ['Product', 'Product_first_publication_finite_check'],
  ['Product', 'Product_publication_source_dates_finite_check'],
  ['Product', 'Product_base_price_finite_check'],
  ['Product', 'Product_sale_price_finite_check'],
  ['Product', 'Product_sale_dates_finite_check'],
  ['Product', 'Product_market_price_cache_ready_check'],
  ['CollectionCategory', 'category_aliases_shape_check'],
  ['CollectionCategoryType', 'category_type_aliases_shape_check'],
  ['CartItem', 'cart_discovery_attribution_shape_check'],
  ['OrderItem', 'order_discovery_attribution_shape_check'],
];

async function main() {
  const url = new URL(process.env.DATABASE_URL || '');
  if (
    process.argv.length !== 3 ||
    process.argv[2] !==
      '--confirm-database=' + decodeURIComponent(url.pathname.slice(1))
  ) {
    throw new Error(
      'Validation requires an explicit matching --confirm-database',
    );
  }
  const db = new Client({ connectionString: url.toString() });
  await db.connect();
  try {
    // Separate bounded transactions: validation does not take a long-lived
    // transaction across all commercial tables, and never changes a record.
    for (const [table, constraint] of constraints) {
      await db.query('BEGIN');
      try {
        await db.query(
          "SET LOCAL lock_timeout='2s'; SET LOCAL statement_timeout='30s'",
        );
        await db.query(
          'ALTER TABLE public."' +
            table +
            '" VALIDATE CONSTRAINT "' +
            constraint +
            '"',
        );
        await db.query('COMMIT');
        console.log('Validated ' + constraint);
      } catch (error) {
        await db.query('ROLLBACK');
        throw error;
      }
    }
  } finally {
    await db.end();
  }
}
main().catch((error) => {
  console.error(error.code || error.message);
  process.exitCode = 1;
});
