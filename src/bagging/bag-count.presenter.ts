import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import type { BagCountContract } from './bagging.types';

@Injectable()
export class BagCountPresenter {
  private readonly logger = new Logger(BagCountPresenter.name);

  constructor(private readonly prisma: PrismaService) {}

  async getCount(userId: string): Promise<BagCountContract> {
    const startedAt = Date.now();
    try {
      const [standardItems, customLineCount] = await Promise.all([
        this.prisma.cartItem.findMany({
          where: { userId },
          select: { quantity: true },
        }),
        this.prisma.customOrderCheckoutSession.count({
          where: {
            buyerId: userId,
            customOrderId: null,
          },
        }),
      ]);

      const standardQuantity = standardItems.reduce(
        (sum, item) => sum + Math.max(0, Number(item.quantity) || 0),
        0,
      );

      return {
        standardQuantity,
        customLineCount,
        combinedCount: standardQuantity + customLineCount,
      };
    } finally {
      if (this.shouldLogTiming()) {
        this.logger.debug({
          event: 'bagging.count.duration',
          durationMs: Date.now() - startedAt,
          userId,
        });
      }
    }
  }

  private shouldLogTiming(): boolean {
    const explicitFlag = String(process.env.BAGGING_OBSERVABILITY || '').toLowerCase();
    return explicitFlag === 'true' || explicitFlag === '1' || process.env.NODE_ENV !== 'production';
  }
}
