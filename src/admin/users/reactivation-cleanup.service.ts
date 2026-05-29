import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from 'src/prisma/prisma.service';
import { ReactivationRequestStatus } from '@prisma/client';

@Injectable()
export class ReactivationCleanupService {
  private readonly logger = new Logger(ReactivationCleanupService.name);

  constructor(private readonly prisma: PrismaService) {}

  @Cron(CronExpression.EVERY_DAY_AT_1AM)
  async pruneReviewedRequests() {
    try {
      const reviewedCutoff = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000);
      const result = await this.prisma.accountReactivationRequest.deleteMany({
        where: {
          status: {
            in: [
              ReactivationRequestStatus.APPROVED,
              ReactivationRequestStatus.REJECTED,
            ],
          },
          reviewedAt: { lt: reviewedCutoff },
        },
      });

      if (result.count > 0) {
        this.logger.log(
          `Pruned ${result.count} old reviewed reactivation requests`,
        );
      }
    } catch (error: any) {
      this.logger.warn(
        `Failed to prune reactivation requests: ${error?.message ?? error}`,
      );
    }
  }
}
