import { Injectable } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import {
  BrandVerificationStatus,
  CollectionDomain,
  OrderStatus,
  PaymentStatus,
  PayoutStatus,
  Role,
} from '@prisma/client';
import { adminAttentionActiveWhere } from 'src/custom-orders/custom-order-admin-attention';
import { SystemConfigService } from '../system-config/system-config.service';
import {
  adminUserDisplaySelect,
  mapAdminUserDisplay,
} from '../admin-user-display.helper';

@Injectable()
export class AdminDashboardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly systemConfigService: SystemConfigService,
  ) {}

  /**
   * Lightweight live badges for the admin overview poll (20s). Avoids re-running
   * the full stats fan-out (users/brands/designs/…) on every tick.
   */
  async getLiveBadges() {
    const attentionThreshold = new Date();
    attentionThreshold.setDate(attentionThreshold.getDate() - 7);

    const [
      customOrdersNeedingAttention,
      openDisputes,
      pendingPayouts,
      pendingVerifications,
      ordersNeedingAttention,
    ] = await Promise.all([
      this.prisma.customOrder
        .count({ where: adminAttentionActiveWhere() })
        .catch(() => 0),
      this.prisma.dispute.count({
        where: { status: { in: ['OPEN', 'ASSIGNED', 'IN_PROGRESS'] } },
      }),
      (this.prisma as any).payout
        .count({
          where: {
            status: {
              in: [
                PayoutStatus.PENDING_APPROVAL,
                PayoutStatus.APPROVED,
                PayoutStatus.PROCESSING,
                PayoutStatus.ON_HOLD,
                PayoutStatus.RECONCILIATION_REVIEW,
              ],
            },
          },
        })
        .catch(() => 0) as Promise<number>,
      this.prisma.brand.count({
        where: { verificationStatus: BrandVerificationStatus.PENDING },
      }),
      this.prisma.order.count({
        where: {
          status: { in: [OrderStatus.PENDING, OrderStatus.PROCESSING] },
          paymentStatus: PaymentStatus.PAID,
          paidAt: { lt: attentionThreshold },
        },
      }),
    ]);

    return {
      customOrdersNeedingAttention,
      openDisputes,
      pendingPayouts,
      pendingVerifications,
      ordersNeedingAttention,
    };
  }

  async getStats() {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const attentionThreshold = new Date();
    attentionThreshold.setDate(attentionThreshold.getDate() - 7);

    const [
      totalUsers,
      activeUsers30d,
      totalBrands,
      pendingVerifications,
      pendingPayouts,
      openDisputes,
      ordersNeedingAttention,
      customOrdersNeedingAttention,
      totalDesigns,
      totalProducts,
      totalCollections,
      recentAuditLogs,
      recentUsers,
      dailySignupCount,
      showDailySignupCount,
    ] = await Promise.all([
      this.prisma.user.count({ where: { role: { not: Role.SuperAdmin } } }),
      this.prisma.user.count({
        where: {
          role: { not: Role.SuperAdmin },
          updatedAt: { gte: thirtyDaysAgo },
        },
      }),
      this.prisma.brand.count(),
      this.prisma.brand.count({
        where: { verificationStatus: BrandVerificationStatus.PENDING },
      }),
      (this.prisma as any).payout
        .count({
          where: {
            status: {
              in: [
                PayoutStatus.PENDING_APPROVAL,
                PayoutStatus.APPROVED,
                PayoutStatus.PROCESSING,
                PayoutStatus.ON_HOLD,
                PayoutStatus.RECONCILIATION_REVIEW,
              ],
            },
          },
        })
        .catch(() => 0) as Promise<number>,
      this.prisma.dispute.count({
        where: { status: { in: ['OPEN', 'ASSIGNED', 'IN_PROGRESS'] } },
      }),
      // Cheap fulfilment-attention proxy: paid orders still unshipped after a
      // wall-clock week (indexed count; no per-order business-hours math, so it
      // stays cheap under dashboard polling).
      this.prisma.order.count({
        where: {
          status: { in: [OrderStatus.PENDING, OrderStatus.PROCESSING] },
          paymentStatus: PaymentStatus.PAID,
          paidAt: { lt: attentionThreshold },
        },
      }),
      // Custom orders flagged for admin review that are still actionable
      // (excludes terminal/anonymized rows so the badge cannot drift).
      this.prisma.customOrder
        .count({ where: adminAttentionActiveWhere() })
        .catch(() => 0),
      // Content counts (non-deleted), counted by CANONICAL DOMAIN — not by
      // table — because designs still live (in legacy/dual write mode) as
      // Collection rows with domain=DESIGN, while true store collections are
      // domain=STORE. Counting the tables directly conflated the two (designs
      // showed 0; "collections" inflated by every legacy design-collection).
      //   designs      = DESIGN-domain collections
      //   collections  = STORE-domain collections only
      this.prisma.collection.count({
        where: { domain: CollectionDomain.DESIGN, deletedAt: null },
      }),
      this.prisma.product.count({ where: { deletedAt: null } }),
      this.prisma.collection.count({
        where: { domain: CollectionDomain.STORE, deletedAt: null },
      }),
      this.prisma.adminAuditLog.findMany({
        take: 10,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.user.findMany({
        where: { role: { not: Role.SuperAdmin } },
        take: 10,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          createdAt: true,
        },
      }),
      this.prisma.user.count({
        where: {
          role: { not: Role.SuperAdmin },
          createdAt: { gte: startOfToday },
        },
      }),
      this.systemConfigService.getBoolean(
        'admin.dashboard.showDailySignupCount',
      ),
    ]);

    const recentLogs = [
      ...recentAuditLogs,
      ...recentUsers.map((user) => ({
        id: `signup-${user.id}`,
        action: 'USER_SIGNUP',
        targetType: 'USER',
        targetId: user.id,
        createdAt: user.createdAt,
        actorUserId: user.id,
      })),
    ]
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, 10);

    const enriched = await this.enrichRecentLogs(recentLogs);

    return {
      totalUsers,
      activeUsers30d,
      dailySignupCount,
      showDailySignupCount,
      totalBrands,
      pendingVerifications,
      pendingPayouts,
      openDisputes,
      ordersNeedingAttention,
      customOrdersNeedingAttention,
      totalDesigns,
      totalProducts,
      totalCollections,
      recentLogs: enriched,
      recentAuditLogs: enriched,
    };
  }

  private async enrichRecentLogs(
    logs: Array<{
      id: string;
      action: string;
      targetType: string | null;
      targetId: string | null;
      createdAt: Date;
      actorUserId: string;
    }>,
  ) {
    // Collect actor IDs + target IDs by type for batch lookup
    const actorIds = new Set<string>();
    const userIds = new Set<string>();
    const brandIds = new Set<string>();
    const collectionIds = new Set<string>();
    const productIds = new Set<string>();

    for (const log of logs) {
      actorIds.add(log.actorUserId);
      if (!log.targetId) continue;
      const t = (log.targetType || '').toLowerCase();
      if (t === 'user') userIds.add(log.targetId);
      else if (t === 'brand') brandIds.add(log.targetId);
      else if (t === 'collection') collectionIds.add(log.targetId);
      else if (t === 'product') productIds.add(log.targetId);
    }

    // Batch-fetch actors and target entities
    const [actors, users, brands, collections, products] = await Promise.all([
      actorIds.size > 0
        ? this.prisma.user.findMany({
            where: { id: { in: [...actorIds] } },
            select: adminUserDisplaySelect,
          })
        : [],
      userIds.size > 0
        ? this.prisma.user.findMany({
            where: { id: { in: [...userIds] } },
            select: adminUserDisplaySelect,
          })
        : [],
      brandIds.size > 0
        ? this.prisma.brand.findMany({
            where: { id: { in: [...brandIds] } },
            select: {
              id: true,
              name: true,
              verificationStatus: true,
              logo: true,
            },
          })
        : [],
      collectionIds.size > 0
        ? this.prisma.collection.findMany({
            where: { id: { in: [...collectionIds] } },
            select: {
              id: true,
              title: true,
              domain: true,
              coverMedia: {
                select: { file: { select: { s3Url: true } } },
              },
            },
          })
        : [],
      productIds.size > 0
        ? this.prisma.product.findMany({
            where: { id: { in: [...productIds] } },
            select: {
              id: true,
              name: true,
              thumbnail: true,
            },
          })
        : [],
    ]);

    const actorMap = new Map(
      actors.map((a) => {
        const display = mapAdminUserDisplay(a);
        return [display.id, display] as const;
      }),
    );
    const userMap = new Map(
      users.map((u) => {
        const display = mapAdminUserDisplay(u);
        return [display.id, display] as const;
      }),
    );
    const brandMap = new Map(brands.map((b) => [b.id, b] as const));
    const collectionMap = new Map(collections.map((c) => [c.id, c] as const));
    const productMap = new Map(products.map((p) => [p.id, p] as const));

    return logs.map((log) => {
      const actor = actorMap.get(log.actorUserId);
      const actorName = actor
        ? `${actor.firstName} ${actor.lastName}`.trim() ||
          actor.username ||
          actor.email ||
          'User'
        : null;
      const actorImage = actor?.profileImageFile?.s3Url ?? null;

      let targetName: string | null = null;
      let targetImage: string | null = null;
      let targetStatus: string | null = null;
      let targetRoute: string | null = null;

      if (log.targetId) {
        const t = (log.targetType || '').toLowerCase();
        if (t === 'user') {
          const u = userMap.get(log.targetId);
          targetName = u
            ? `${u.firstName} ${u.lastName}`.trim() || u.username || 'User'
            : null;
          targetImage = u?.profileImageFile?.s3Url ?? null;
          targetStatus = u?.status ?? null;
          targetRoute = `/admin/users`;
        } else if (t === 'brand') {
          const b = brandMap.get(log.targetId);
          targetName = b?.name ?? null;
          targetImage = b?.logo ?? null;
          targetStatus = b?.verificationStatus ?? null;
          targetRoute = `/admin/brands`;
        } else if (t === 'collection') {
          const c = collectionMap.get(log.targetId);
          targetName = c?.title ?? null;
          targetImage = c?.coverMedia?.file?.s3Url ?? null;
          targetRoute =
            c?.domain === 'DESIGN'
              ? `/admin/content?tab=designs`
              : `/admin/content?tab=collections`;
        } else if (t === 'product') {
          const p = productMap.get(log.targetId);
          targetName = p?.name ?? null;
          targetImage = p?.thumbnail ?? null;
          targetRoute = `/admin/content?tab=products`;
        }
      }

      return {
        id: log.id,
        action: log.action,
        targetType: log.targetType,
        targetId: log.targetId,
        createdAt: log.createdAt,
        actorUserId: log.actorUserId,
        actorName,
        actorImage,
        targetName,
        targetImage,
        targetStatus,
        targetRoute,
      };
    });
  }
}
