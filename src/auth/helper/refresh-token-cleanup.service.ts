import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from 'src/prisma/prisma.service';

@Injectable()
export class RefreshTokenCleanupService {
  private readonly logger = new Logger(RefreshTokenCleanupService.name);

  constructor(private readonly prisma: PrismaService) {}

  @Cron(CronExpression.EVERY_6_HOURS)
  async pruneExpiredRefreshTokens() {
    try {
      const refreshResult = await this.prisma.refreshToken.deleteMany({
        where: { expiresAt: { lt: new Date() } },
      });
      if (refreshResult.count > 0) {
        this.logger.log(`Pruned ${refreshResult.count} expired refresh sessions`);
      }

      const passwordResetResult = await this.prisma.passwordResetToken.deleteMany(
        {
          where: {
            OR: [
              { expiresAt: { lt: new Date() } },
              {
                usedAt: {
                  lt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
                },
              },
            ],
          },
        },
      );
      if (passwordResetResult.count > 0) {
        this.logger.log(
          `Pruned ${passwordResetResult.count} expired/used password reset tokens`,
        );
      }
    } catch (error: any) {
      this.logger.warn(
        `Failed to prune auth artifacts: ${error?.message ?? error}`,
      );
    }
  }
}
