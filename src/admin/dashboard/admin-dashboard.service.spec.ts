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
      adminAuditLog: {
        findMany: jest.fn().mockResolvedValue([]),
      },
      collection: {
        findMany: jest.fn().mockResolvedValue([]),
      },
      product: {
        findMany: jest.fn().mockResolvedValue([]),
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
});
