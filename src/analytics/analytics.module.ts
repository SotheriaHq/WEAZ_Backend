import { Module } from '@nestjs/common';
import { AnalyticsService } from './analytics.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { AnalyticsController } from './analytics.controller';

@Module({
  providers: [AnalyticsService, PrismaService],
  controllers: [AnalyticsController],
  exports: [AnalyticsService],
})
export class AnalyticsModule {}
