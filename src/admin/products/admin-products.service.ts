import {
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { AdminAuditAction } from '@prisma/client';
import { v4 as uuidv4 } from 'uuid';
import { Request } from 'express';

@Injectable()
export class AdminProductsService {
  constructor(private readonly prisma: PrismaService) {}

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
        brandId: true,
        isActive: true,
        isFeatured: true,
        price: true,
        salePrice: true,
        currency: true,
        createdAt: true,
        updatedAt: true,
        brand: {
          select: {
            id: true,
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

    return { items: results, nextCursor };
  }

  async moderate(
    productId: string,
    dto: { isActive?: boolean; isFeatured?: boolean },
    actorId: string,
    req: Request,
  ) {
    const existing = await this.prisma.product.findUnique({
      where: { id: productId },
      select: {
        id: true,
        isActive: true,
        isFeatured: true,
      },
    });
    if (!existing) throw new NotFoundException('Product not found');

    const updateData: Record<string, unknown> = {};
    if (dto.isActive !== undefined) updateData.isActive = dto.isActive;
    if (dto.isFeatured !== undefined) updateData.isFeatured = dto.isFeatured;

    const updated = await this.prisma.$transaction(async (tx) => {
      const product = await tx.product.update({
        where: { id: productId },
        data: updateData,
        select: {
          id: true,
          name: true,
          isActive: true,
          isFeatured: true,
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
            isFeatured: existing.isFeatured,
          },
          newState: updateData,
          ipAddress: req.socket?.remoteAddress ?? null,
          userAgent: req.headers['user-agent'] ?? null,
        },
      });

      return product;
    });

    return updated;
  }
}
