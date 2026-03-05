import {
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { AdminAuditAction, CollectionStatus } from '@prisma/client';
import { v4 as uuidv4 } from 'uuid';
import { Request } from 'express';

@Injectable()
export class AdminCollectionsService {
  constructor(private readonly prisma: PrismaService) {}

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
      },
      orderBy: { createdAt: 'desc' },
      take: take + 1,
      ...(params.cursor ? { cursor: { id: params.cursor }, skip: 1 } : {}),
    });

    const hasMore = items.length > take;
    const results = hasMore ? items.slice(0, take) : items;
    const nextCursor = hasMore ? results[results.length - 1]?.id : undefined;

    return { items: results, nextCursor };
  }

  async moderate(
    collectionId: string,
    dto: { status?: CollectionStatus; visibility?: 'PUBLIC' | 'PRIVATE' },
    actorId: string,
    req: Request,
  ) {
    const existing = await this.prisma.storeCollection.findUnique({
      where: { id: collectionId },
      select: {
        id: true,
        status: true,
        visibility: true,
      },
    });
    if (!existing) throw new NotFoundException('Collection not found');

    const updateData: Record<string, unknown> = {};
    if (dto.status !== undefined) updateData.status = dto.status;
    if (dto.visibility !== undefined) updateData.visibility = dto.visibility;

    const updated = await this.prisma.$transaction(async (tx) => {
      const collection = await tx.storeCollection.update({
        where: { id: collectionId },
        data: updateData,
        select: {
          id: true,
          title: true,
          status: true,
          visibility: true,
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
            visibility: existing.visibility,
          },
          newState: updateData,
          ipAddress: req.socket?.remoteAddress ?? null,
          userAgent: req.headers['user-agent'] ?? null,
        },
      });

      return collection;
    });

    return updated;
  }
}
