import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { AdminAuditAction, NotificationType } from '@prisma/client';
import { v4 as uuidv4 } from 'uuid';
import { Request } from 'express';
import { NotificationsService } from 'src/notifications/notifications.service';
import {
  emptyAdminCatalogFilterMetadata,
  loadAdminCatalogFilters,
} from '../catalog-metadata.helper';

@Injectable()
export class AdminProductsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications?: NotificationsService,
  ) {}

  async list(params: {
    cursor?: string;
    limit?: number;
    search?: string;
    brandId?: string;
    isActive?: boolean;
  }) {
    const take = Math.min(params.limit ?? 50, 100);
    const where: Record<string, unknown> = {
      deletedAt: null,
    };

    if (params.search) {
      where.OR = [
        { name: { contains: params.search, mode: 'insensitive' } },
        { description: { contains: params.search, mode: 'insensitive' } },
      ];
    }
    if (params.brandId) where.brandId = params.brandId;
    if (params.isActive !== undefined) where.isActive = params.isActive;

    const items = await this.prisma.product.findMany({
      where,
      select: {
        id: true,
        name: true,
        description: true,
        categoryId: true,
        categoryTypeId: true,
        gender: true,
        tags: true,
        brandId: true,
        isActive: true,
        isFeatured: true,
        price: true,
        salePrice: true,
        currency: true,
        thumbnail: true,
        images: true,
        _count: {
          select: {
            orderItems: true,
          },
        },
        createdAt: true,
        updatedAt: true,
        brand: {
          select: {
            id: true,
            name: true,
          },
        },
        category: {
          select: {
            id: true,
            slug: true,
            name: true,
          },
        },
        categoryType: {
          select: {
            id: true,
            categoryId: true,
            slug: true,
            name: true,
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
    const filterMetadata = await loadAdminCatalogFilters(
      this.prisma,
      'PRODUCT',
      results.map((item) => item.id),
    );

    return {
      items: results.map((item) => ({
        ...item,
        orderCount: item._count?.orderItems ?? 0,
        primaryMediaUrl:
          item.thumbnail || (item.images?.length ? item.images[0] : null),
        taxonomy: {
          garmentCategory: item.category ?? null,
          garmentSubcategory: item.categoryType ?? null,
          audience: item.gender ?? null,
          hashtags: item.tags ?? [],
          discoveryMetadata:
            filterMetadata.get(item.id) ?? emptyAdminCatalogFilterMetadata(),
        },
      })),
      nextCursor,
    };
  }

  async moderate(
    productId: string,
    dto: {
      isActive?: boolean;
      action?: 'UNPUBLISH' | 'REPUBLISH' | 'HARD_DELETE';
      reason?: string;
    },
    actorId: string,
    req: Request,
  ) {
    const existing = await this.prisma.product.findUnique({
      where: { id: productId },
      select: {
        id: true,
        name: true,
        isActive: true,
        brand: {
          select: {
            ownerId: true,
          },
        },
      },
    });
    if (!existing) throw new NotFoundException('Product not found');

    const action =
      dto.action ??
      (dto.isActive === false
        ? 'UNPUBLISH'
        : dto.isActive === true
          ? 'REPUBLISH'
          : undefined);
    const updateData: Record<string, unknown> = {};
    if (action === 'UNPUBLISH') updateData.isActive = false;
    if (action === 'REPUBLISH') updateData.isActive = true;
    if (!action && dto.isActive !== undefined)
      updateData.isActive = dto.isActive;

    const updated = await this.prisma.$transaction(async (tx) => {
      if (action === 'HARD_DELETE') {
        const deleted = await tx.product.delete({
          where: { id: productId },
          select: {
            id: true,
            name: true,
          },
        });

        await (tx as any).adminAuditLog.create({
          data: {
            id: uuidv4(),
            actorUserId: actorId,
            action: AdminAuditAction.ADMIN_PRODUCT_MODERATE,
            targetType: 'Product',
            targetId: productId,
            previousState: {
              isActive: existing.isActive,
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
          isActive: false,
          updatedAt: new Date(),
        };
      }

      const product = await tx.product.update({
        where: { id: productId },
        data: updateData,
        select: {
          id: true,
          name: true,
          isActive: true,
          updatedAt: true,
        },
      });

      await (tx as any).adminAuditLog.create({
        data: {
          id: uuidv4(),
          actorUserId: actorId,
          action: AdminAuditAction.ADMIN_PRODUCT_MODERATE,
          targetType: 'Product',
          targetId: productId,
          previousState: {
            isActive: existing.isActive,
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

      return product;
    });

    if (
      this.notifications &&
      existing.brand?.ownerId &&
      existing.brand.ownerId !== actorId &&
      (action === 'UNPUBLISH' || action === 'HARD_DELETE')
    ) {
      try {
        const reasonText = dto.reason?.trim();
        const verb = action === 'HARD_DELETE' ? 'deleted' : 'unpublished';
        const reasonSuffix = reasonText ? ` Reason: ${reasonText}` : '';
        await this.notifications.create(
          existing.brand.ownerId,
          NotificationType.ADMIN_ACTION,
          {
            actorId,
            payload: {
              targetType: 'PRODUCT',
              targetId: productId,
              message: `Admin ${verb} your product "${existing.name}".${reasonSuffix}`,
              reason: reasonText,
            },
          },
        );
      } catch {}
    }

    return updated;
  }
}
