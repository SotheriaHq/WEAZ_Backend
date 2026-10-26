import type {
  Brand,
  BrandSubscription,
  Prisma,
  SubscriptionTier,
  User,
} from '@prisma/client';
import { Prisma as Sql } from '@prisma/client';

type CapacityBrand = Pick<
  Brand,
  | 'id'
  | 'ownerId'
  | 'verificationStatus'
  | 'queuePriorityStreak'
  | 'queueJumpEnabled'
  | 'customOrderIntakeBlockedAt'
  | 'customOrderIntakeBlockReason'
  | 'activeOrderCapOverride'
  | 'activeOrderCapOverrideUntil'
  | 'massCancelAttentionAt'
  | 'assignedSubscriptionTierKey'
>;
type Row = CapacityBrand & {
  ownerStatus: User['status'];
  agreementId: string | null;
  agreementStatus: BrandSubscription['status'] | null;
  agreementPeriodEnd: Date | null;
  tierKey: SubscriptionTier['key'] | null;
  maxActive: number | null;
  maxInDelivery: number | null;
  queueJumpAllowed: boolean | null;
  deltaActive: number | null;
};

/** One fresh capacity projection; callers retain the brand lock for mutations. */
export async function loadQueueCapacityContext(
  db: Pick<Prisma.TransactionClient, '$queryRaw'>,
  brandId: string,
  now: Date,
) {
  const [row] = await db.$queryRaw<Row[]>(Sql.sql`
    SELECT b."_id" AS id, b."ownerId", b."verificationStatus", b."queuePriorityStreak",
      b."queueJumpEnabled", b."customOrderIntakeBlockedAt", b."customOrderIntakeBlockReason",
      b."activeOrderCapOverride", b."activeOrderCapOverrideUntil", b."massCancelAttentionAt",
      b."assignedSubscriptionTierKey", u.status AS "ownerStatus",
      a.id AS "agreementId", a.status AS "agreementStatus", a."currentPeriodEnd" AS "agreementPeriodEnd",
      t.key AS "tierKey", t."maxActive", t."maxInDelivery", t."queueJumpAllowed", c."deltaActive"
    FROM "Brand" b JOIN "User" u ON u."_id" = b."ownerId"
    LEFT JOIN LATERAL (
      SELECT a.id, a.status, a."currentPeriodEnd", a."tierKey"
      FROM "BrandSubscription" a
      WHERE a."brandId" = b."_id" AND a.status IN ('ACTIVE', 'PAST_DUE', 'CANCELLED')
      ORDER BY a."createdAt" DESC, a.id DESC LIMIT 1
    ) a ON true
    LEFT JOIN "SubscriptionTier" t ON t.key = COALESCE(a."tierKey", 'THREAD')
    LEFT JOIN LATERAL (
      SELECT c."deltaActive" FROM "CapacityCampaign" c
      WHERE c."startsAt" <= ${now} AND c."resetAt" IS NULL
        AND (c."resetMode" = 'MANUAL' OR c."endsAt" > ${now})
      ORDER BY c."startsAt" DESC, c.id DESC LIMIT 1
    ) c ON true
    WHERE b."_id" = ${brandId}::uuid
  `);
  if (!row) return null;
  const {
    ownerStatus,
    agreementId,
    agreementStatus,
    agreementPeriodEnd,
    tierKey,
    maxActive,
    maxInDelivery,
    queueJumpAllowed,
    deltaActive,
    ...brand
  } = row;
  return {
    brand: { ...brand, owner: { id: row.ownerId, status: ownerStatus } },
    agreement:
      agreementId && agreementStatus && agreementPeriodEnd
        ? {
            id: agreementId,
            status: agreementStatus,
            currentPeriodEnd: agreementPeriodEnd,
          }
        : null,
    tier: tierKey
      ? {
          key: tierKey,
          maxActive,
          maxInDelivery,
          queueJumpAllowed: Boolean(queueJumpAllowed),
        }
      : null,
    deltaActive: deltaActive ?? 0,
  };
}
