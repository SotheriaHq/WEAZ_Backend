/**
 * audit-enum-values.js
 *
 * Run this before adding enum constraints to the schema.
 * It tells you every distinct value currently stored in fields
 * that are about to become enums.
 *
 * HOW TO RUN (from inside the bthreadly/ folder):
 *   node scripts/audit-enum-values.js
 *
 * OUTPUT: prints a JSON summary to the terminal.
 * Share the output with the engineer writing the migration.
 */

'use strict';

const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient({
  log: ['error'],
});

async function main() {
  const [
    attemptStatuses,
    attemptProviders,
    paymentEventTypes,
    paymentEventSources,
    payoutEventTypes,
    payoutEventSources,
    payoutProviderTransferStatuses,
    payoutProviders,
  ] = await Promise.all([
    prisma.$queryRaw`SELECT DISTINCT status AS value FROM "PaymentAttempt" WHERE status IS NOT NULL ORDER BY status`,
    prisma.$queryRaw`SELECT DISTINCT provider AS value FROM "PaymentAttempt" WHERE provider IS NOT NULL ORDER BY provider`,
    prisma.$queryRaw`SELECT DISTINCT type AS value FROM "PaymentEvent" WHERE type IS NOT NULL ORDER BY type`,
    prisma.$queryRaw`SELECT DISTINCT source AS value FROM "PaymentEvent" WHERE source IS NOT NULL ORDER BY source`,
    prisma.$queryRaw`SELECT DISTINCT type AS value FROM "PayoutEvent" WHERE type IS NOT NULL ORDER BY type`,
    prisma.$queryRaw`SELECT DISTINCT source AS value FROM "PayoutEvent" WHERE source IS NOT NULL ORDER BY source`,
    prisma.$queryRaw`SELECT DISTINCT "providerTransferStatus" AS value FROM "Payout" WHERE "providerTransferStatus" IS NOT NULL ORDER BY "providerTransferStatus"`,
    prisma.$queryRaw`SELECT DISTINCT provider AS value FROM "Payout" WHERE provider IS NOT NULL ORDER BY provider`,
  ]);

  const extract = (rows) => rows.map((r) => r.value);

  const result = {
    'PaymentAttempt.status':             extract(attemptStatuses),
    'PaymentAttempt.provider':           extract(attemptProviders),
    'PaymentEvent.type':                 extract(paymentEventTypes),
    'PaymentEvent.source':               extract(paymentEventSources),
    'PayoutEvent.type':                  extract(payoutEventTypes),
    'PayoutEvent.source':                extract(payoutEventSources),
    'Payout.providerTransferStatus':     extract(payoutProviderTransferStatuses),
    'Payout.provider':                   extract(payoutProviders),
  };

  console.log('\n=== ENUM AUDIT RESULTS ===\n');
  console.log(JSON.stringify(result, null, 2));
  console.log('\n=== END OF AUDIT ===\n');
  console.log('Copy the output above and share it before writing the schema migration.\n');
}

main()
  .catch((err) => {
    console.error('Audit failed:', err.message);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
