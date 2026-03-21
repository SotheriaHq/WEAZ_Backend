import { Injectable } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { BrandVerificationStatus, Role } from '@prisma/client';

@Injectable()
export class AdminDashboardService {
  constructor(private readonly prisma: PrismaService) {}

  async getStats() {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const [
      totalUsers,
      activeUsers30d,
      totalBrands,
      pendingVerifications,
      pendingPayouts,
      openDisputes,
      recentLogs,
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
      this.prisma.payout.count({ where: { status: 'PENDING' } }),
      this.prisma.dispute.count({
        where: { status: { in: ['OPEN', 'ASSIGNED', 'IN_PROGRESS'] } },
      }),
      this.prisma.adminAuditLog.findMany({
        take: 10,
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    // Enrich logs with actor + target entity data
    const enriched = await this.enrichRecentLogs(recentLogs);

    return {
      totalUsers,
      activeUsers30d,
      totalBrands,
      pendingVerifications,
      pendingPayouts,
      openDisputes,
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
            select: {
              id: true,
              firstName: true,
              lastName: true,
              email: true,
              profileImageFile: { select: { s3Url: true } },
            },
          })
        : [],
      userIds.size > 0
        ? this.prisma.user.findMany({
            where: { id: { in: [...userIds] } },
            select: {
              id: true,
              firstName: true,
              lastName: true,
              username: true,
              status: true,
              profileImageFile: { select: { s3Url: true } },
            },
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

    const actorMap = new Map(actors.map((a) => [a.id, a] as const));
    const userMap = new Map(users.map((u) => [u.id, u] as const));
    const brandMap = new Map(brands.map((b) => [b.id, b] as const));
    const collectionMap = new Map(collections.map((c) => [c.id, c] as const));
    const productMap = new Map(products.map((p) => [p.id, p] as const));

    return logs.map((log) => {
      const actor = actorMap.get(log.actorUserId);
      const actorName = actor
        ? `${actor.firstName} ${actor.lastName}`.trim()
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
          targetName = u ? `${u.firstName} ${u.lastName}`.trim() : null;
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
