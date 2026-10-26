import { Injectable, NotFoundException } from '@nestjs/common';
import { BrandSubscription, Prisma, SubscriptionTierKey } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SUBSCRIPTION_TIER_ORDER as TIER_ORDER } from '../subscriptions/subscription-tiers';

type AgreementProjection = Pick<BrandSubscription, 'tierKey' | 'status' | 'currentPeriodEnd' | 'priceSnapshotNgn'>;
type CommerceState = { customerMinimumOrders: number; availableTiers: SubscriptionTierKey[] } & {
  [Key in keyof AgreementProjection]: AgreementProjection[Key] | null;
};

@Injectable()
export class BrandCommerceAccessService {
  constructor(private readonly prisma: PrismaService) {}

  async get(brandId: string, asOf?: Date) {
    const [state] = await this.prisma.$queryRaw<CommerceState[]>(Prisma.sql`
      SELECT b."customerMinimumOrders", s."tierKey", s.status, s."currentPeriodEnd", s."priceSnapshotNgn",
        ARRAY(SELECT t.key::text FROM "SubscriptionTier" t WHERE t.key::text IN (${Prisma.join(TIER_ORDER)})) AS "availableTiers"
      FROM "Brand" b LEFT JOIN LATERAL (
        SELECT "tierKey", status, "currentPeriodEnd", "priceSnapshotNgn" FROM "BrandSubscription"
        WHERE "brandId" = b."_id" AND status IN ('ACTIVE', 'PAST_DUE') ORDER BY "createdAt" DESC LIMIT 1
      ) s ON TRUE WHERE b."_id" = ${brandId}::uuid
    `);
    if (!state) throw new NotFoundException('Brand not found');
    // A slow query must not grant access using the time before it started.
    const now = asOf ?? new Date();
    const active =
      state.status === 'ACTIVE' && state.tierKey !== null && state.currentPeriodEnd !== null && state.currentPeriodEnd > now;
    const paid = Boolean(active && (state.priceSnapshotNgn ?? 0) > 0);
    const tierKey = active ? state.tierKey! : 'FREE';
    const currentTierIndex = active ? TIER_ORDER.indexOf(state.tierKey!) : -1;
    return {
      tierKey,
      canUpgrade:
        state.availableTiers.some(
          (tier) => TIER_ORDER.indexOf(tier) > currentTierIndex,
        ),
      canConfigureCustomers: paid,
      customerMinimumOrders: state.customerMinimumOrders,
      effectiveMinimumOrders: paid ? state.customerMinimumOrders : 1,
      serverNow: now.toISOString(),
      entitlementExpiresAt: active ? state.currentPeriodEnd!.toISOString() : null,
    };
  }
}
