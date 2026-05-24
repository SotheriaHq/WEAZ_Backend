import { Injectable } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { ResetFeedPreferencesDto } from './dto/feed-preferences.dto';

@Injectable()
export class FeedPreferencesService {
  constructor(private readonly prisma: PrismaService) {}

  resetFeedPreferences(userId: string, dto: ResetFeedPreferencesDto) {
    const resetAt = new Date();
    return this.prisma.personalizationReset.create({
      data: {
        userId,
        resetAt,
        resetType: dto.resetType,
        reason: dto.reason?.trim() || null,
      },
    });
  }
}
