import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { PrismaService } from 'src/prisma/prisma.service';
import { ContentTarget, Role } from '@prisma/client';
import { JwtAuthGuard } from 'src/auth/guard/jwt-auth.guard';
import { RolesGuard } from 'src/auth/guard/role.guard';
import { Roles } from 'src/auth/decorator/roles.decorator';
import { ADMIN_PERMISSIONS } from 'src/admin/constants/permissions';
import { RequirePermissions } from 'src/admin/decorators/require-permissions.decorator';
import { AdminPermissionGuard } from 'src/admin/guards/admin-permission.guard';

@ApiTags('moderation')
@ApiBearerAuth()
@Controller('moderation')
@UseGuards(JwtAuthGuard, RolesGuard, AdminPermissionGuard)
@Roles(Role.SuperAdmin, Role.Admin)
export class ModerationController {
  constructor(private prisma: PrismaService) {}

  @Post('threads/quarantine')
  @RequirePermissions(ADMIN_PERMISSIONS.MODERATION_WRITE)
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
  @RequirePermissions(ADMIN_PERMISSIONS.MODERATION_WRITE)
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
