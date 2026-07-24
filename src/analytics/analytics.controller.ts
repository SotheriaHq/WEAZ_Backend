import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AnalyticsService } from './analytics.service';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { ContentTarget } from '@prisma/client';
import { JwtAuthGuard } from 'src/auth/guard/jwt-auth.guard';

const MAX_ANALYTICS_RANGE_MS = 90 * 86400000; // clamp queries to 90 days
const DEFAULT_RANGE_MS = 7 * 86400000;

@ApiTags('analytics')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('analytics')
export class AnalyticsController {
  constructor(private analytics: AnalyticsService) {}

  @Get('threads')
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  async threads(
    @Query('contentType') contentType: ContentTarget,
    @Query('contentId') contentId: string,
    @Query('from') from: string,
    @Query('to') to: string,
  ) {
    const now = Date.now();

    const parsedTo = to ? new Date(to) : new Date(now);
    const toDate = Number.isNaN(parsedTo.getTime()) ? new Date(now) : parsedTo;

    const parsedFrom = from
      ? new Date(from)
      : new Date(toDate.getTime() - DEFAULT_RANGE_MS);
    let fromDate = Number.isNaN(parsedFrom.getTime())
      ? new Date(toDate.getTime() - DEFAULT_RANGE_MS)
      : parsedFrom;

    // Clamp the window so an unbounded/inverted range can't drive an
    // expensive aggregation scan.
    if (fromDate.getTime() > toDate.getTime()) {
      fromDate = new Date(toDate.getTime() - DEFAULT_RANGE_MS);
    }
    if (toDate.getTime() - fromDate.getTime() > MAX_ANALYTICS_RANGE_MS) {
      fromDate = new Date(toDate.getTime() - MAX_ANALYTICS_RANGE_MS);
    }

    return this.analytics.getDailyThreads(
      contentType,
      contentId,
      fromDate,
      toDate,
    );
  }
}
