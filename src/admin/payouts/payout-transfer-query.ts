import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { loadBrandPosition } from 'src/finance/brand-position-query';

/** Same serialization point as payout admission and manual debt adjustments. */
export async function lockPayoutSource(
  tx: Prisma.TransactionClient,
  payoutId: string,
) {
  await tx.$queryRaw`SELECT b."_id" FROM "Brand" b
    WHERE b."_id"=(SELECT p."brandId" FROM "Payout" p WHERE p."_id"=${payoutId}::uuid)
    FOR NO KEY UPDATE OF b`;
  await tx.$queryRaw`SELECT "_id" AS id FROM "Payout" WHERE "_id"=${payoutId}::uuid FOR UPDATE`;
}

export async function claimPayoutTransfer(
  tx: Prisma.TransactionClient,
  payoutId: string,
) {
  const token = randomUUID();
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    UPDATE "Payout" SET "transferLeaseToken"=${token}::uuid,
      "transferLockedAt"=clock_timestamp() AT TIME ZONE 'UTC'
    WHERE "_id"=${payoutId}::uuid AND ("transferLeaseToken" IS NULL OR
      "transferLockedAt" < clock_timestamp() AT TIME ZONE 'UTC'-INTERVAL '10 minutes')
    RETURNING "_id" AS id`;
  if (!rows.length) {
    throw new ConflictException({
      code: 'PAYOUT_TRANSFER_IN_PROGRESS',
      message:
        'A provider request is already in progress. Refresh its status before retrying.',
    });
  }
  return token;
}

/** Recheck after obtaining the brand lock; the reservation already includes this payout. */
export async function assertPayoutPosition(
  tx: Prisma.TransactionClient,
  brandId: string,
  currency: string,
) {
  const { position } = await loadBrandPosition(tx, brandId, currency);
  if (!position.isFinite() || position.isNegative()) {
    throw new ConflictException({
      code: 'PAYOUT_FUNDS_CHANGED',
      message:
        'Available earnings changed after this payout was reserved. Resolve the outstanding balance before transferring.',
    });
  }
}
