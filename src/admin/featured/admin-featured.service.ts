import {
  Injectable,
  BadRequestException,
  NotFoundException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { AdminAuditAction, NotificationType } from '@prisma/client';
import { v4 as uuidv4 } from 'uuid';
import { Request } from 'express';
import { CreateFeaturedDto } from './dto';
import { NotificationsService } from 'src/notifications/notifications.service';
import {
  adminUserDisplaySelect,
  mapAdminUserDisplay,
} from '../admin-user-display.helper';

const FEATURED_DURATION_DAYS = 7;
const MAX_GLOBAL_FEATURED = 10;
const MAX_PER_BRAND = 1;
const PENALTY_MONTHS = 2;

@Injectable()
export class AdminFeaturedService {
  private readonly logger = new Logger(AdminFeaturedService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  // ── Feature an item ──
  async featureItem(
    dto: CreateFeaturedDto,
    actorId: string,
    req: Request,
  ) {
    const { entityType, entityId, startsAt: rawStartsAt, displayImages, useCoverOnly } = dto;

    // Resolve entity + brand
    const { brandId, entityName } = await this.resolveEntity(entityType, entityId);

    const startsAt = rawStartsAt ? new Date(rawStartsAt) : new Date();
    if (startsAt < new Date(Date.now() - 60_000)) {
      throw new BadRequestException('startsAt cannot be in the past');
    }
    const expiresAt = new Date(startsAt.getTime() + FEATURED_DURATION_DAYS * 24 * 60 * 60 * 1000);

    // Eligibility checks
    await this.checkEligibility(entityType, entityId, brandId);

    const id = uuidv4();
    const featured = await this.prisma.$transaction(async (tx) => {
      const item = await tx.featuredItem.create({
        data: {
          id,
          entityType,
          entityId,
          brandId,
          startsAt,
          expiresAt,
          isActive: true,
          featuredById: actorId,
          displayImages: displayImages ?? [],
          useCoverOnly: useCoverOnly ?? true,
        },
        include: {
          brand: { select: { id: true, name: true } },
          featuredBy: { select: adminUserDisplaySelect },
        },
      });

      // Increment brand featured count
      await tx.brand.update({
        where: { id: brandId },
        data: { featuredCount: { increment: 1 } },
      });

      // Sync legacy isFeatured flag on Product
      if (entityType === 'PRODUCT') {
        await tx.product.update({
          where: { id: entityId },
          data: { isFeatured: true },
        });
      }

      // Audit log
      await (tx as any).adminAuditLog.create({
        data: {
          id: uuidv4(),
          actorUserId: actorId,
          action: AdminAuditAction.ADMIN_FEATURED_CREATE,
          targetType: 'FeaturedItem',
          targetId: id,
          newState: {
            entityType,
            entityId,
            brandId,
            startsAt: startsAt.toISOString(),
            expiresAt: expiresAt.toISOString(),
          },
          ipAddress: req.socket?.remoteAddress ?? null,
          userAgent: req.headers['user-agent'] ?? null,
        },
      });

      return item;
    });

    // Notify brand owner
    this.notifyBrandOwner(brandId, NotificationType.ITEM_FEATURED, {
      entityType,
      entityId,
      entityName,
      expiresAt: expiresAt.toISOString(),
      targetUrl: entityType === 'PRODUCT' ? `/products/${entityId}` : `/designs/${entityId}`,
    }).catch((err) => this.logger.warn(`Failed to send ITEM_FEATURED notification: ${err?.message}`));

    return {
      ...featured,
      featuredBy: mapAdminUserDisplay(featured.featuredBy),
      entityName,
    };
  }

  // ── List featured items (admin view) ──
  async list(params: {
    cursor?: string;
    limit?: number;
    status?: 'active' | 'scheduled' | 'expired' | 'all';
    entityType?: string;
    brandId?: string;
  }) {
    const take = Math.min(params.limit ?? 50, 100);
    const now = new Date();
    const where: Record<string, unknown> = {};

    if (params.status === 'active') {
      where.isActive = true;
      where.startsAt = { lte: now };
      where.expiresAt = { gt: now };
    } else if (params.status === 'scheduled') {
      where.isActive = true;
      where.startsAt = { gt: now };
    } else if (params.status === 'expired') {
      where.isActive = false;
    }

    if (params.entityType) where.entityType = params.entityType;
    if (params.brandId) where.brandId = params.brandId;

    const items = await this.prisma.featuredItem.findMany({
      where,
      include: {
        brand: { select: { id: true, name: true, logo: true } },
        featuredBy: { select: adminUserDisplaySelect },
        removedBy: { select: adminUserDisplaySelect },
      },
      orderBy: { createdAt: 'desc' },
      take: take + 1,
      ...(params.cursor ? { cursor: { id: params.cursor }, skip: 1 } : {}),
    });

    const hasMore = items.length > take;
    const results = hasMore ? items.slice(0, take) : items;
    const nextCursor = hasMore ? results[results.length - 1]?.id : undefined;

    // Enrich with entity names
    const enriched = await Promise.all(
      results.map(async (item) => {
        const entityName = await this.getEntityName(item.entityType, item.entityId);
        const entityThumbnail = await this.getEntityThumbnail(item.entityType, item.entityId);
        return {
          ...item,
          featuredBy: mapAdminUserDisplay(item.featuredBy),
          removedBy: mapAdminUserDisplay(item.removedBy),
          entityName,
          entityThumbnail,
        };
      }),
    );

    return { items: enriched, nextCursor };
  }

  // ── Currently active only ──
  async listActive() {
    const now = new Date();
    const items = await this.prisma.featuredItem.findMany({
      where: {
        isActive: true,
        startsAt: { lte: now },
        expiresAt: { gt: now },
      },
      include: {
        brand: { select: { id: true, name: true, logo: true } },
      },
      orderBy: { startsAt: 'asc' },
    });

    return Promise.all(
      items.map(async (item) => {
        const entityName = await this.getEntityName(item.entityType, item.entityId);
        const entityThumbnail = await this.getEntityThumbnail(item.entityType, item.entityId);
        return { ...item, entityName, entityThumbnail };
      }),
    );
  }

  // ── Remove a featured item (manual) ──
  async remove(featuredItemId: string, actorId: string, req: Request) {
    const existing = await this.prisma.featuredItem.findUnique({
      where: { id: featuredItemId },
    });
    if (!existing) throw new NotFoundException('Featured item not found');
    if (!existing.isActive) throw new BadRequestException('Item is already inactive');

    const updated = await this.prisma.$transaction(async (tx) => {
      const item = await tx.featuredItem.update({
        where: { id: featuredItemId },
        data: {
          isActive: false,
          removedById: actorId,
          removedAt: new Date(),
          removeReason: 'MANUAL',
        },
        include: {
          brand: { select: { id: true, name: true } },
        },
      });

      await (tx as any).adminAuditLog.create({
        data: {
          id: uuidv4(),
          actorUserId: actorId,
          action: AdminAuditAction.ADMIN_FEATURED_REMOVE,
          targetType: 'FeaturedItem',
          targetId: featuredItemId,
          previousState: { isActive: true },
          newState: { isActive: false, removeReason: 'MANUAL' },
          ipAddress: req.socket?.remoteAddress ?? null,
          userAgent: req.headers['user-agent'] ?? null,
        },
      });

      // Sync legacy isFeatured flag on Product
      if (existing.entityType === 'PRODUCT') {
        await tx.product.update({
          where: { id: existing.entityId },
          data: { isFeatured: false },
        });
      }

      return item;
    });

    // Notify brand owner of manual removal
    this.notifyBrandOwner(existing.brandId, NotificationType.FEATURED_AUTO_REMOVED, {
      entityType: existing.entityType,
      entityId: existing.entityId,
      reason: 'MANUAL',
    }).catch((err) => this.logger.warn(`Failed to send FEATURED_AUTO_REMOVED notification: ${err?.message}`));

    return updated;
  }

  // ── History (SuperAdmin) ──
  async history(params: {
    cursor?: string;
    limit?: number;
    brandId?: string;
    entityType?: string;
    removeReason?: string;
  }) {
    const take = Math.min(params.limit ?? 50, 100);
    const where: Record<string, unknown> = {};

    if (params.brandId) where.brandId = params.brandId;
    if (params.entityType) where.entityType = params.entityType;
    if (params.removeReason) where.removeReason = params.removeReason;

    const items = await this.prisma.featuredItem.findMany({
      where,
      include: {
        brand: { select: { id: true, name: true } },
        featuredBy: { select: adminUserDisplaySelect },
        removedBy: { select: adminUserDisplaySelect },
      },
      orderBy: { createdAt: 'desc' },
      take: take + 1,
      ...(params.cursor ? { cursor: { id: params.cursor }, skip: 1 } : {}),
    });

    const hasMore = items.length > take;
    const results = hasMore ? items.slice(0, take) : items;
    const nextCursor = hasMore ? results[results.length - 1]?.id : undefined;

    const enriched = await Promise.all(
      results.map(async (item) => {
        const entityName = await this.getEntityName(item.entityType, item.entityId);
        return {
          ...item,
          featuredBy: mapAdminUserDisplay(item.featuredBy),
          removedBy: mapAdminUserDisplay(item.removedBy),
          entityName,
        };
      }),
    );

    return { items: enriched, nextCursor };
  }

  // ── Performance metrics ──
  async getPerformance(featuredItemId: string) {
    const item = await this.prisma.featuredItem.findUnique({
      where: { id: featuredItemId },
      include: {
        brand: { select: { id: true, name: true } },
      },
    });
    if (!item) throw new NotFoundException('Featured item not found');

    const entityName = await this.getEntityName(item.entityType, item.entityId);
    return {
      ...item,
      entityName,
    };
  }

  // ── Toggle featured block (SuperAdmin) ──
  async toggleBlockProduct(productId: string, actorId: string, req: Request) {
    const product = await this.prisma.product.findUnique({
      where: { id: productId },
      select: { id: true, isFeaturedBlocked: true },
    });
    if (!product) throw new NotFoundException('Product not found');

    const newBlocked = !product.isFeaturedBlocked;

    await this.prisma.$transaction(async (tx) => {
      await tx.product.update({
        where: { id: productId },
        data: { isFeaturedBlocked: newBlocked },
      });

      // If blocking and currently featured, auto-remove (no penalty)
      if (newBlocked) {
        await this.autoRemoveByEntity(tx, 'PRODUCT', productId, 'ITEM_BLOCKED', false);
      }

      await (tx as any).adminAuditLog.create({
        data: {
          id: uuidv4(),
          actorUserId: actorId,
          action: AdminAuditAction.ADMIN_FEATURED_BLOCK_TOGGLE,
          targetType: 'Product',
          targetId: productId,
          previousState: { isFeaturedBlocked: product.isFeaturedBlocked },
          newState: { isFeaturedBlocked: newBlocked },
          ipAddress: req.socket?.remoteAddress ?? null,
          userAgent: req.headers['user-agent'] ?? null,
        },
      });
    });

    return { id: productId, isFeaturedBlocked: newBlocked };
  }

  async toggleBlockCollection(collectionId: string, actorId: string, req: Request) {
    const collection = await this.prisma.collection.findUnique({
      where: { id: collectionId },
      select: { id: true, isFeaturedBlocked: true },
    });
    if (!collection) throw new NotFoundException('Collection not found');

    const newBlocked = !collection.isFeaturedBlocked;

    await this.prisma.$transaction(async (tx) => {
      await tx.collection.update({
        where: { id: collectionId },
        data: { isFeaturedBlocked: newBlocked },
      });

      if (newBlocked) {
        await this.autoRemoveByEntity(tx, 'DESIGN', collectionId, 'ITEM_BLOCKED', false);
      }

      await (tx as any).adminAuditLog.create({
        data: {
          id: uuidv4(),
          actorUserId: actorId,
          action: AdminAuditAction.ADMIN_FEATURED_BLOCK_TOGGLE,
          targetType: 'Collection',
          targetId: collectionId,
          previousState: { isFeaturedBlocked: collection.isFeaturedBlocked },
          newState: { isFeaturedBlocked: newBlocked },
          ipAddress: req.socket?.remoteAddress ?? null,
          userAgent: req.headers['user-agent'] ?? null,
        },
      });
    });

    return { id: collectionId, isFeaturedBlocked: newBlocked };
  }

  async toggleBlockBrand(brandId: string, actorId: string, req: Request) {
    const brand = await this.prisma.brand.findUnique({
      where: { id: brandId },
      select: { id: true, isFeaturedBlocked: true },
    });
    if (!brand) throw new NotFoundException('Brand not found');

    const newBlocked = !brand.isFeaturedBlocked;

    await this.prisma.$transaction(async (tx) => {
      await tx.brand.update({
        where: { id: brandId },
        data: { isFeaturedBlocked: newBlocked },
      });

      // If blocking, remove all active featured items for this brand (no penalty)
      if (newBlocked) {
        const activeItems = await tx.featuredItem.findMany({
          where: { brandId, isActive: true },
        });
        for (const item of activeItems) {
          await tx.featuredItem.update({
            where: { id: item.id },
            data: {
              isActive: false,
              removedAt: new Date(),
              removeReason: 'BRAND_BLOCKED',
            },
          });
        }
      }

      await (tx as any).adminAuditLog.create({
        data: {
          id: uuidv4(),
          actorUserId: actorId,
          action: AdminAuditAction.ADMIN_FEATURED_BLOCK_TOGGLE,
          targetType: 'Brand',
          targetId: brandId,
          previousState: { isFeaturedBlocked: brand.isFeaturedBlocked },
          newState: { isFeaturedBlocked: newBlocked },
          ipAddress: req.socket?.remoteAddress ?? null,
          userAgent: req.headers['user-agent'] ?? null,
        },
      });
    });

    return { id: brandId, isFeaturedBlocked: newBlocked };
  }

  // ── Search eligible items (for the feature modal) ──
  async searchEligible(params: {
    entityType?: string;
    search?: string;
    limit?: number;
  }) {
    const take = Math.min(params.limit ?? 20, 50);
    const results: Array<{
      entityType: string;
      entityId: string;
      name: string;
      brandId: string;
      brandName: string;
      thumbnail: string | null;
      eligible: boolean;
      reason?: string;
    }> = [];

    // Search products
    if (!params.entityType || params.entityType === 'PRODUCT') {
      const products = await this.prisma.product.findMany({
        where: {
          deletedAt: null,
          isActive: true,
          ...(params.search
            ? { name: { contains: params.search, mode: 'insensitive' as const } }
            : {}),
        },
        select: {
          id: true,
          name: true,
          brandId: true,
          thumbnail: true,
          images: true,
          isFeaturedBlocked: true,
          brand: { select: { id: true, name: true, isFeaturedBlocked: true, featuredPenaltyUntil: true } },
        },
        take,
        orderBy: { name: 'asc' },
      });

      for (const p of products) {
        const { eligible, reason } = await this.checkEligibilityQuick('PRODUCT', p.id, p.brandId, p);
        results.push({
          entityType: 'PRODUCT',
          entityId: p.id,
          name: p.name,
          brandId: p.brandId,
          brandName: p.brand.name,
          thumbnail: p.thumbnail || (p.images?.length ? p.images[0] : null),
          eligible,
          reason,
        });
      }
    }

    // Search designs (Collection with domain=DESIGN and isAvailableInStore=false)
    if (!params.entityType || params.entityType === 'DESIGN') {
      const designs = await this.prisma.collection.findMany({
        where: {
          deletedAt: null,
          status: 'PUBLISHED',
          isAvailableInStore: false,
          ...(params.search
            ? { title: { contains: params.search, mode: 'insensitive' as const } }
            : {}),
        },
        select: {
          id: true,
          title: true,
          ownerId: true,
          isFeaturedBlocked: true,
          coverMedia: { select: { file: { select: { s3Url: true } } } },
          owner: {
            select: {
              brand: { select: { id: true, name: true, isFeaturedBlocked: true, featuredPenaltyUntil: true } },
            },
          },
        },
        take,
        orderBy: { title: 'asc' },
      });

      for (const d of designs) {
        const brandId = d.owner?.brand?.id;
        if (!brandId) continue;
        const { eligible, reason } = await this.checkEligibilityQuick('DESIGN', d.id, brandId, {
          isFeaturedBlocked: d.isFeaturedBlocked,
          brand: d.owner.brand,
        });
        results.push({
          entityType: 'DESIGN',
          entityId: d.id,
          name: d.title ?? 'Untitled',
          brandId,
          brandName: d.owner.brand?.name ?? '',
          thumbnail: d.coverMedia?.file?.s3Url ?? null,
          eligible,
          reason,
        });
      }
    }

    return results;
  }

  // ── Eligibility summary (for admin UI) ──
  async getSlotsSummary() {
    const now = new Date();
    const activeCount = await this.prisma.featuredItem.count({
      where: {
        isActive: true,
        startsAt: { lte: now },
        expiresAt: { gt: now },
      },
    });
    const scheduledCount = await this.prisma.featuredItem.count({
      where: {
        isActive: true,
        startsAt: { gt: now },
      },
    });
    const totalAllTime = await this.prisma.featuredItem.count();

    return {
      activeCount,
      scheduledCount,
      totalAllTime,
      maxGlobal: MAX_GLOBAL_FEATURED,
      slotsRemaining: Math.max(0, MAX_GLOBAL_FEATURED - activeCount),
    };
  }

  // ── Public endpoints ──
  async publicListActive() {
    const now = new Date();
    const items = await this.prisma.featuredItem.findMany({
      where: {
        isActive: true,
        startsAt: { lte: now },
        expiresAt: { gt: now },
      },
      select: {
        id: true,
        entityType: true,
        entityId: true,
        brandId: true,
        startsAt: true,
        expiresAt: true,
        displayImages: true,
        useCoverOnly: true,
        brand: { select: { id: true, name: true, logo: true } },
      },
      orderBy: { startsAt: 'asc' },
    });

    return Promise.all(
      items.map(async (item) => {
        const entityName = await this.getEntityName(item.entityType, item.entityId);
        const entityThumbnail = await this.getEntityThumbnail(item.entityType, item.entityId);
        const entityPrice = item.entityType === 'PRODUCT'
          ? await this.getProductPrice(item.entityId)
          : null;

        return {
          ...item,
          entityName,
          entityThumbnail,
          entityPrice,
        };
      }),
    );
  }

  async publicGetById(id: string) {
    const item = await this.prisma.featuredItem.findUnique({
      where: { id },
      select: {
        id: true,
        entityType: true,
        entityId: true,
        brandId: true,
        startsAt: true,
        expiresAt: true,
        displayImages: true,
        useCoverOnly: true,
        isActive: true,
        brand: { select: { id: true, name: true, logo: true } },
      },
    });

    if (!item || !item.isActive) throw new NotFoundException('Featured item not found');

    const entityName = await this.getEntityName(item.entityType, item.entityId);
    const entityThumbnail = await this.getEntityThumbnail(item.entityType, item.entityId);

    return { ...item, entityName, entityThumbnail };
  }

  // ── Auto-removal (called by event hooks) ──
  async autoRemoveForEntity(
    entityType: string,
    entityId: string,
    reason: string,
    applyPenalty: boolean,
  ) {
    const active = await this.prisma.featuredItem.findFirst({
      where: { entityType, entityId, isActive: true },
    });
    if (!active) return;

    await this.prisma.$transaction(async (tx) => {
      await this.autoRemoveByEntity(tx, entityType, entityId, reason, applyPenalty);
    });
  }

  async autoRemoveForBrand(brandId: string, reason: string, applyPenalty: boolean) {
    const activeItems = await this.prisma.featuredItem.findMany({
      where: { brandId, isActive: true },
    });
    if (!activeItems.length) return;

    await this.prisma.$transaction(async (tx) => {
      for (const item of activeItems) {
        await tx.featuredItem.update({
          where: { id: item.id },
          data: {
            isActive: false,
            removedAt: new Date(),
            removeReason: reason,
          },
        });
      }

      if (applyPenalty) {
        const penaltyUntil = new Date();
        penaltyUntil.setMonth(penaltyUntil.getMonth() + PENALTY_MONTHS);
        await tx.brand.update({
          where: { id: brandId },
          data: { featuredPenaltyUntil: penaltyUntil },
        });
      }
    });

    this.logger.warn(
      `Auto-removed ${activeItems.length} featured item(s) for brand ${brandId}: ${reason}`,
    );
  }

  // ── Expiry processing (called by cron) ──
  async processExpiredItems() {
    const now = new Date();
    const expired = await this.prisma.featuredItem.findMany({
      where: {
        isActive: true,
        expiresAt: { lte: now },
      },
    });

    if (!expired.length) return 0;

    for (const item of expired) {
      try {
        // Snapshot performance metrics before deactivating
        const metrics = await this.snapshotPerformance(
          item.entityType,
          item.entityId,
          item.startsAt,
        );

        await this.prisma.featuredItem.update({
          where: { id: item.id },
          data: {
            isActive: false,
            removeReason: 'EXPIRED',
            removedAt: now,
            ...metrics,
          },
        });

        // Notify brand owner of expiry
        this.notifyBrandOwner(item.brandId, NotificationType.FEATURED_AUTO_REMOVED, {
          entityType: item.entityType,
          entityId: item.entityId,
          reason: 'EXPIRED',
        }).catch((err) => this.logger.warn(`Failed to send expiry notification: ${err?.message}`));
      } catch (err: any) {
        this.logger.warn(`Failed to expire featured item ${item.id}: ${err?.message}`);
      }
    }

    this.logger.log(`Expired ${expired.length} featured item(s)`);
    return expired.length;
  }

  // ── Private helpers ──

  private async resolveEntity(entityType: string, entityId: string) {
    if (entityType === 'PRODUCT') {
      const product = await this.prisma.product.findUnique({
        where: { id: entityId },
        select: { id: true, name: true, brandId: true, isActive: true, deletedAt: true, isFeaturedBlocked: true },
      });
      if (!product || product.deletedAt) throw new NotFoundException('Product not found');
      if (!product.isActive) throw new BadRequestException('Product is inactive');
      if (product.isFeaturedBlocked) throw new ForbiddenException('Product is blocked from featuring');
      return { brandId: product.brandId, entityName: product.name };
    }

    if (entityType === 'DESIGN') {
      const design = await this.prisma.collection.findUnique({
        where: { id: entityId },
        select: {
          id: true,
          title: true,
          status: true,
          deletedAt: true,
          isAvailableInStore: true,
          isFeaturedBlocked: true,
          owner: { select: { brand: { select: { id: true } } } },
        },
      });
      if (!design || design.deletedAt) throw new NotFoundException('Design not found');
      if (design.isAvailableInStore) throw new BadRequestException('Store collections cannot be featured');
      if (design.status !== 'PUBLISHED') throw new BadRequestException('Design must be published');
      if (design.isFeaturedBlocked) throw new ForbiddenException('Design is blocked from featuring');
      const brandId = design.owner?.brand?.id;
      if (!brandId) throw new BadRequestException('Design owner has no brand');
      return { brandId, entityName: design.title ?? 'Untitled' };
    }

    throw new BadRequestException(`Invalid entityType: ${entityType}`);
  }

  private async checkEligibility(entityType: string, entityId: string, brandId: string) {
    const now = new Date();

    // Brand-level checks
    const brand = await this.prisma.brand.findUnique({
      where: { id: brandId },
      select: {
        isFeaturedBlocked: true,
        featuredPenaltyUntil: true,
        owner: { select: { status: true } },
      },
    });
    if (!brand) throw new NotFoundException('Brand not found');
    if (brand.isFeaturedBlocked) {
      throw new ForbiddenException('Brand is blocked from featuring');
    }
    if (brand.featuredPenaltyUntil && brand.featuredPenaltyUntil > now) {
      throw new BadRequestException(
        `Brand is under a featured penalty until ${brand.featuredPenaltyUntil.toISOString().split('T')[0]}`,
      );
    }
    if (brand.owner?.status !== 'ACTIVE') {
      throw new BadRequestException('Brand owner must be active');
    }

    // Brand active+scheduled count
    const brandActiveCount = await this.prisma.featuredItem.count({
      where: { brandId, isActive: true },
    });
    if (brandActiveCount >= MAX_PER_BRAND) {
      throw new BadRequestException(`Brand already has ${brandActiveCount} active/scheduled featured item(s). Max is ${MAX_PER_BRAND}.`);
    }

    // Global active count (currently live items only, not scheduled)
    const globalActiveCount = await this.prisma.featuredItem.count({
      where: {
        isActive: true,
        startsAt: { lte: now },
        expiresAt: { gt: now },
      },
    });
    if (globalActiveCount >= MAX_GLOBAL_FEATURED) {
      throw new BadRequestException(`Global featured slots full (${globalActiveCount}/${MAX_GLOBAL_FEATURED})`);
    }

    // Duplicate check — item already featured
    const existingActive = await this.prisma.featuredItem.findFirst({
      where: { entityType, entityId, isActive: true },
    });
    if (existingActive) {
      throw new BadRequestException('This item is already featured or scheduled');
    }
  }

  private async checkEligibilityQuick(
    entityType: string,
    entityId: string,
    brandId: string,
    entityData: { isFeaturedBlocked: boolean; brand: any },
  ): Promise<{ eligible: boolean; reason?: string }> {
    const now = new Date();

    if (entityData.isFeaturedBlocked) return { eligible: false, reason: 'Item blocked' };
    if (entityData.brand?.isFeaturedBlocked) return { eligible: false, reason: 'Brand blocked' };
    if (entityData.brand?.featuredPenaltyUntil && new Date(entityData.brand.featuredPenaltyUntil) > now) {
      return { eligible: false, reason: 'Brand under penalty' };
    }

    const brandActive = await this.prisma.featuredItem.count({
      where: { brandId, isActive: true },
    });
    if (brandActive >= MAX_PER_BRAND) return { eligible: false, reason: 'Brand already featured' };

    const existing = await this.prisma.featuredItem.findFirst({
      where: { entityType, entityId, isActive: true },
    });
    if (existing) return { eligible: false, reason: 'Already featured' };

    return { eligible: true };
  }

  private async getEntityName(entityType: string, entityId: string): Promise<string> {
    if (entityType === 'PRODUCT') {
      const p = await this.prisma.product.findUnique({
        where: { id: entityId },
        select: { name: true },
      });
      return p?.name ?? 'Deleted product';
    }
    if (entityType === 'DESIGN') {
      const c = await this.prisma.collection.findUnique({
        where: { id: entityId },
        select: { title: true },
      });
      return c?.title ?? 'Deleted design';
    }
    return 'Unknown';
  }

  private async getEntityThumbnail(entityType: string, entityId: string): Promise<string | null> {
    if (entityType === 'PRODUCT') {
      const p = await this.prisma.product.findUnique({
        where: { id: entityId },
        select: { thumbnail: true, images: true },
      });
      return p?.thumbnail || (p?.images?.length ? p.images[0] : null);
    }
    if (entityType === 'DESIGN') {
      const c = await this.prisma.collection.findUnique({
        where: { id: entityId },
        select: { coverMedia: { select: { file: { select: { s3Url: true } } } } },
      });
      return c?.coverMedia?.file?.s3Url ?? null;
    }
    return null;
  }

  private async getProductPrice(entityId: string): Promise<{ price: string; salePrice: string | null; currency: string } | null> {
    const p = await this.prisma.product.findUnique({
      where: { id: entityId },
      select: { price: true, salePrice: true, currency: true },
    });
    if (!p) return null;
    return {
      price: p.price.toString(),
      salePrice: p.salePrice?.toString() ?? null,
      currency: p.currency,
    };
  }

  private async autoRemoveByEntity(
    tx: any,
    entityType: string,
    entityId: string,
    reason: string,
    applyPenalty: boolean,
  ) {
    const active = await tx.featuredItem.findFirst({
      where: { entityType, entityId, isActive: true },
    });
    if (!active) return;

    await tx.featuredItem.update({
      where: { id: active.id },
      data: {
        isActive: false,
        removedAt: new Date(),
        removeReason: reason,
      },
    });

    // Sync legacy isFeatured flag on Product
    if (entityType === 'PRODUCT') {
      await tx.product.update({
        where: { id: entityId },
        data: { isFeatured: false },
      }).catch(() => {/* product might already be deleted */});
    }

    if (applyPenalty) {
      const penaltyUntil = new Date();
      penaltyUntil.setMonth(penaltyUntil.getMonth() + PENALTY_MONTHS);
      await tx.brand.update({
        where: { id: active.brandId },
        data: { featuredPenaltyUntil: penaltyUntil },
      });
    }
  }

  private async snapshotPerformance(
    entityType: string,
    entityId: string,
    startsAt: Date,
  ): Promise<{ viewsDelta?: number; threadsDelta?: number }> {
    // Best-effort metric snapshot
    if (entityType === 'PRODUCT') {
      const p = await this.prisma.product.findUnique({
        where: { id: entityId },
        select: { viewsCount: true, threadsCount: true },
      });
      if (p) return { viewsDelta: p.viewsCount, threadsDelta: p.threadsCount };
    }
    if (entityType === 'DESIGN') {
      const c = await this.prisma.collection.findUnique({
        where: { id: entityId },
        select: { viewsCount: true, threadsCount: true },
      });
      if (c) return { viewsDelta: c.viewsCount, threadsDelta: c.threadsCount };
    }
    return {};
  }

  private async notifyBrandOwner(
    brandId: string,
    type: NotificationType,
    payload: Record<string, any>,
  ) {
    const brand = await this.prisma.brand.findUnique({
      where: { id: brandId },
      select: { ownerId: true },
    });
    if (!brand?.ownerId) return;

    await this.notifications.create(brand.ownerId, type, {
      payload,
      target: {
        type: payload.entityType === 'DESIGN' ? 'COLLECTION' : 'PRODUCT',
        id: payload.entityId,
      },
    });
  }
}
