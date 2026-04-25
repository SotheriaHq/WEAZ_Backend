import {
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { AdminAuditAction, CollectionStatus, NotificationType } from '@prisma/client';
import { v4 as uuidv4 } from 'uuid';
import { Request } from 'express';
import { NotificationsService } from 'src/notifications/notifications.service';

@Injectable()
export class AdminCollectionsService {
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
    };

    if (params.search) {
      where.OR = [
        { title: { contains: params.search, mode: 'insensitive' } },
        { description: { contains: params.search, mode: 'insensitive' } },
      ];
    }
    if (params.ownerId) where.ownerId = params.ownerId;
    if (params.status) where.status = params.status;

    const items = await this.prisma.storeCollection.findMany({
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
        owner: {
          select: {
            id: true,
            email: true,
            firstName: true,
            lastName: true,
          },
        },
        products: {
          orderBy: [{ isPrimary: 'desc' }, { orderIndex: 'asc' }],
          take: 1,
          select: {
            product: {
              select: {
                thumbnail: true,
                images: true,
              },
            },
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
    const collectionIds = results.map((item) => item.id);
    const links =
      collectionIds.length > 0
        ? await this.prisma.storeCollectionProduct.findMany({
            where: { collectionId: { in: collectionIds } },
            select: {
              collectionId: true,
              productId: true,
            },
          })
        : [];
    const productIds = Array.from(new Set(links.map((link) => link.productId)));
    const orderCountsByProductId =
      productIds.length > 0
        ? await this.prisma.orderItem.groupBy({
            by: ['productId'],
            where: {
              productId: { in: productIds },
            },
            _count: {
              _all: true,
            },
          })
        : [];
    const productOrderCountMap = new Map(
      orderCountsByProductId.map((row) => [row.productId, row._count._all]),
    );
    const collectionOrderCountMap = new Map<string, number>();
    for (const link of links) {
      const previous = collectionOrderCountMap.get(link.collectionId) ?? 0;
      const productCount = productOrderCountMap.get(link.productId) ?? 0;
      collectionOrderCountMap.set(link.collectionId, previous + productCount);
    }

    return {
      items: results.map((item) => {
        const firstProduct = item.products[0]?.product;
        const coverImage =
          firstProduct?.thumbnail ??
          (Array.isArray(firstProduct?.images)
            ? firstProduct.images.find(
                (image) => typeof image === 'string' && image.trim().length > 0,
              ) ?? null
            : null);
        return {
          ...item,
          coverImage,
          orderCount: collectionOrderCountMap.get(item.id) ?? 0,
        };
      }),
      nextCursor,
    };
  }

  async moderate(
    collectionId: string,
    dto: {
      status?: CollectionStatus;
      action?: 'UNPUBLISH' | 'REPUBLISH' | 'HARD_DELETE';
      reason?: string;
    },
    actorId: string,
    req: Request,
  ) {
    const existing = await this.prisma.storeCollection.findUnique({
      where: { id: collectionId },
      select: {
        id: true,
        title: true,
        ownerId: true,
        status: true,
      },
    });
    if (!existing) throw new NotFoundException('Collection not found');

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
        const deleted = await tx.storeCollection.delete({
          where: { id: collectionId },
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
            targetType: 'StoreCollection',
            targetId: collectionId,
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
          status: 'ARCHIVED',
          updatedAt: new Date(),
        };
      }

      const collection = await tx.storeCollection.update({
        where: { id: collectionId },
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
          targetType: 'StoreCollection',
          targetId: collectionId,
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

      return collection;
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
            targetType: 'STORE_COLLECTION',
            targetId: collectionId,
            message: `Admin ${verb} your collection "${existing.title ?? 'Untitled'}".${reasonSuffix}`,
            reason: reasonText,
          },
        });
      } catch {}
    }

    return updated;
  }
}
