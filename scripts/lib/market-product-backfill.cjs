const assert = require('node:assert/strict');

const needsRepair = `("effectivePriceComputedAt" IS NULL OR "effectivePrice" IS NULL OR "priceChangeXid" IS NULL OR
  ("firstPublishedAt" IS NULL AND "publicationStatus"='PUBLISHED' AND "isActive"
    AND "deletedAt" IS NULL AND "archivedAt" IS NULL))`;

/** Bounded, resumable expansion backfill; never rewrites a payment or quote. */
async function backfillMarketProducts(db, options = {}) {
  const {
    batchSize = 500,
    maxBatches = 20,
    after = null,
    apply = false,
  } = options;
  assert(Number.isInteger(batchSize) && batchSize >= 1 && batchSize <= 2000);
  assert(Number.isInteger(maxBatches) && maxBatches >= 1 && maxBatches <= 1000);
  assert(
    after === null ||
      /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
        after,
      ),
  );
  let cursor = after,
    scanned = 0,
    written = 0;
  for (let batch = 0; batch < maxBatches; batch += 1) {
    await db.query('BEGIN');
    try {
      await db.query(
        "SET LOCAL lock_timeout='2s'; SET LOCAL statement_timeout='15s'",
      );
      const rows = (
        await db.query(
          `SELECT "_id" AS id,
        (price>=0 AND price<'Infinity'::numeric
          AND ("salePrice" IS NULL OR ("salePrice">=0 AND "salePrice"<'Infinity'::numeric))
          AND ("saleStartAt" IS NULL OR isfinite("saleStartAt"))
          AND ("saleEndAt" IS NULL OR isfinite("saleEndAt"))
          AND isfinite("createdAt") AND ("publishAt" IS NULL OR isfinite("publishAt"))) AS valid
        FROM "Product" WHERE ${needsRepair}
          AND ($1::uuid IS NULL OR "_id">$1::uuid)
        ORDER BY "_id" LIMIT $2 ${apply ? 'FOR UPDATE' : ''}`,
          [cursor, batchSize],
        )
      ).rows;
      if (rows.some((row) => row.valid !== true)) {
        throw new Error(
          'Invalid historical price/publication data: repair explicitly before continuing this backfill',
        );
      }
      scanned += rows.length;
      if (apply && rows.length) {
        // The publication trigger labels existing due rows INFERRED and assigns
        // a future schedule provisionally. The price trigger captures one clock.
        const result = await db.query(
          `UPDATE "Product" SET
          "effectivePriceComputedAt"=NULL
          WHERE "_id"=ANY($1::uuid[]) AND ${needsRepair}`,
          [rows.map((row) => row.id)],
        );
        written += result.rowCount;
      }
      await db.query('COMMIT');
      if (rows.length) cursor = rows[rows.length - 1].id;
      if (rows.length < batchSize)
        return { apply, scanned, written, after: cursor, exhausted: true };
    } catch (error) {
      await db.query('ROLLBACK');
      throw error;
    }
  }
  return { apply, scanned, written, after: cursor, exhausted: false };
}

module.exports = { backfillMarketProducts };
