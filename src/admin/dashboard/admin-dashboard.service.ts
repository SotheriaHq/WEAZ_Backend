import { Injectable } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { BrandVerificationStatus } from '@prisma/client';

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
      this.prisma.user.count(),
      this.prisma.user.count({ where: { updatedAt: { gte: thirtyDaysAgo } } }),
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
        select: {
          id: true,
          action: true,
          targetType: true,
          targetId: true,
          createdAt: true,
          actorUserId: true,
        },
      }),
    ]);

    return {
      totalUsers,
      activeUsers30d,
      totalBrands,
      pendingVerifications,
      pendingPayouts,
      openDisputes,
      recentAuditLogs: recentLogs,
    };
  }
}
