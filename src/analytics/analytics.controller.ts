import { Controller, Get, Query } from '@nestjs/common';
import { AnalyticsService } from './analytics.service';
import { ApiTags } from '@nestjs/swagger';
import { ContentTarget } from '@prisma/client';

@ApiTags('analytics')
@Controller('analytics')
export class AnalyticsController {
  constructor(private analytics: AnalyticsService) {}

  @Get('likes')
  async likes(
    @Query('contentType') contentType: ContentTarget,
    @Query('contentId') contentId: string,
    @Query('from') from: string,
    @Query('to') to: string,
  ) {
    const fromDate = from
      ? new Date(from)
      : new Date(Date.now() - 7 * 86400000);
    const toDate = to ? new Date(to) : new Date();
    return this.analytics.getDailyLikes(
      contentType,
      contentId,
      fromDate,
      toDate,
    );
  }
}
