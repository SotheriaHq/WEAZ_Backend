import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ContentTarget } from '@prisma/client';

function startOfUTCDay(d: Date): Date {
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0),
  );
}

@Injectable()
export class AnalyticsService {
  constructor(private prisma: PrismaService) {}

  async updateDailyThread(
    contentType: ContentTarget,
    contentId: string,
    delta: number,
  ) {
    const day = startOfUTCDay(new Date());
    await this.prisma.dailyThreadAggregate.upsert({
      where: {
        contentType_contentId_date: {
          contentType,
          contentId,
          date: day,
        } as any,
      },
      update: { count: { increment: delta } },
      create: { contentType, contentId, date: day, count: Math.max(0, delta) },
    });
  }

  async getDailyThreads(
    contentType: ContentTarget,
    contentId: string,
    from: Date,
    to: Date,
  ) {
    const list = await this.prisma.dailyThreadAggregate.findMany({
      where: {
        contentType,
        contentId,
        date: { gte: startOfUTCDay(from), lte: startOfUTCDay(to) },
      },
      orderBy: { date: 'asc' },
    });
    return list;
  }
}
