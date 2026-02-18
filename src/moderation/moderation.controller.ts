import { Body, Controller, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { PrismaService } from 'src/prisma/prisma.service';
import { ContentTarget } from '@prisma/client';

@ApiTags('moderation')
@Controller('moderation')
export class ModerationController {
  constructor(private prisma: PrismaService) {}

  @Post('threads/quarantine')
  async quarantineThreads(
    @Body()
    body: {
      userId: string;
      contentId: string;
      contentType: ContentTarget;
      reason?: string;
    },
  ) {
    await this.prisma.quarantinedThread.create({
      data: {
        userId: body.userId,
        contentId: body.contentId,
        contentType: body.contentType,
        reason: body.reason ?? null,
      },
    });
    return { success: true };
  }

  @Post('threads/bulk-remove')
  async bulkRemoveThreads(
    @Body()
    body: {
      entries: Array<{
        userId: string;
        contentId: string;
        contentType: ContentTarget;
      }>;
    },
  ) {
    for (const e of body.entries ?? []) {
      if (e.contentType === 'COLLECTION') {
        await this.prisma.collectionReaction.deleteMany({
          where: { userId: e.userId, collectionId: e.contentId },
        });
      } else if (e.contentType === 'POST') {
        await this.prisma.thread.deleteMany({
          where: { userId: e.userId, postId: e.contentId },
        });
      }
    }
    return { success: true, removed: body.entries?.length ?? 0 };
  }
}
