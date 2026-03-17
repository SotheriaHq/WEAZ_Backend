import { Injectable, NotFoundException } from '@nestjs/common';
import {
  AdminAuditAction,
  CollectionDomain,
  CollectionStatus,
  NotificationType,
} from '@prisma/client';
import { Request } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { PrismaService } from 'src/prisma/prisma.service';
import { NotificationsService } from 'src/notifications/notifications.service';

@Injectable()
export class AdminDesignsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications?: NotificationsService,
  ) {}

  async list(params: {
    cursor?: string;
    limit?: number;
    search?: string;
    ownerId?: string;
    status?: CollectionStatus;
  }) {
    const take = Math.min(params.limit ?? 50, 100);
    const where: Record<string, unknown> = {
      deletedAt: null,
      domain: CollectionDomain.DESIGN,
    };

    if (params.search) {
      where.OR = [
        { title: { contains: params.search, mode: 'insensitive' } },
        { description: { contains: params.search, mode: 'insensitive' } },
      ];
    }
    if (params.ownerId) where.ownerId = params.ownerId;
    if (params.status) where.status = params.status;

    const items = await this.prisma.collection.findMany({
      where,
      select: {
        id: true,
        title: true,
        description: true,
        status: true,
        visibility: true,
        ownerId: true,
        createdAt: true,
        updatedAt: true,
        coverMedia: {
          select: {
            fileUploadId: true,
            file: {
              select: {
                s3Url: true,
              },
            },
          },
        },
        medias: {
          orderBy: { orderIndex: 'asc' },
          take: 1,
          select: {
            fileUploadId: true,
            file: {
              select: {
                s3Url: true,
              },
            },
          },
        },
        owner: {
          select: {
            id: true,
            email: true,
            firstName: true,
            lastName: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: take + 1,
      ...(params.cursor ? { cursor: { id: params.cursor }, skip: 1 } : {}),
    });

    const hasMore = items.length > take;
    const results = hasMore ? items.slice(0, take) : items;
    const nextCursor = hasMore ? results[results.length - 1]?.id : undefined;
    const designIds = results.map((item) => item.id);
    const groupedOrders =
      designIds.length > 0
        ? await this.prisma.customOrder.groupBy({
            by: ['sourceId'],
            where: {
              sourceType: 'DESIGN',
              sourceId: { in: designIds },
            },
            _count: {
              _all: true,
            },
          })
        : [];
    const orderCountByDesignId = new Map(
      groupedOrders.map((entry) => [entry.sourceId, entry._count._all]),
    );

    return {
      items: results.map((item) => ({
        ...item,
        coverImage:
          item.coverMedia?.file?.s3Url ?? item.medias[0]?.file?.s3Url ?? null,
        coverImageFileId:
          item.coverMedia?.fileUploadId ?? item.medias[0]?.fileUploadId ?? null,
        orderCount: orderCountByDesignId.get(item.id) ?? 0,
      })),
      nextCursor,
    };
  }

  async moderate(
    designId: string,
    dto: {
      status?: CollectionStatus;
      action?: 'UNPUBLISH' | 'REPUBLISH' | 'HARD_DELETE';
      reason?: string;
    },
    actorId: string,
    req: Request,
  ) {
    const existing = await this.prisma.collection.findUnique({
      where: { id: designId },
      select: {
        id: true,
        domain: true,
        title: true,
        ownerId: true,
        status: true,
      },
    });

    if (!existing || existing.domain !== CollectionDomain.DESIGN) {
      throw new NotFoundException('Design not found');
    }

    const action =
      dto.action ??
      (dto.status === 'ARCHIVED'
        ? 'UNPUBLISH'
        : dto.status === 'PUBLISHED'
          ? 'REPUBLISH'
          : undefined);
    const updateData: Record<string, unknown> = {};
    if (action === 'UNPUBLISH') {
      updateData.status = 'ARCHIVED';
      updateData.archivedFromStatus = existing.status;
    }
    if (action === 'REPUBLISH') {
      updateData.status = 'PUBLISHED';
      updateData.archivedFromStatus = null;
    }
    if (!action && dto.status !== undefined) updateData.status = dto.status;

    const updated = await this.prisma.$transaction(async (tx) => {
      if (action === 'HARD_DELETE') {
        const deleted = await tx.collection.delete({
          where: { id: designId },
          select: {
            id: true,
            title: true,
          },
        });

        await (tx as any).adminAuditLog.create({
          data: {
            id: uuidv4(),
            actorUserId: actorId,
            action: AdminAuditAction.ADMIN_COLLECTION_MODERATE,
            targetType: 'Collection',
            targetId: designId,
            previousState: {
              status: existing.status,
            },
            newState: {
              action: 'HARD_DELETE',
              reason: dto.reason?.trim() || null,
            },
            metadata: {
              reason: dto.reason?.trim() || null,
            },
            ipAddress: req.socket?.remoteAddress ?? null,
            userAgent: req.headers['user-agent'] ?? null,
          },
        });

        return {
          ...deleted,
          deleted: true,
          updatedAt: new Date(),
        };
      }

      const design = await tx.collection.update({
        where: { id: designId },
        data: updateData,
        select: {
          id: true,
          title: true,
          status: true,
          updatedAt: true,
        },
      });

      await (tx as any).adminAuditLog.create({
        data: {
          id: uuidv4(),
          actorUserId: actorId,
          action: AdminAuditAction.ADMIN_COLLECTION_MODERATE,
          targetType: 'Collection',
          targetId: designId,
          previousState: {
            status: existing.status,
          },
          newState: {
            ...updateData,
            action: action ?? null,
            reason: dto.reason?.trim() || null,
          },
          metadata: {
            reason: dto.reason?.trim() || null,
          },
          ipAddress: req.socket?.remoteAddress ?? null,
          userAgent: req.headers['user-agent'] ?? null,
        },
      });

      return design;
    });

    if (
      this.notifications &&
      existing.ownerId &&
      existing.ownerId !== actorId &&
      (action === 'UNPUBLISH' || action === 'HARD_DELETE')
    ) {
      try {
        const reasonText = dto.reason?.trim();
        const verb = action === 'HARD_DELETE' ? 'deleted' : 'unpublished';
        const reasonSuffix = reasonText ? ` Reason: ${reasonText}` : '';
        await this.notifications.create(existing.ownerId, NotificationType.ADMIN_ACTION, {
          actorId,
          payload: {
            targetType: 'COLLECTION',
            targetId: designId,
            message: `Admin ${verb} your design "${existing.title ?? 'Untitled'}".${reasonSuffix}`,
            reason: reasonText,
          },
        });
      } catch {}
    }

    return updated;
  }
}
