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
      const result = await this.prisma.refreshToken.deleteMany({
        where: { expiresAt: { lt: new Date() } },
      });
      if (result.count > 0) {
        this.logger.log(`Pruned ${result.count} expired refresh sessions`);
      }
    } catch (error: any) {
      this.logger.warn(
        `Failed to prune expired refresh sessions: ${error?.message ?? error}`,
      );
    }
  }
}

