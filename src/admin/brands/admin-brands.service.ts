import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { AdminAuditAction } from '@prisma/client';
import { v4 as uuidv4 } from 'uuid';
import { Request } from 'express';

@Injectable()
export class AdminBrandsService {
  private readonly logger = new Logger(AdminBrandsService.name);

  constructor(private readonly prisma: PrismaService) {}

  async list(params: {
    cursor?: string;
    limit?: number;
    search?: string;
    isStoreOpen?: boolean;
  }) {
    const take = Math.min(params.limit ?? 50, 100);
    const where: Record<string, unknown> = {};

    if (params.search) {
      where.name = { contains: params.search, mode: 'insensitive' };
    }
    if (params.isStoreOpen !== undefined) {
      where.isStoreOpen = params.isStoreOpen;
    }

    const items = await this.prisma.brand.findMany({
      where,
      select: {
        id: true,
        name: true,
        ownerId: true,
        isStoreOpen: true,
        description: true,
        createdAt: true,
        updatedAt: true,
        owner: {
          select: {
            id: true,
            email: true,
            firstName: true,
            lastName: true,
            status: true,
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

  async getById(brandId: string) {
    const brand = await this.prisma.brand.findUnique({
      where: { id: brandId },
      include: {
        owner: {
          select: {
            id: true,
            email: true,
            firstName: true,
            lastName: true,
            status: true,
          },
        },
        policy: true,
      },
    });
    if (!brand) throw new NotFoundException('Brand not found');
    return brand;
  }

  async overrideStoreOpen(
    brandId: string,
    isStoreOpen: boolean,
    actorId: string,
    req: Request,
  ) {
    const brand = await this.prisma.brand.findUnique({
      where: { id: brandId },
      select: { id: true, isStoreOpen: true },
    });
    if (!brand) throw new NotFoundException('Brand not found');

    const updated = await this.prisma.$transaction(async (tx) => {
      const result = await tx.brand.update({
        where: { id: brandId },
        data: { isStoreOpen },
        select: { id: true, name: true, isStoreOpen: true },
      });

      await (tx as any).adminAuditLog.create({
        data: {
          id: uuidv4(),
          actorUserId: actorId,
          action: AdminAuditAction.ADMIN_BRAND_STORE_OVERRIDE,
          targetType: 'Brand',
          targetId: brandId,
          previousState: { isStoreOpen: brand.isStoreOpen },
          newState: { isStoreOpen },
          ipAddress: req.socket?.remoteAddress ?? null,
          userAgent: req.headers['user-agent'] ?? null,
        },
      });

      return result;
    });

    return updated;
  }

  async suspendBrand(
    brandId: string,
    reason: string | undefined,
    actorId: string,
    req: Request,
  ) {
    const brand = await this.prisma.brand.findUnique({
      where: { id: brandId },
      select: { id: true, isStoreOpen: true, ownerId: true },
    });
    if (!brand) throw new NotFoundException('Brand not found');

    const updated = await this.prisma.$transaction(async (tx) => {
      // Force close the store
      const result = await tx.brand.update({
        where: { id: brandId },
        data: { isStoreOpen: false },
        select: { id: true, name: true, isStoreOpen: true },
      });

      // Suspend the brand owner's account
      await tx.user.update({
        where: { id: brand.ownerId },
        data: {
          status: 'SUSPENDED',
          adminSuspendedAt: new Date(),
          adminSuspendedReason: reason ?? 'Brand suspended by admin',
        },
      });

      await (tx as any).adminAuditLog.create({
        data: {
          id: uuidv4(),
          actorUserId: actorId,
          action: AdminAuditAction.ADMIN_BRAND_SUSPEND,
          targetType: 'Brand',
          targetId: brandId,
          previousState: { isStoreOpen: brand.isStoreOpen },
          newState: { isStoreOpen: false, suspended: true, reason },
          ipAddress: req.socket?.remoteAddress ?? null,
          userAgent: req.headers['user-agent'] ?? null,
        },
      });

      return result;
    });

    return updated;
  }
}
