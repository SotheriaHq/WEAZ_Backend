import { PayoutStatus } from '@prisma/client';
import { AdminDashboardService } from './admin-dashboard.service';

describe('AdminDashboardService', () => {
  const createService = () => {
    const prisma = {
      user: {
        count: jest.fn().mockResolvedValue(0),
        findMany: jest.fn().mockResolvedValue([]),
      },
      brand: {
        count: jest.fn().mockResolvedValue(0),
      },
      payout: {
        count: jest.fn().mockResolvedValue(0),
      },
      dispute: {
        count: jest.fn().mockResolvedValue(0),
      },
      order: {
        count: jest.fn().mockResolvedValue(0),
      },
      customOrder: {
        count: jest.fn().mockResolvedValue(0),
      },
      design: {
        count: jest.fn().mockResolvedValue(0),
      },
      adminAuditLog: {
        findMany: jest.fn().mockResolvedValue([]),
      },
      collection: {
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
      },
      product: {
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
      },
    };
    const systemConfigService = {
      getBoolean: jest.fn().mockResolvedValue(false),
    };

    return {
      prisma,
      service: new AdminDashboardService(
        prisma as any,
        systemConfigService as any,
      ),
    };
  };

  it('counts pending payouts using only valid PayoutStatus enum values', async () => {
    const { prisma, service } = createService();

    await service.getStats();

    expect(prisma.payout.count).toHaveBeenCalledWith({
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
    });
  });

  it('returns a cheap live-badges payload without full stats fan-out', async () => {
    const { prisma, service } = createService();
    prisma.customOrder.count.mockResolvedValue(3);
    prisma.dispute.count.mockResolvedValue(2);
    prisma.payout.count.mockResolvedValue(1);
    prisma.brand.count.mockResolvedValue(4);
    prisma.order.count.mockResolvedValue(5);

    const badges = await service.getLiveBadges();

    expect(badges).toEqual({
      customOrdersNeedingAttention: 3,
      openDisputes: 2,
      pendingPayouts: 1,
      pendingVerifications: 4,
      ordersNeedingAttention: 5,
    });
    expect(prisma.user.count).not.toHaveBeenCalled();
    expect(prisma.design.count).not.toHaveBeenCalled();
  });
});
