import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SUBSCRIPTION_TIER_ORDER as TIER_ORDER } from '../subscriptions/subscription-tiers';

@Injectable()
export class BrandCommerceAccessService {
  constructor(private readonly prisma: PrismaService) {}

  async get(brandId: string, now = new Date()) {
    const [brand, agreement, tiers] = await Promise.all([
      this.prisma.brand.findUnique({
        where: { id: brandId },
        select: {
          customerMinimumOrders: true,
          customOrderLegacyEligible: true,
        },
      }),
      this.prisma.brandSubscription.findFirst({
        where: { brandId, status: { in: ['ACTIVE', 'PAST_DUE'] } },
        orderBy: { createdAt: 'desc' },
        select: {
          tierKey: true,
          status: true,
          currentPeriodEnd: true,
          tier: { select: { monthlyPriceNgn: true } },
        },
      }),
      this.prisma.subscriptionTier.findMany({
        where: { key: { in: TIER_ORDER } },
        select: { key: true },
      }),
    ]);
    if (!brand) throw new NotFoundException('Brand not found');
    const active =
      agreement?.status === 'ACTIVE' && agreement.currentPeriodEnd > now;
    const paid = Boolean(active && agreement.tier.monthlyPriceNgn > 0);
    const tierKey = active ? agreement.tierKey : 'FREE';
    const currentTierIndex = active ? TIER_ORDER.indexOf(agreement.tierKey) : -1;
    const legacy = brand.customOrderLegacyEligible || tierKey === 'LEGACY';
    return {
      tierKey,
      canUpgrade:
        !legacy &&
        tiers.some(
          (tier) => TIER_ORDER.indexOf(tier.key) > currentTierIndex,
        ),
      canConfigureCustomers: paid,
      customerMinimumOrders: brand.customerMinimumOrders,
      effectiveMinimumOrders: paid ? brand.customerMinimumOrders : 1,
    };
  }
}
