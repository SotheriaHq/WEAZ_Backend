import { Injectable } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import type { BagCountContract } from './bagging.types';

@Injectable()
export class BagCountPresenter {
  constructor(private readonly prisma: PrismaService) {}

  async getCount(userId: string): Promise<BagCountContract> {
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
  }
}
