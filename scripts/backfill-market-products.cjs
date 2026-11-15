const { Client } = require('pg');
const { backfillMarketProducts } = require('./lib/market-product-backfill.cjs');
require('dotenv').config({ quiet: true });

async function main() {
  const url = new URL(process.env.DATABASE_URL || '');
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const options = { apply };
  for (const argument of args.filter((value) => value !== '--apply')) {
    const match =
      /^--(batch-size|max-batches|after|confirm-database)=(.+)$/.exec(argument);
    if (!match) throw new Error('Unknown or incomplete backfill argument');
    const [, key, value] = match;
    if (key === 'confirm-database') options.confirmDatabase = value;
    else if (key === 'after') options.after = value;
    else
      options[key === 'batch-size' ? 'batchSize' : 'maxBatches'] =
        Number(value);
  }
  if (
    apply &&
    options.confirmDatabase !== decodeURIComponent(url.pathname.slice(1))
  ) {
    throw new Error(
      'Apply requires --confirm-database matching the configured database name',
    );
  }
  const db = new Client({ connectionString: url.toString() });
  await db.connect();
  try {
    console.log(JSON.stringify(await backfillMarketProducts(db, options)));
  } finally {
    await db.end();
  }
}

main().catch((error) => {
  // Driver messages can include connection details; print only the SQL code.
  console.error(error.code || error.message);
  process.exitCode = 1;
});
