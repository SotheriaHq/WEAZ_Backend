import {
  Injectable,
  BadRequestException,
  NotFoundException,
  ForbiddenException,
  ConflictException,
  GoneException,
} from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { v4 as uuidv4 } from 'uuid';
import {
  ReactionType,
  UserType,
  Prisma,
  ContentTarget,
  NotificationType,
  CollectionVisibility,
  CollectionType,
  PatchStatus,
  OrderStatus,
} from '@prisma/client';
import { NotificationsService } from 'src/notifications/notifications.service';
import { AnalyticsService } from 'src/analytics/analytics.service';
import {
  CreateCollectionDto,
  FinalizeCollectionDto,
} from './dto/create-collection.dto';
import { HelperService } from './helper/Helper.service';
import { UploadService } from 'src/upload/upload.service';
import { StoreService } from 'src/store/store.service';
import { CreateProductDto } from 'src/store/dto/create-product.dto';
import * as crypto from 'crypto';
import { sanitizeTags } from 'src/common/utils/tag-validator';
import { UpdateCollectionDto } from './dto/update-collection.dto';
import { parse } from 'csv-parse/sync';

@Injectable()
export class CollectionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly helperservice: HelperService,
    private readonly uploadService: UploadService,
    private readonly storeService: StoreService,
    private readonly analytics?: AnalyticsService,
    private readonly notifications?: NotificationsService,
  ) {}

  private readonly maxProductsPerCollection = 5;
  private readonly collectionDeleteWindowMs = 30 * 24 * 60 * 60 * 1000;

  private async lockCollectionForUpdate(
    tx: Prisma.TransactionClient,
    collectionId: string,
  ) {
    await tx.$executeRaw(
      Prisma.sql`SELECT id FROM "Collection" WHERE id = ${collectionId} FOR UPDATE`,
    );
  }

  private async touchDraftActivity(
    tx: Prisma.TransactionClient,
    collectionId: string,
  ) {
    const now = new Date();
    const ttlMinutes = Math.max(
      5,
      parseInt(process.env.DRAFT_SESSION_TTL_MINUTES || '30', 10),
    );
    const nextExpiresAt = new Date(now.getTime() + ttlMinutes * 60 * 1000);
    await (tx as any).collection.updateMany({
      where: { id: collectionId, status: 'DRAFT', deletedAt: null },
      data: { lastActivityAt: now, draftVersion: { increment: 1 } },
    });
  }

  private async enforcePrimaryMembership(
    tx: Prisma.TransactionClient,
    productId: string,
  ) {
    const links = await tx.collectionProduct.findMany({
      where: { productId },
      orderBy: [
        { isPrimary: 'desc' },
        { createdAt: 'asc' },
        { orderIndex: 'asc' },
        { collectionId: 'asc' },
      ],
      select: { collectionId: true, isPrimary: true },
    });

    if (links.length === 0) {
      await tx.product.update({
        where: { id: productId },
        data: { collectionId: null },
      });
      return;
    }

    const primary = links.find((l) => l.isPrimary) ?? links[0];
    await tx.collectionProduct.updateMany({
      where: { productId },
      data: { isPrimary: false },
    });
    await tx.collectionProduct.updateMany({
      where: { productId, collectionId: primary.collectionId },
      data: { isPrimary: true },
    });
    await tx.product.update({
      where: { id: productId },
      data: { collectionId: primary.collectionId },
    });
  }

  private async countActiveOrdersForCollection(
    collectionId: string,
    ownerId: string,
  ) {
    const productLinks = await this.prisma.collectionProduct.findMany({
      where: { collectionId },
      select: { productId: true },
    });
    const productIds = productLinks.map((l) => l.productId);
    if (productIds.length === 0) return 0;

    const brand = await this.prisma.brand.findUnique({
      where: { ownerId },
      select: { id: true },
    });
    if (!brand) return 0;

    const activeOrders = await this.prisma.order.findMany({
      where: {
        brandId: brand.id,
        status: { in: [OrderStatus.PENDING, OrderStatus.PROCESSING, OrderStatus.SHIPPED] },
      },
      select: { items: true },
    });

    let activeCount = 0;
    for (const order of activeOrders) {
      const items = order.items as { productId?: string }[] | null;
      if (!Array.isArray(items)) continue;
      if (items.some((item) => item.productId && productIds.includes(item.productId))) {
        activeCount += 1;
      }
    }
    return activeCount;
  }

  private parseBulkCsv(file: Express.Multer.File) {
    const csvText = file.buffer.toString('utf-8');
    return parse(csvText, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
    }) as Array<Record<string, string>>;
  }

  private normalizeCsvBool(value?: string) {
    if (!value) return undefined;
    const normalized = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'y'].includes(normalized)) return true;
    if (['false', '0', 'no', 'n'].includes(normalized)) return false;
    return undefined;
  }

  private normalizeCsvNumber(value?: string) {
    if (!value) return undefined;
    const num = Number(value);
    return Number.isFinite(num) ? num : undefined;
  }

  private buildBulkProductDto(
    row: Record<string, string>,
    collectionId: string,
  ): CreateProductDto {
    const tags = (row.tags || '')
      .split(',')
      .map((tag) => tag.trim())
      .filter(Boolean);

    const sizes = (row.sizes || '')
      .split(',')
      .map((size) => size.trim())
      .filter(Boolean);

    const colors = (row.colors || '')
      .split(',')
      .map((color) => color.trim())
      .filter(Boolean);

    const images = (row.images || '')
      .split(',')
      .map((url) => url.trim())
      .filter(Boolean);

    return {
      name:
        row.product_name ||
        row.name ||
        row.productName ||
        'Untitled Product',
      description: row.description || row.product_description || undefined,
      price:
        this.normalizeCsvNumber(row.price || row.unit_price) ?? 0,
      salePrice: this.normalizeCsvNumber(row.sale_price || row.salePrice),
      sku: row.sku || row.product_sku || undefined,
      tags,
      sizes,
      colors,
      images,
      thumbnail: row.thumbnail || images[0] || undefined,
      totalStock:
        this.normalizeCsvNumber(
          row.stock || row.total_stock || row.totalStock,
        ) ?? 0,
      allowBackorders: this.normalizeCsvBool(
        row.allow_backorders || row.allowBackorders,
      ),
      isActive: this.normalizeCsvBool(row.is_active || row.isActive),
      gender: (row.gender as any) || undefined,
      collectionId,
    } as CreateProductDto;
  }

  private async canViewCollection(
    collectionId: string,
    requesterId?: string,
  ): Promise<boolean> {
    const c = (await this.prisma.collection.findUnique({
      where: { id: collectionId },
      select: {
        ownerId: true,
        status: true,
        visibility: true,
        isAvailableInStore: true,
        saleMinPrice: true,
        saleMaxPrice: true,
        deletedAt: true,
      } as any,
    } as any)) as any;
    // Not found
    if (!c) return false;

    if (c.deletedAt) return false;

    // Owner can always view their own collection (draft or published)
    if (requesterId && requesterId === c.ownerId) return true;

    // For non-owners, only published collections are viewable
    if (c.status !== 'PUBLISHED') return false;

    // Public collections are always viewable
    if (c.visibility === CollectionVisibility.PUBLIC) return true;

    // For other private collections, check access approval
    if (requesterId) {
      const access = await this.prisma.collectionAccess.findUnique({
        where: {
          collectionId_viewerId: { collectionId, viewerId: requesterId },
        },
        select: { state: true },
      });
      return access?.state === 'APPROVED';
    }
    return false;
  }

  private async canViewMedia(mediaId: string, requesterId?: string) {
    const m = await this.prisma.collectionMedia.findUnique({
      where: { id: mediaId },
      select: { collectionId: true },
    });
    if (!m) return false;
    return this.canViewCollection(m.collectionId, requesterId);
  }

  private async recalculateCollectionPriceRange(collectionId: string) {
    const links = await this.prisma.collectionProduct.findMany({
      where: { collectionId },
      include: {
        product: {
          select: {
            price: true,
            salePrice: true,
            saleStartAt: true,
            saleEndAt: true,
            deletedAt: true,
            archivedAt: true,
            isActive: true,
            publishAt: true,
            variants: { select: { price: true } },
          },
        },
      },
    });
    const now = new Date();
    const active = links.filter((l) => {
      const p = l.product;
      if (!p || p.deletedAt || p.archivedAt || !p.isActive) return false;
      if (p.publishAt && p.publishAt > now) return false;
      return true;
    });

    const prices = active
      .map((l) => {
        const p = l.product;
        const variantPrices = Array.isArray(p.variants)
          ? p.variants.map((v) => Number(v.price || 0)).filter((v) => v > 0)
          : [];
        if (variantPrices.length > 0) return Math.min(...variantPrices);
        return Number(p.price || 0);
      })
      .filter((v) => v > 0);

    const maxPrices = active
      .map((l) => {
        const p = l.product;
        const variantPrices = Array.isArray(p.variants)
          ? p.variants.map((v) => Number(v.price || 0)).filter((v) => v > 0)
          : [];
        if (variantPrices.length > 0) return Math.max(...variantPrices);
        return Number(p.price || 0);
      })
      .filter((v) => v > 0);

    const salePrices = active
      .map((l) => {
        const p = l.product;
        if (!p.salePrice) return null;
        if (p.saleStartAt && p.saleStartAt > now) return null;
        if (p.saleEndAt && p.saleEndAt < now) return null;
        return Number(p.salePrice);
      })
      .filter((v): v is number => typeof v === 'number' && v > 0);

    await this.prisma.collection.update({
      where: { id: collectionId },
      data: {
        minPrice: prices.length ? Math.min(...prices) : null,
        maxPrice: maxPrices.length ? Math.max(...maxPrices) : null,
        saleMinPrice: salePrices.length ? Math.min(...salePrices) : null,
        saleMaxPrice: salePrices.length ? Math.max(...salePrices) : null,
      },
    });
  }

  // ===================== Access Management =====================
  async requestAccess(collectionId: string, requesterId: string) {
    const c = (await this.prisma.collection.findUnique({
      where: { id: collectionId },
      select: { id: true, ownerId: true, status: true, visibility: true, deletedAt: true } as any,
    } as any)) as any;
    if (!c || c.deletedAt || c.status !== 'PUBLISHED')
      throw new NotFoundException('Collection not found');
    if (c.visibility === CollectionVisibility.PUBLIC)
      return { state: 'APPROVED' };
    if (c.ownerId === requesterId) return { state: 'APPROVED' };
    const now = new Date();
    const existing = await this.prisma.collectionAccess.findUnique({
      where: { collectionId_viewerId: { collectionId, viewerId: requesterId } },
    });
    // Cooldown after rejection
    // Default cooldown: 72h (configurable via env PRIVATE_ACCESS_COOLDOWN_MS)
    const cooldownMs = Math.max(
      0,
      parseInt(process.env.PRIVATE_ACCESS_COOLDOWN_MS || '') ||
        72 * 60 * 60 * 1000,
    );
    if (
      existing &&
      existing.state === 'REVOKED' &&
      existing.notes === 'REJECTED'
    ) {
      const elapsed = now.getTime() - new Date(existing.updatedAt).getTime();
      if (elapsed < cooldownMs) {
        const nextAllowedAt = new Date(
          existing.updatedAt.getTime() + cooldownMs,
        ).toISOString();
        return { state: 'PENDING', cooldownActive: true, nextAllowedAt } as any;
      }
    }
    if (!existing) {
      await this.prisma.collectionAccess.create({
        data: {
          id: uuidv4(),
          collectionId,
          viewerId: requesterId,
          state: 'PENDING',
          createdAt: now,
        },
      } as any);
      // Notify owner about new request
      try {
        await this.notifications?.create(
          c.ownerId,
          NotificationType.PRIVATE_ACCESS_REQUESTED,
          {
            actorId: requesterId,
            payload: {
              collectionId,
              requesterId,
              targetUrl: `/settings/collections?collectionId=${collectionId}&tab=requests`,
            },
          },
        );
      } catch (e) {
        // non-blocking
      }
      console.log('metrics.access_request', { collectionId, requesterId });
      return { state: 'PENDING' };
    }
    if (existing.state === 'APPROVED') {
      return { state: 'APPROVED' };
    }
    if (existing.state === 'PENDING') {
      console.log('metrics.access_request', { collectionId, requesterId });
      return { state: 'PENDING' };
    }
    await this.prisma.collectionAccess.update({
      where: { collectionId_viewerId: { collectionId, viewerId: requesterId } },
      data: { state: 'PENDING', updatedAt: now },
    } as any);
    console.log('metrics.access_request', { collectionId, requesterId });
    return { state: 'PENDING' };
  }

  private async assertOwner(collectionId: string, ownerId: string) {
    const c = (await this.prisma.collection.findUnique({
      where: { id: collectionId },
      select: { ownerId: true, deletedAt: true } as any,
    } as any)) as any;
    if (!c) throw new NotFoundException('Collection not found');
    if (c.deletedAt) throw new GoneException('Collection has been deleted');
    if (c.ownerId !== ownerId) throw new ForbiddenException('Not owner');
  }

  async listAccessRequests(
    collectionId: string,
    ownerId: string,
    limit = 20,
    cursor?: string,
  ) {
    await this.assertOwner(collectionId, ownerId);

    const existingCount = await this.prisma.collectionProduct.count({
      where: { collectionId },
    });
    if (existingCount >= this.maxProductsPerCollection) {
      throw new BadRequestException(
        `Collections can contain maximum ${this.maxProductsPerCollection} products.`,
      );
    }
    const rows = await this.prisma.collectionAccess.findMany({
      where: { collectionId, state: 'PENDING' },
      include: {
        viewer: { select: { id: true, username: true, profileImage: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    } as any);
    const hasNext = rows.length > limit;
    const data = hasNext ? rows.slice(0, -1) : rows;
    return {
      items: data,
      hasNextPage: hasNext,
      endCursor: data.length ? data[data.length - 1].id : null,
    };
  }

  async listApprovedViewers(
    collectionId: string,
    ownerId: string,
    limit = 20,
    cursor?: string,
  ) {
    await this.assertOwner(collectionId, ownerId);
    const rows = await this.prisma.collectionAccess.findMany({
      where: { collectionId, state: 'APPROVED' },
      include: {
        viewer: { select: { id: true, username: true, profileImage: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    } as any);
    const hasNext = rows.length > limit;
    const data = hasNext ? rows.slice(0, -1) : rows;
    return {
      items: data,
      hasNextPage: hasNext,
      endCursor: data.length ? data[data.length - 1].id : null,
    };
  }

  // Brand-scoped: list access requests across all private collections of the brand
  async listBrandAccessRequests(
    brandId: string,
    ownerId: string,
    state: 'PENDING' | 'APPROVED' = 'PENDING',
    limit = 20,
    cursor?: string,
    q?: string,
    page?: number,
  ) {
    if (brandId !== ownerId) throw new ForbiddenException('Not owner');
    const where: Prisma.CollectionAccessWhereInput = {
      state,
      collection: { ownerId: brandId },
      ...(q
        ? {
            OR: [
              {
                viewer: { username: { contains: q, mode: 'insensitive' } },
              } as any,
              {
                collection: { title: { contains: q, mode: 'insensitive' } },
              } as any,
            ],
          }
        : {}),
    } as any;

    const take = Math.min(Math.max(limit, 1), 100);
    const pageNum = page && page > 0 ? page : undefined;

    const totalCount = await this.prisma.collectionAccess.count({ where });

    const rows = await this.prisma.collectionAccess.findMany({
      where,
      include: {
        viewer: {
          select: {
            id: true,
            username: true,
            firstName: true,
            lastName: true,
            profileImage: true,
            profileImageId: true,
            profileImageFile: {
              select: {
                id: true,
                s3Url: true,
              },
            },
          },
        },
        collection: {
          select: {
            id: true,
            title: true,
            medias: {
              select: {
                file: { select: { s3Url: true } },
              },
              take: 1,
              orderBy: { orderIndex: 'asc' },
            },
            _count: { select: { medias: true } },
          },
        },
      },
      take: pageNum ? take : take + 1,
      ...(pageNum ? { skip: (pageNum - 1) * take } : {}),
      orderBy: { createdAt: 'desc' },
      ...(cursor && !pageNum ? { skip: 1, cursor: { id: cursor } } : {}),
    } as any);
    const hasNextPage = pageNum
      ? pageNum * take < totalCount
      : rows.length > take;
    const data = pageNum ? rows : hasNextPage ? rows.slice(0, -1) : rows;
    const totalPages = Math.max(1, Math.ceil(totalCount / take));
    return {
      items: data,
      hasNextPage,
      endCursor: pageNum
        ? null
        : data.length
          ? (data[data.length - 1] as any).id
          : null,
      totalCount,
      page: pageNum ?? undefined,
      pageSize: take,
      totalPages,
    } as any;
  }

  // Brand-scoped: list viewer states for all private collections of a brand
  async listViewerAccessStatesForBrand(brandId: string, viewerId?: string) {
    // Use select to avoid relying on columns that may not exist yet (e.g., coverMediaId) when DB schema is out-of-sync.
    const collections = await this.prisma.collection.findMany({
      where: {
        ownerId: brandId,
        status: 'PUBLISHED',
        visibility: CollectionVisibility.PRIVATE,
      },
      select: {
        id: true,
        title: true,
        medias: {
          select: {
            id: true,
            orderIndex: true,
            file: { select: { id: true, s3Url: true } },
          },
          take: 1,
          orderBy: [{ orderIndex: 'asc' }],
        },
        _count: { select: { medias: true } },
      },
    });

    const states: Record<string, 'APPROVED' | 'PENDING' | 'REVOKED'> = {};
    if (viewerId) {
      const acc = await this.prisma.collectionAccess.findMany({
        where: { viewerId, collectionId: { in: collections.map((c) => c.id) } },
      });
      for (const a of acc) {
        states[a.collectionId] = a.state as any;
      }
    }

    return {
      items: collections.map((c) => ({
        collectionId: c.id,
        title: c.title,
        coverMediaId: c.medias[0]?.id ?? null,
        coverFileId: c.medias[0]?.file?.id ?? null,
        coverUrl: c.medias[0]?.file?.s3Url ?? null,
        itemCount: c._count.medias,
        state: (states[c.id] ?? 'NONE') as
          | 'APPROVED'
          | 'PENDING'
          | 'REVOKED'
          | 'NONE',
      })),
    };
  }

  async approveAccessBulk(
    collectionId: string,
    ownerId: string,
    userIds: string[],
  ) {
    await this.assertOwner(collectionId, ownerId);
    const now = new Date();
    await this.prisma.$transaction(
      userIds.map((uid) =>
        this.prisma.collectionAccess.upsert({
          where: { collectionId_viewerId: { collectionId, viewerId: uid } },
          update: { state: 'APPROVED', grantedBy: ownerId, updatedAt: now },
          create: {
            id: uuidv4(),
            collectionId,
            viewerId: uid,
            state: 'APPROVED',
            grantedBy: ownerId,
            createdAt: now,
          },
        } as any),
      ),
    );
    // Notify users approved
    for (const uid of userIds) {
      try {
        await this.notifications?.create(
          uid,
          NotificationType.PRIVATE_ACCESS_APPROVED,
          {
            actorId: ownerId,
            payload: {
              collectionId,
              targetUrl: `/collections/${collectionId}`,
            },
          },
        );
      } catch {}
    }
    console.log('metrics.access_approve_bulk', {
      collectionId,
      count: userIds.length,
    });
    return { success: true };
  }

  async updateAccessState(
    collectionId: string,
    ownerId: string,
    userId: string,
    state: 'APPROVED' | 'REVOKED',
  ) {
    await this.assertOwner(collectionId, ownerId);
    await this.prisma.collectionAccess.upsert({
      where: { collectionId_viewerId: { collectionId, viewerId: userId } },
      update: { state, grantedBy: ownerId, updatedAt: new Date() },
      create: {
        id: uuidv4(),
        collectionId,
        viewerId: userId,
        state,
        grantedBy: ownerId,
      },
    } as any);
    // Notify viewer on decision
    try {
      await this.notifications?.create(
        userId,
        state === 'APPROVED'
          ? NotificationType.PRIVATE_ACCESS_APPROVED
          : NotificationType.PRIVATE_ACCESS_REVOKED,
        {
          actorId: ownerId,
          payload: {
            collectionId,
            targetUrl:
              state === 'APPROVED'
                ? `/collections/${collectionId}`
                : `/brands/${ownerId}?tab=private`,
          },
        },
      );
    } catch {}
    console.log('metrics.access_update_state', { collectionId, userId, state });
    return { success: true };
  }

  async rejectAccess(collectionId: string, ownerId: string, userId: string) {
    await this.assertOwner(collectionId, ownerId);
    const existing = await this.prisma.collectionAccess.findUnique({
      where: { collectionId_viewerId: { collectionId, viewerId: userId } },
    });
    if (!existing || existing.state !== 'PENDING') {
      // Idempotent: no-op if already decided
      return { success: true };
    }
    await this.prisma.collectionAccess.update({
      where: { collectionId_viewerId: { collectionId, viewerId: userId } },
      data: {
        state: 'REVOKED' as any,
        notes: 'REJECTED',
        updatedAt: new Date(),
        grantedBy: ownerId,
      },
    } as any);
    try {
      await this.notifications?.create(
        userId,
        NotificationType.PRIVATE_ACCESS_REJECTED,
        {
          actorId: ownerId,
          payload: {
            collectionId,
            targetUrl: `/brands/${ownerId}?tab=private`,
          },
        },
      );
    } catch {}
    console.log('metrics.access_reject', { collectionId, userId });
    return { success: true };
  }

  // ===================== User-scoped Private Access Management =====================

  /**
   * List all access requests sent by the user
   */
  async listUserAccessRequests(
    userId: string,
    status?: 'pending' | 'approved' | 'rejected',
    take = 20,
    page = 1,
  ) {
    const stateMap: Record<string, any> = {
      pending: 'PENDING',
      approved: 'APPROVED',
      rejected: 'REVOKED',
    };

    const where: Prisma.CollectionAccessWhereInput = {
      viewerId: userId,
      ...(status ? { state: stateMap[status] } : {}),
    };

    const totalCount = await this.prisma.collectionAccess.count({ where });
    const skip = (page - 1) * take;

    const rows = await this.prisma.collectionAccess.findMany({
      where,
      include: {
        collection: {
          select: {
            id: true,
            title: true,
            ownerId: true,
            owner: {
              select: {
                id: true,
                username: true,
                brandFullName: true,
                profileImage: true,
                profileImageId: true,
                profileImageFile: {
                  select: {
                    id: true,
                    s3Url: true,
                  },
                },
              },
            },
            medias: {
              select: {
                file: { select: { s3Url: true } },
              },
              take: 1,
              orderBy: { orderIndex: 'asc' },
            },
            _count: { select: { medias: true } },
          },
        },
      },
      skip,
      take,
      orderBy: { createdAt: 'desc' },
    });

    const totalPages = Math.ceil(totalCount / take);

    return {
      items: rows.map((r) => ({
        id: r.id,
        collectionId: r.collectionId,
        title: r.collection?.title || 'Untitled',
        brand: {
          id: r.collection?.owner?.id,
          name:
            r.collection?.owner?.brandFullName || r.collection?.owner?.username,
          profileImage: r.collection?.owner?.profileImage,
          profileImageId: r.collection?.owner?.profileImageId,
          profileImageFile: r.collection?.owner?.profileImageFile,
        },
        coverUrl: r.collection?.medias[0]?.file?.s3Url || null,
        itemCount: r.collection?._count?.medias || 0,
        state: r.state,
        requestedAt: r.createdAt,
        updatedAt: r.updatedAt,
      })),
      totalCount,
      page,
      pageSize: take,
      totalPages,
      hasNextPage: page < totalPages,
    };
  }

  /**
   * List all granted accesses for the user (approved collections they can view)
   */
  async listUserGrantedAccesses(userId: string, take = 20, page = 1) {
    const where: Prisma.CollectionAccessWhereInput = {
      viewerId: userId,
      state: 'APPROVED',
    };

    const totalCount = await this.prisma.collectionAccess.count({ where });
    const skip = (page - 1) * take;

    const rows = await this.prisma.collectionAccess.findMany({
      where,
      include: {
        collection: {
          select: {
            id: true,
            title: true,
            ownerId: true,
            owner: {
              select: {
                id: true,
                username: true,
                brandFullName: true,
                profileImage: true,
                profileImageId: true,
                profileImageFile: {
                  select: {
                    id: true,
                    s3Url: true,
                  },
                },
              },
            },
            medias: {
              select: {
                file: { select: { s3Url: true } },
              },
              take: 1,
              orderBy: { orderIndex: 'asc' },
            },
            _count: { select: { medias: true } },
          },
        },
      },
      skip,
      take,
      orderBy: { updatedAt: 'desc' },
    });

    const totalPages = Math.ceil(totalCount / take);

    return {
      items: rows.map((r) => ({
        id: r.id,
        collectionId: r.collectionId,
        title: r.collection?.title || 'Untitled',
        brand: {
          id: r.collection?.owner?.id,
          name:
            r.collection?.owner?.brandFullName || r.collection?.owner?.username,
          profileImage: r.collection?.owner?.profileImage,
          profileImageId: r.collection?.owner?.profileImageId,
          profileImageFile: r.collection?.owner?.profileImageFile,
        },
        coverUrl: r.collection?.medias[0]?.file?.s3Url || null,
        itemCount: r.collection?._count?.medias || 0,
        grantedAt: r.updatedAt,
      })),
      totalCount,
      page,
      pageSize: take,
      totalPages,
      hasNextPage: page < totalPages,
    };
  }

  /**
   * Cancel a pending access request
   */
  async cancelAccessRequest(requestId: string, userId: string) {
    const access = await this.prisma.collectionAccess.findUnique({
      where: { id: requestId },
      include: { collection: { select: { ownerId: true } } },
    });

    if (!access) {
      throw new NotFoundException('Access request not found');
    }

    if (access.viewerId !== userId) {
      throw new ForbiddenException('Not authorized to cancel this request');
    }

    // Only allow canceling pending requests
    if (access.state !== 'PENDING') {
      throw new BadRequestException('Can only cancel pending requests');
    }

    await this.prisma.collectionAccess.delete({
      where: { id: requestId },
    });

    console.log('metrics.access_request_cancelled', {
      requestId,
      userId,
      collectionId: access.collectionId,
    });

    return { success: true, message: 'Request cancelled successfully' };
  }

  /**
   * User revokes their own access to a private collection
   */
  async userRevokeOwnAccess(accessId: string, userId: string) {
    const access = await this.prisma.collectionAccess.findUnique({
      where: { id: accessId },
      include: { collection: { select: { ownerId: true } } },
    });

    if (!access) {
      throw new NotFoundException('Access not found');
    }

    if (access.viewerId !== userId) {
      throw new ForbiddenException('Not authorized to revoke this access');
    }

    // Only allow revoking approved access
    if (access.state !== 'APPROVED') {
      throw new BadRequestException('Can only revoke approved access');
    }

    await this.prisma.collectionAccess.delete({
      where: { id: accessId },
    });

    console.log('metrics.access_user_revoked', {
      accessId,
      userId,
      collectionId: access.collectionId,
    });

    return { success: true, message: 'Access revoked successfully' };
  }

  /**
   * STEP 1: Create collection draft and return presigned URLs
   * Simplified: category suggestions removed; categoryId is required and must be active.
   */
  async initializeCollection(userId: string, dto: CreateCollectionDto) {
    // Validate user is brand
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || user.type !== UserType.BRAND) {
      throw new ForbiddenException('Only brands can create collections');
    }

    const hasFiles = Array.isArray(dto.files) && dto.files.length > 0;

    // Store-collection session initialization (no media required)
    if (!hasFiles && dto.mode) {
      const draftsCount = await (this.prisma.collection as any).count({
        where: { ownerId: userId, status: 'DRAFT', deletedAt: null },
      });
      if (draftsCount >= 4) {
        throw new BadRequestException(
          'You can have maximum 4 draft collections. Please publish or delete an existing draft to continue.',
        );
      }

      const collectionId = uuidv4();
      const now = new Date();
      const collection = await (this.prisma.collection as any).create({
        data: {
          id: collectionId,
          ownerId: userId,
          title: dto.title?.trim() || null,
          description: dto.description?.trim() || null,
          status: 'DRAFT',
          visibility: dto.visibility ?? CollectionVisibility.PUBLIC,
          type: dto.type ?? CollectionType.EVERYBODY,
          isAvailableInStore: dto.isAvailableInStore ?? false,
          tags: Array.isArray(dto.tags) ? sanitizeTags(dto.tags) : [],
          categoryId: dto.categoryId || null,
          draftVersion: 0,
        },
      });

      return {
        sessionId: collection.id,
        expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      };
    }

    if (!dto.title || !dto.title.trim()) {
      throw new BadRequestException('Title is required');
    }

    if (!dto.categoryId) {
      throw new BadRequestException('Category is required');
    }

    // Validate files array
    if (!dto.files || dto.files.length === 0) {
      throw new BadRequestException('At least one file is required');
    }

    if (dto.files.length > 20) {
      throw new BadRequestException('Maximum 20 files per collection');
    }

    // PHASE 2: Use shared tag normalization utility
    const sanitizedTags = sanitizeTags(dto.tags ?? []);

    if (sanitizedTags.length === 0) {
      throw new BadRequestException('At least one descriptive tag is required');
    }

    // Require a valid, active category
    const category = await this.prisma.collectionCategory.findUnique({
      where: { id: dto.categoryId },
    });
    if (!category) {
      throw new NotFoundException('Category not found');
    }
    if (!category.isActive) {
      throw new BadRequestException('This category is not active');
    }
    const finalCategoryId = dto.categoryId;
    const collectionStatus: 'DRAFT' | 'PUBLISHED' = 'DRAFT';

    // Create collection in DRAFT status
    const collectionId = uuidv4();
    const now = new Date();
    const collection = await (this.prisma.collection as any).create({
      data: {
        id: collectionId,
        owner: { connect: { id: userId } },
        title: dto.title,
        description: dto.description,
        minPrice: dto.minPrice,
        maxPrice: dto.maxPrice,
        isAvailableInStore: dto.isAvailableInStore ?? false,
        tags: sanitizedTags,
        status: collectionStatus,
        visibility: dto.visibility ?? CollectionVisibility.PUBLIC,
        type: dto.type ?? CollectionType.EVERYBODY,
        // Set required category
        category: { connect: { id: finalCategoryId } },
        lastActivityAt: now,
        draftVersion: 0,
      },
    });

    // Generate presigned URLs for each file using UploadService (creates presign DB entries)
    const uploadData = await Promise.all(
      dto.files.map(async (fileSpec, index) => {
        // Validate and determine file type
        const fileType = this.helperservice.determineFileType(
          fileSpec.type,
          fileSpec.fileType,
        );
        this.helperservice.validateFileSpec(fileSpec, fileType);

        // Use UploadService to create presigned POST and presign DB record
        const presign = await this.uploadService.createPresignedPost(
          userId,
          fileSpec.name,
          fileType as any,
          fileSpec.type,
          { collectionId, orderIndex: index },
        );

        return {
          fileId: (presign as any).fileId,
          orderIndex: index,
          expectedKey: (presign as any).key,
          uploadUrl: (presign as any).url,
          uploadFields: (presign as any).fields,
          expiresIn: (presign as any).expiresIn || 600, // default 10 minutes
        };
      }),
    );

    return {
      collectionId: collection.id,
      uploads: uploadData,
      expiresIn: 600,
      tags: sanitizedTags,
      // Draft status (simplified)
      draftStatus: {
        isDraft: collectionStatus === 'DRAFT',
      },
    };
  }

  async getMarketFeed(options?: {
    cursor?: string;
    limit?: number;
    tag?: string;
    category?: string;
    countsPolicy?: 'combined';
    requesterId?: string; // Add requesterId to check like status
  }) {
    const { cursor, limit = 20, tag, category, requesterId } = options ?? {};
    const take = Math.min(Math.max(limit, 1), 40);

    const where: Prisma.CollectionMediaWhereInput = {
      collection: {
        status: 'PUBLISHED',
        visibility: CollectionVisibility.PUBLIC,
        deletedAt: null,
        isAvailableInStore: false,
        ...(tag
          ? {
              tags: {
                has: tag,
              },
            }
          : {}),
        ...(category && category !== 'ALL'
          ? {
              category: {
                slug: category,
              },
            }
          : {}),
      } as any,
    };

    const medias = await this.prisma.collectionMedia.findMany({
      where,
      take: take + 1,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      orderBy: [
        {
          file: {
            createdAt: 'desc',
          },
        },
        {
          collection: {
            createdAt: 'desc',
          },
        },
        {
          orderIndex: 'asc',
        },
      ],
      include: {
        file: true,
        collection: {
          include: {
            owner: {
              select: {
                id: true,
                username: true,
                brandFullName: true,
                profileImage: true,
                profileImageId: true,
                profileImageFile: {
                  select: {
                    id: true,
                    s3Url: true,
                    fileName: true,
                    originalName: true,
                  },
                },
              },
            },
            _count: {
              select: {
                reactions: true,
                comments: true,
                patches: true,
              },
            },
          },
        },
      },
    });

    const hasNextPage = medias.length > take;
    const data = hasNextPage ? medias.slice(0, -1) : medias;

    // Hydrate isLiked for requester when available
    let isLikedMap: Record<string, boolean> = {};
    if (requesterId) {
      const mediaIds = data.map((m) => m.id);
      if (mediaIds.length) {
        const liked = await this.prisma.collectionMediaReaction.findMany({
          where: {
            userId: requesterId,
            type: 'LIKE',
            collectionMediaId: { in: mediaIds },
          },
          select: { collectionMediaId: true },
        });
        const set = new Set(liked.map((r) => r.collectionMediaId));
        isLikedMap = mediaIds.reduce(
          (acc, id) => {
            acc[id] = set.has(id);
            return acc;
          },
          {} as Record<string, boolean>,
        );
      }
    }

    // Collect all file IDs that need signed URLs
    const fileIds = new Set<string>();
    data.forEach((media) => {
      if (media.fileUploadId) {
        fileIds.add(media.fileUploadId);
      }
      const owner = media.collection.owner;
      if (owner.profileImageId) {
        fileIds.add(owner.profileImageId);
      } else if (owner.profileImageFile?.id) {
        fileIds.add(owner.profileImageFile.id);
      }
    });

    // Batch generate signed URLs for all files
    const signedUrlMap = await this.uploadService.getBatchPublicSignedUrls(
      Array.from(fileIds),
    );

    const items = data.map((media) => {
      const { collection } = media;
      const owner = collection.owner;
      const file = media.file;

      // Get signed URL for media file
      const mediaSignedUrl = media.fileUploadId
        ? (signedUrlMap.get(media.fileUploadId) ?? null)
        : null;

      // Get signed URL for brand logo
      const logoFileId = owner.profileImageId ?? owner.profileImageFile?.id;
      const logoSignedUrl = logoFileId
        ? (signedUrlMap.get(logoFileId) ?? null)
        : null;

      const base = {
        id: media.id,
        collectionId: media.collectionId,
        mediaType: media.mediaType,
        mediaFileId: media.fileUploadId,
        mediaUrl: mediaSignedUrl, // Now contains actual signed URL
        createdAt: file?.createdAt ?? collection.createdAt,
        collectionTitle: collection.title ?? '',
        collectionDescription: collection.description ?? '',
        minPrice: collection.minPrice,
        maxPrice: collection.maxPrice,
        // Sale price fields for frontend display
        saleMinPrice: collection.saleMinPrice,
        saleMaxPrice: collection.saleMaxPrice,
        saleStartAt: collection.saleStartAt,
        saleEndAt: collection.saleEndAt,
        likesCount: media.likesCount,
        commentsCount: media.commentsCount,
        patchesCount: collection.patchesCount,
        tags: collection.tags ?? [],
        brandId: owner.id,
        brandName: owner.brandFullName ?? owner.username ?? '',
        username: owner.username ?? '',
        brandLogo: logoSignedUrl ?? owner.profileImage ?? null, // Signed URL or fallback
        brandLogoFileId: logoFileId ?? null,
        isLiked: requesterId ? !!isLikedMap[media.id] : false, // Add like status for requester
      };
      // Optionally include combinedCommentsCount for frontend normalization
      if (options?.countsPolicy === 'combined') {
        (base as any).combinedCommentsCount =
          (collection.commentsCount ?? 0) + (media.commentsCount ?? 0);
      }
      return base;
    });
    return {
      items,
      hasNextPage,
      nextCursor: hasNextPage ? (data[data.length - 1]?.id ?? null) : null,
    };
  }

  /**
   * STEP 2: Finalize collection after S3 uploads complete
   */
  async finalizeCollection(
    collectionId: string,
    userId: string,
    dto: FinalizeCollectionDto,
  ) {
    // Verify collection exists and belongs to user
    const collection = await this.prisma.collection.findFirst({
      where: { id: collectionId, ownerId: userId },
    });

    if (!collection) {
      throw new NotFoundException('Collection not found or not owned by user');
    }

    if (collection.status !== 'DRAFT') {
      if (collection.status === 'PUBLISHED') {
        const published = await this.prisma.collection.findUnique({
          where: { id: collectionId },
          include: {
            owner: true,
            medias: { include: { file: true }, orderBy: { orderIndex: 'asc' } },
            _count: {
              select: {
                reactions: true,
                comments: true,
                patches: true,
                views: true,
              },
            },
          },
        });
        if (published) return published;
      }
      throw new BadRequestException('Collection is not in draft status');
    }

    const hasCompletions = Array.isArray(dto.completions) && dto.completions.length > 0;

    if (!hasCompletions) {
      const previousVisibility = collection.visibility;
      if (!dto.collectionMetadata && !dto.action && dto.shouldPublish === undefined) {
        throw new BadRequestException('Missing upload completions');
      }
      const metadata = dto.collectionMetadata ?? {};
      const action = dto.action ?? (dto.shouldPublish === false ? 'draft' : 'publish');

      if (action === 'publish') {
        const nextTitle = metadata.title ?? collection.title;
        if (!nextTitle || !nextTitle.trim()) {
          throw new BadRequestException('Title is required to publish');
        }
        const nextTags = Array.isArray(metadata.tags) ? metadata.tags : collection.tags ?? [];
        if (sanitizeTags(nextTags).length === 0) {
          throw new BadRequestException('At least one descriptive tag is required');
        }
        const nextCategoryId = metadata.categoryId ?? collection.categoryId;
        if (!nextCategoryId) {
          throw new BadRequestException('Category is required to publish');
        }
        const category = await this.prisma.collectionCategory.findUnique({
          where: { id: nextCategoryId },
          select: { id: true, isActive: true },
        });
        if (!category) throw new NotFoundException('Category not found');
        if (!category.isActive) throw new BadRequestException('This category is not active');
      }

      const updated = await this.prisma.$transaction(async (tx) => {
        const links = await tx.collectionProduct.findMany({
            where: { collectionId },
            include: {
              product: {
                select: {
                  price: true,
                  salePrice: true,
                  saleStartAt: true,
                  saleEndAt: true,
                  isActive: true,
                  deletedAt: true,
                  publishAt: true,
                  archivedAt: true,
                  images: true,
                  thumbnail: true,
                  variants: { select: { price: true } },
                },
              },
            },
          });

        if (action === 'publish' && links.length === 0) {
          throw new BadRequestException('Cannot publish without products');
        }

        const now = new Date();
        const activeProducts = links.filter((l) => {
          const p = l.product;
          if (!p || p.deletedAt || p.archivedAt || !p.isActive) return false;
          if (p.publishAt && p.publishAt > now) return false;
          return true;
        });

        if (action === 'publish') {
          const hasProductMedia = activeProducts.some((l) => {
            const p = l.product;
            const images = Array.isArray(p.images) ? p.images.filter(Boolean) : [];
            return images.length > 0 || Boolean(p.thumbnail);
          });
          if (!hasProductMedia) {
            throw new BadRequestException('At least one product image is required to publish');
          }
        }

        const prices = activeProducts
          .map((l) => {
            const p = l.product;
            const variantPrices = Array.isArray(p.variants)
              ? p.variants.map((v) => Number(v.price || 0)).filter((v) => v > 0)
              : [];
            if (variantPrices.length > 0) return Math.min(...variantPrices);
            return Number(p.price || 0);
          })
          .filter((v) => v > 0);

        const maxPrices = activeProducts
          .map((l) => {
            const p = l.product;
            const variantPrices = Array.isArray(p.variants)
              ? p.variants.map((v) => Number(v.price || 0)).filter((v) => v > 0)
              : [];
            if (variantPrices.length > 0) return Math.max(...variantPrices);
            return Number(p.price || 0);
          })
          .filter((v) => v > 0);

        const salePrices = activeProducts
          .map((l) => {
            const p = l.product;
            if (!p.salePrice) return null;
            if (p.saleStartAt && p.saleStartAt > now) return null;
            if (p.saleEndAt && p.saleEndAt < now) return null;
            return Number(p.salePrice);
          })
          .filter((v): v is number => typeof v === 'number' && v > 0);

        return tx.collection.update({
          where: { id: collectionId },
          data: {
            title: metadata.title ?? collection.title,
            description: metadata.description ?? collection.description,
            visibility: metadata.visibility ?? collection.visibility,
            type: metadata.type ?? collection.type,
            categoryId: metadata.categoryId ?? collection.categoryId,
            isAvailableInStore:
              typeof metadata.isAvailableInStore === 'boolean'
                ? metadata.isAvailableInStore
                : collection.isAvailableInStore,
            tags: Array.isArray(metadata.tags)
              ? sanitizeTags(metadata.tags)
              : collection.tags,
            minPrice: prices.length ? Math.min(...prices) : null,
            maxPrice: maxPrices.length ? Math.max(...maxPrices) : null,
            saleMinPrice: salePrices.length ? Math.min(...salePrices) : null,
            saleMaxPrice: salePrices.length ? Math.max(...salePrices) : null,
            status: action === 'publish' ? 'PUBLISHED' : 'DRAFT',
            ...(action === 'draft'
              ? { lastActivityAt: now, draftVersion: { increment: 1 } }
              : {}),
          },
        });
      });

      if (
        (metadata.visibility ?? collection.visibility) !== previousVisibility &&
        (metadata.visibility ?? collection.visibility) === CollectionVisibility.PRIVATE
      ) {
        await this.handleVisibilityChange(collectionId, 'PRIVATE', userId);
      }

      return updated;
    }

    // Verify all uploads completed successfully and create central FileUpload records via UploadService
    const completionIds = new Set<string>();
    for (const c of dto.completions ?? []) {
      if (completionIds.has(c.fileId)) {
        throw new BadRequestException('Duplicate completion fileId');
      }
      completionIds.add(c.fileId);
    }

    const verifiedFiles = await Promise.all(
      (dto.completions ?? []).map(async (completion) => {
        const presign = await this.prisma.presignedUpload.findUnique({
          where: { id: completion.fileId },
        });
        if (!presign) {
          throw new BadRequestException('Presign record not found');
        }
        if (presign.userId !== userId) {
          throw new ForbiddenException('Presign record does not belong to user');
        }
        if (presign.collectionId && presign.collectionId !== collectionId) {
          throw new BadRequestException('Presign record not linked to collection');
        }
        if (presign.s3Key !== completion.s3Key) {
          throw new BadRequestException('S3 key mismatch for presign record');
        }
        const now = new Date();
        if (presign.expiresAt && presign.expiresAt < now) {
          await this.prisma.presignedUpload.update({
            where: { id: completion.fileId },
            data: { status: 'EXPIRED' },
          });
          throw new BadRequestException('Presign has expired');
        }
        if (presign.status === 'USED') {
          const existing = await this.prisma.fileUpload.findUnique({
            where: { id: completion.fileId },
          });
          if (existing) {
            return { file: existing, orderIndex: presign.orderIndex ?? null };
          }
          throw new BadRequestException('Presign already used');
        }
        if (presign.status === 'EXPIRED') {
          throw new BadRequestException('Presign has expired');
        }
        if (presign.status !== 'PENDING' && presign.status !== 'READY') {
          throw new BadRequestException('Presign is not ready for use');
        }

        const exists = await this.uploadService.verifyObjectExists(
          completion.s3Key,
        );
        if (!exists) {
          throw new BadRequestException(
            `File not found in S3: ${completion.s3Key}`,
          );
        }

        const existing = await this.prisma.fileUpload.findUnique({
          where: { id: completion.fileId },
        });
        if (existing) {
          return { file: existing, orderIndex: presign.orderIndex ?? null };
        }

        const fileUpload = await this.uploadService.createFileRecordFromPresign(
          completion.fileId,
          userId,
          completion.s3Key,
          completion.actualMimeType,
          completion.actualSize,
        );

        return { file: fileUpload, orderIndex: presign.orderIndex ?? null };
      }),
    );

    await this.prisma.$transaction(async (tx) => {
      for (const [index, entry] of verifiedFiles.entries()) {
        const file = entry.file;
        const orderIndex = typeof entry.orderIndex === 'number' ? entry.orderIndex : index;
        const existingMedia = await tx.collectionMedia.findFirst({
          where: { collectionId: collection.id, fileUploadId: file.id },
        });
        if (existingMedia) continue;
        await tx.collectionMedia.create({
          data: {
            id: uuidv4(),
            collectionId: collection.id,
            fileUploadId: file.id,
            orderIndex,
            mediaType: file.fileType,
          },
        });
      }
    });

    let coverMediaId: string | null = dto.coverMediaId ?? null;
    if (coverMediaId) {
      const belongs = await this.prisma.collectionMedia.findFirst({
        where: { id: coverMediaId, collectionId },
        select: { id: true },
      });
      if (!belongs) {
        throw new BadRequestException('coverMediaId does not belong to collection');
      }
    } else if (typeof dto.coverIndex === 'number') {
      const cover = await this.prisma.collectionMedia.findFirst({
        where: { collectionId, orderIndex: dto.coverIndex },
        select: { id: true },
      });
      coverMediaId = cover?.id ?? null;
    } else {
      const first = await this.prisma.collectionMedia.findFirst({
        where: { collectionId },
        orderBy: { orderIndex: 'asc' },
        select: { id: true },
      });
      coverMediaId = first?.id ?? null;
    }

    // Mark collection as published (or keep as DRAFT if requested)
    const newStatus = dto.shouldPublish === false ? 'DRAFT' : 'PUBLISHED';
    const finalizeAt = new Date();
    const publishedCollection = await this.prisma.collection.update({
      where: { id: collectionId },
      data: {
        status: newStatus,
        coverMediaId,
        ...(newStatus === 'DRAFT'
          ? { lastActivityAt: finalizeAt, draftVersion: { increment: 1 } }
          : {}),
      },
      include: {
        owner: true,
        medias: { include: { file: true }, orderBy: { orderIndex: 'asc' } },
        _count: {
          select: {
            reactions: true,
            comments: true,
            patches: true,
            views: true,
          },
        },
      },
    });

    // Notify followers if published
    if (newStatus === 'PUBLISHED' && this.notifications) {
      // Fetch followers
      const followers = await this.prisma.follow.findMany({
        where: { followingId: userId },
        select: { followerId: true },
      });

      // Fan-out notifications
      for (const f of followers) {
        try {
          await this.notifications.create(
            f.followerId,
            NotificationType.COLLECTION_UPLOAD,
            {
              actorId: userId,
              payload: {
                collectionId: publishedCollection.id,
                collectionTitle: publishedCollection.title,
                targetUrl: `/collections/${publishedCollection.id}`,
                message: `${publishedCollection.owner.brandFullName || publishedCollection.owner.username} created a new collection: ${publishedCollection.title}`,
              },
            },
          );
        } catch (e) {
          console.warn(`Failed to notify follower ${f.followerId}`, e);
        }
      }
    }

    return publishedCollection;
  }

  // ===================== Store Collection Membership =====================
  async addProductsToCollection(
    collectionId: string,
    ownerId: string,
    productIds: string[],
  ) {
    await this.assertOwner(collectionId, ownerId);
    if (!Array.isArray(productIds) || productIds.length === 0) {
      throw new BadRequestException('productIds is required');
    }

    return this.prisma.$transaction(async (tx) => {
      await this.lockCollectionForUpdate(tx, collectionId);
      const products = await tx.product.findMany({
        where: { id: { in: productIds }, deletedAt: null },
        include: { brand: true },
      });

      if (products.length !== productIds.length) {
        throw new NotFoundException('One or more products not found');
      }

      for (const p of products) {
        if (p.brand?.ownerId !== ownerId) {
          throw new ForbiddenException('Not owner of one or more products');
        }
      }

      const existingLinks = await tx.collectionProduct.findMany({
        where: { collectionId, productId: { in: productIds } },
        select: { productId: true },
      });
      const existingSet = new Set(existingLinks.map((l) => l.productId));

      const existingCount = await tx.collectionProduct.count({
        where: { collectionId },
      });
      const newIds = productIds.filter((id) => !existingSet.has(id));
      if (existingCount + newIds.length > this.maxProductsPerCollection) {
        throw new BadRequestException(
          `Collections can contain maximum ${this.maxProductsPerCollection} products.`,
        );
      }

      let nextOrderIndex = existingCount;

      for (const productId of productIds) {
        if (existingSet.has(productId)) continue;

        const memberships = await tx.collectionProduct.findMany({
          where: { productId },
          select: { collectionId: true },
        });
        const memberCollectionIds = memberships.map((m) => m.collectionId);
        if (memberCollectionIds.length >= 3) {
          throw new ConflictException({
            code: 'COLLECTION_MAX_MEMBERSHIP',
            message: 'Product already belongs to maximum 3 collections.',
            conflictingCollectionIds: memberCollectionIds,
          } as any);
        }

        const orderIndex = nextOrderIndex;
        nextOrderIndex += 1;

        const existingPrimary = await tx.collectionProduct.findFirst({
          where: { productId, isPrimary: true },
          select: { collectionId: true },
        });
        const shouldBePrimary = !existingPrimary;

        await tx.collectionProduct.create({
          data: {
            id: uuidv4(),
            collectionId,
            productId,
            orderIndex,
            isPrimary: shouldBePrimary,
          },
        });

        if (shouldBePrimary) {
          await this.enforcePrimaryMembership(tx, productId);
        }
      }

      await this.touchDraftActivity(tx, collectionId);
      await this.recalculateCollectionPriceRange(collectionId);
      return { success: true };
    });
  }

  async removeProductsFromCollection(
    collectionId: string,
    ownerId: string,
    productIds: string[],
  ) {
    await this.assertOwner(collectionId, ownerId);
    if (!Array.isArray(productIds) || productIds.length === 0) {
      throw new BadRequestException('productIds is required');
    }

    return this.prisma.$transaction(async (tx) => {
      await this.lockCollectionForUpdate(tx, collectionId);
      const existingLinks = await tx.collectionProduct.findMany({
        where: { collectionId, productId: { in: productIds } },
        select: { productId: true, isPrimary: true },
      });

      await tx.collectionProduct.deleteMany({
        where: { collectionId, productId: { in: productIds } },
      });

      for (const productId of productIds) {
        const removedPrimary = existingLinks.find(
          (l) => l.productId === productId && l.isPrimary,
        );
        if (removedPrimary) {
          await this.enforcePrimaryMembership(tx, productId);
        } else {
          await this.enforcePrimaryMembership(tx, productId);
        }
      }

      await this.touchDraftActivity(tx, collectionId);
      await this.recalculateCollectionPriceRange(collectionId);

      return { success: true };
    });
  }

  async reorderCollectionProducts(
    collectionId: string,
    ownerId: string,
    items: Array<{ productId: string; orderIndex: number }>,
  ) {
    await this.assertOwner(collectionId, ownerId);
    if (!Array.isArray(items) || items.length === 0) {
      throw new BadRequestException('items is required');
    }

    const productIdSet = new Set(items.map((i) => i.productId));
    if (productIdSet.size !== items.length) {
      throw new BadRequestException('Duplicate productId in reorder request');
    }
    const orderIndexSet = new Set(items.map((i) => i.orderIndex));
    if (orderIndexSet.size !== items.length) {
      throw new BadRequestException('Duplicate orderIndex in reorder request');
    }
    if (items.some((item) => item.orderIndex < 0)) {
      throw new BadRequestException('orderIndex must be non-negative');
    }

    const existing = await this.prisma.collectionProduct.findMany({
      where: { collectionId },
      select: { productId: true },
    });
    const existingIds = new Set(existing.map((e) => e.productId));
    if (existingIds.size !== items.length) {
      throw new BadRequestException('items must include all products in collection');
    }
    for (const item of items) {
      if (!existingIds.has(item.productId)) {
        throw new NotFoundException('Product not found in collection');
      }
    }

    const normalized = [...items]
      .sort((a, b) => a.orderIndex - b.orderIndex)
      .map((item, index) => ({ productId: item.productId, orderIndex: index }));

    await this.prisma.$transaction(async (tx) => {
      for (const item of normalized) {
        await tx.collectionProduct.updateMany({
          where: { collectionId, productId: item.productId },
          data: { orderIndex: item.orderIndex },
        });
      }

      await this.touchDraftActivity(tx, collectionId);
    });

    return { success: true };
  }

  async archiveCollection(collectionId: string, ownerId: string) {
    await this.assertOwner(collectionId, ownerId);
    const collection = await this.prisma.collection.findUnique({
      where: { id: collectionId },
      select: { status: true },
    });
    if (!collection) throw new NotFoundException('Collection not found');
    if (collection.status === 'ARCHIVED') {
      return { success: true, status: 'ARCHIVED' };
    }

    const activeOrdersCount = await this.countActiveOrdersForCollection(
      collectionId,
      ownerId,
    );
    if (activeOrdersCount > 0) {
      throw new ConflictException({
        code: 'COLLECTION_ARCHIVE_BLOCKED',
        message: `Cannot archive collection with ${activeOrdersCount} active orders.`,
        activeOrdersCount,
      } as any);
    }

    await this.prisma.collection.update({
      where: { id: collectionId },
      data: { status: 'ARCHIVED', archivedFromStatus: collection.status },
    });
    return { success: true, status: 'ARCHIVED' };
  }

  async unarchiveCollection(collectionId: string, ownerId: string) {
    await this.assertOwner(collectionId, ownerId);
    const collection = await this.prisma.collection.findUnique({
      where: { id: collectionId },
      select: { status: true, archivedFromStatus: true },
    });
    if (!collection) throw new NotFoundException('Collection not found');
    if (collection.status !== 'ARCHIVED') {
      throw new BadRequestException('Collection is not archived');
    }

    const restoreStatus = collection.archivedFromStatus ?? 'DRAFT';
    await this.prisma.collection.update({
      where: { id: collectionId },
      data: { status: restoreStatus, archivedFromStatus: null },
    });
    return { success: true, status: restoreStatus };
  }

  async applyTemplateToCollectionProducts(
    collectionId: string,
    ownerId: string,
    template: {
      description?: string;
      tags?: string[];
      basePrice?: number;
      sizeOptions?: string[];
    },
  ) {
    await this.assertOwner(collectionId, ownerId);
    const links = await this.prisma.collectionProduct.findMany({
      where: { collectionId },
      select: { productId: true },
    });
    const productIds = links.map((l) => l.productId);
    if (productIds.length === 0) return { success: true };

    const data: Prisma.ProductUpdateInput = {};
    if (typeof template.description === 'string') {
      data.description = template.description;
    }
    if (Array.isArray(template.tags)) {
      data.tags = sanitizeTags(template.tags);
    }
    if (typeof template.basePrice === 'number') {
      data.price = new Prisma.Decimal(template.basePrice);
    }
    if (Array.isArray(template.sizeOptions)) {
      data.sizes = template.sizeOptions;
    }

    await this.prisma.product.updateMany({
      where: { id: { in: productIds } },
      data,
    });

    await this.recalculateCollectionPriceRange(collectionId);

    return { success: true };
  }

  async createProductInCollection(
    collectionId: string,
    ownerId: string,
    dto: CreateProductDto,
  ) {
    await this.assertOwner(collectionId, ownerId);
    const created = await this.storeService.createProduct(ownerId, {
      ...dto,
      collectionId,
    });
    await (this.prisma.collection as any).updateMany({
      where: { id: collectionId, status: 'DRAFT', deletedAt: null },
      data: { lastActivityAt: new Date(), draftVersion: { increment: 1 } },
    });
    return created;
  }

  /**
   * Enhanced get method with proper includes
   */
  async getCollection(id: string, requesterId?: string) {
    const ok = await this.canViewCollection(id, requesterId);
    if (!ok) throw new NotFoundException('Collection not found');
    const collection = (await this.prisma.collection.findUnique({
      where: { id },
      include: {
        owner: {
          select: {
            id: true,
            username: true,
            firstName: true,
            lastName: true,
            brandFullName: true,
            profileImage: true,
            profileImageId: true,
            profileImageFile: {
              select: {
                id: true,
                s3Url: true,
                fileName: true,
                originalName: true,
                createdAt: true,
                updatedAt: true,
              },
            },
          },
        },
        medias: {
          include: { file: true },
          orderBy: { orderIndex: 'asc' },
        },
        products: {
          include: {
            product: {
              include: { variants: { select: { id: true } } },
            },
          },
          orderBy: { orderIndex: 'asc' },
        },
        reactions: {
          include: {
            user: {
              select: {
                id: true,
                username: true,
                firstName: true,
                lastName: true,
              },
            },
          },
        },
        _count: {
          select: {
            reactions: true,
            comments: true,
            patches: true,
            views: true,
            medias: true,
          },
        },
      },
    } as any)) as any;

    if (!collection) {
      throw new NotFoundException('Collection not found');
    }

    if (collection.deletedAt) {
      throw new GoneException('Collection has been deleted');
    }

    const isOwner = !!(requesterId && collection.ownerId === requesterId);
    if (!isOwner && Array.isArray(collection.products)) {
      const now = new Date();
      collection.products = collection.products.filter((link: any) => {
        const p = link?.product;
        if (!p) return false;
        if (p.deletedAt || p.archivedAt || !p.isActive) return false;
        if (p.publishAt && new Date(p.publishAt).getTime() > now.getTime()) return false;
        return true;
      });
    }

    const mediaAgg = await this.prisma.collectionMedia.aggregate({
      where: { collectionId: id },
      _sum: { likesCount: true },
    });
    const totalLikes = collection.likesCount + (mediaAgg._sum.likesCount ?? 0);

    let products = collection.products;
    if (!isOwner) {
      const now = new Date();
      products = (collection.products || []).filter((link) => {
        const p = (link as any)?.product;
        if (!p) return false;
        if (p.deletedAt || p.archivedAt || !p.isActive) return false;
        if (p.publishAt && p.publishAt > now) return false;
        return true;
      }) as any;
    }

    const preferredCover = collection.coverMediaId
      ? collection.medias?.find((m: any) => m.id === collection.coverMediaId)
      : collection.medias?.[0];
    const coverFromMedia = preferredCover?.file?.s3Url ?? null;
    const coverFromProduct = (products || []).find((link: any) => {
      const p = link?.product;
      const images = Array.isArray(p?.images) ? p.images : [];
      return Boolean(p?.thumbnail) || images.length > 0;
    });
    const productCoverUrl = coverFromProduct?.product?.thumbnail
      ?? (Array.isArray(coverFromProduct?.product?.images)
        ? coverFromProduct.product.images[0]
        : null);

    return { ...collection, products, totalLikes, coverImageUrl: coverFromMedia || productCoverUrl };
  }

  /**
   * PHASE 6: Get draft collections for current user
   */
  async getMyDraftCollections(userId: string) {
    const items = await this.prisma.collection.findMany({
      where: {
        ownerId: userId,
        status: 'DRAFT',
        deletedAt: null,
      },
      orderBy: { createdAt: 'desc' },
      include: {
        medias: {
          include: { file: true },
          orderBy: { orderIndex: 'asc' },
          take: 1,
        },
        _count: {
          select: { medias: true },
        },
      },
    });

    // Generate signed URLs for cover images
    const fileIds = items
      .map((c) => c.medias[0]?.fileUploadId)
      .filter((id): id is string => !!id);

    const signedUrlMap =
      await this.uploadService.getBatchPublicSignedUrls(fileIds);

    return {
      items: items.map((c) => {
        const firstMedia = c.medias[0];
        const coverImage = firstMedia?.fileUploadId
          ? (signedUrlMap.get(firstMedia.fileUploadId) ?? null)
          : null;

        return {
          id: c.id,
          title: c.title,
          description: c.description,
          pendingCategoryName: c.pendingCategoryName,
          draftReason: c.draftReason,
          createdAt: c.createdAt,
          itemCount: c._count.medias,
          coverImage,
        };
      }),
    };
  }

  /**
   * Get collections for a specific user (optionally show drafts to owner)
   */
  async getUserCollections(
    userId: string,
    requesterId?: string,
    options?: {
      cursor?: string;
      limit?: number;
      visibility?: 'public' | 'private' | 'all';
    },
  ) {
    const { cursor, limit = 20, visibility } = options || {};
    const privateFeature =
      (process.env.FEATURE_PRIVATE_COLLECTIONS ?? 'true') !== 'false';
    const where: any = { ownerId: userId, deletedAt: null };
    const now = new Date();
    const productVisibilityWhere =
      requesterId === userId
        ? undefined
        : {
            deletedAt: null,
            archivedAt: null,
            isActive: true,
            OR: [{ publishAt: null }, { publishAt: { lte: now } }],
          };
    try {
      console.log(
        '[collections.service.getUserCollections] userId=%s requesterId=%s visibility=%s featurePrivate=%s',
        userId,
        requesterId ?? 'anon',
        visibility ?? 'public',
        privateFeature,
      );
    } catch {}

    // Default: published only for non-owner
    if (requesterId !== userId) {
      where.status = 'PUBLISHED';

      if (!visibility || visibility === 'public') {
        (where as any).visibility = CollectionVisibility.PUBLIC;
      } else if (visibility === 'private') {
        if (!privateFeature) {
          (where as any).visibility = CollectionVisibility.PUBLIC; // feature disabled, fallback to public only
        } else {
          (where as any).visibility = CollectionVisibility.PRIVATE;
          // Only those private collections the requester is approved to view
          (where as any).accesses = {
            some: { viewerId: requesterId, state: 'APPROVED' },
          };
        }
      } else if (visibility === 'all') {
        if (!privateFeature) {
          (where as any).visibility = CollectionVisibility.PUBLIC;
        } else {
          // public OR approved private
          (where as any).OR = [
            { visibility: CollectionVisibility.PUBLIC },
            {
              visibility: CollectionVisibility.PRIVATE,
              accesses: { some: { viewerId: requesterId, state: 'APPROVED' } },
            },
          ];
          delete (where as any).visibility;
        }
      }
    } else {
      // Owner view: show by requested visibility or all
      // Filter out DRAFT collections from the main list to avoid showing failed/incomplete collections.
      where.status = 'PUBLISHED';

      if (visibility === 'public') {
        (where as any).visibility = CollectionVisibility.PUBLIC;
      } else if (visibility === 'private') {
        if (privateFeature) {
          (where as any).visibility = CollectionVisibility.PRIVATE;
        } else {
          (where as any).visibility = CollectionVisibility.PUBLIC;
        }
      }
    }

    const items = await this.prisma.collection.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      select: {
        id: true,
        ownerId: true,
        title: true,
        description: true,
        status: true,
        visibility: true,
        type: true,
        categoryId: true,
        pendingCategorySuggestionId: true,
        draftReason: true,
        pendingCategoryName: true,
        originalSuggestionId: true,
        coverMediaId: true,
        minPrice: true,
        maxPrice: true,
        isAvailableInStore: true,
        tags: true,
        saleMinPrice: true,
        saleMaxPrice: true,
        saleStartAt: true,
        saleEndAt: true,
        createdAt: true,
        updatedAt: true,
        likesCount: true,
        dislikesCount: true,
        commentsCount: true,
        patchesCount: true,
        viewsCount: true,
        medias: {
          include: { file: true },
          orderBy: { orderIndex: 'asc' },
          // Removed take: 1 to get all medias for correct counts
        },
        products: {
          ...(productVisibilityWhere
            ? { where: { product: productVisibilityWhere } }
            : {}),
          include: {
            product: {
              select: { thumbnail: true, images: true },
            },
          },
          orderBy: { orderIndex: 'asc' },
          take: 1,
        },
        _count: {
          select: {
            reactions: true,
            comments: true,
            patches: true,
            views: true,
            medias: true,
          },
        },
        owner: {
          select: {
            id: true,
            username: true,
            brandFullName: true,
            profileImage: true,
            profileImageId: true,
            profileImageFile: {
              select: {
                id: true,
                s3Url: true,
                fileName: true,
                originalName: true,
                createdAt: true,
                updatedAt: true,
              },
            },
          },
        },
      },
    });
    try {
      console.log(
        '[collections.service.getUserCollections] rows=%d where=%j',
        items.length,
        where,
      );
    } catch {}

    const hasNext = items.length > limit;
    const data = hasNext ? items.slice(0, -1) : items;

    // Hydrate isLiked for requester when available
    let isLikedMap: Record<string, boolean> = {};
    if (requesterId) {
      const ids = data.map((c) => c.id);
      if (ids.length) {
        const liked = await this.prisma.collectionReaction.findMany({
          where: {
            userId: requesterId,
            type: 'LIKE',
            collectionId: { in: ids },
          },
          select: { collectionId: true },
        });
        const set = new Set(liked.map((r) => r.collectionId));
        isLikedMap = ids.reduce(
          (acc, id) => {
            acc[id] = set.has(id);
            return acc;
          },
          {} as Record<string, boolean>,
        );
      }
    }

    // Collect file IDs for batch signing
    const fileIds = new Set<string>();
    data.forEach((c) => {
      // Cover image (prefer coverMediaId)
      const preferredCover = c.coverMediaId
        ? c.medias?.find((m: any) => m.id === c.coverMediaId)
        : c.medias?.[0];
      if (preferredCover?.file?.id) {
        fileIds.add(preferredCover.file.id);
      }
      // Brand logo
      if (c.owner?.profileImageFile?.id) {
        fileIds.add(c.owner.profileImageFile.id);
      } else if (c.owner?.profileImageId) {
        fileIds.add(c.owner.profileImageId);
      }
    });

    const signedUrlMap = await this.uploadService.getBatchPublicSignedUrls(
      Array.from(fileIds),
    );

    return {
      items: data.map((c) => {
        // Inject signed URLs
        const mappedMedias = c.medias.map((m) => {
          if (m.file && signedUrlMap.has(m.file.id)) {
            return {
              ...m,
              file: { ...m.file, s3Url: signedUrlMap.get(m.file.id)! },
            };
          }
          return m;
        });

        const owner = c.owner;
        let ownerWithSignedUrl = owner;
        const logoId = owner?.profileImageFile?.id || owner?.profileImageId;
        if (logoId && signedUrlMap.has(logoId)) {
          ownerWithSignedUrl = {
            ...owner,
            profileImage: signedUrlMap.get(logoId)!, // Update profileImage string too
            profileImageFile: owner.profileImageFile
              ? {
                  ...owner.profileImageFile,
                  s3Url: signedUrlMap.get(logoId)!,
                }
              : null,
          };
        }

        return {
          ...c,
          medias: mappedMedias,
          owner: ownerWithSignedUrl,
          isLiked: requesterId ? !!isLikedMap[c.id] : false,
        };
      }),
      hasNextPage: hasNext,
      endCursor: data.length ? data[data.length - 1].id : null,
    };
  }

  /**
   * Delete entire collection and all its media (S3 + DB)
   */
  async deleteCollection(collectionId: string, requesterId: string) {
    // Verify collection and ownership
    const collection = (await this.prisma.collection.findUnique({
      where: { id: collectionId },
      include: { medias: { include: { file: true } } },
    } as any)) as any;
    if (!collection) throw new NotFoundException('Collection not found');
    if (collection.ownerId !== requesterId)
      throw new ForbiddenException('Not owner of collection');

    if (collection.deletedAt) {
      return { success: true, deletedAt: collection.deletedAt };
    }

    const now = new Date();
    const deleteExpiresAt = new Date(now.getTime() + this.collectionDeleteWindowMs);

    await this.prisma.collection.update({
      where: { id: collectionId },
      data: {
        deletedAt: now,
        deleteExpiresAt,
      },
    });

    const productLinks = await this.prisma.collectionProduct.findMany({
      where: { collectionId },
      select: { productId: true },
    });
    const productIds = productLinks.map((l) => l.productId);
    if (productIds.length) {
      await this.prisma.cartItem.deleteMany({ where: { productId: { in: productIds } } });
      await this.prisma.wishlistItem.deleteMany({ where: { productId: { in: productIds } } });
    }

    // Create notification for successful deletion (informational, no action link)
    if (this.notifications) {
      try {
        await this.notifications.create(
          requesterId,
          'COLLECTION_DELETED' as any,
          {
            payload: {
              collectionName: collection.title || 'Collection',
              message: `Your collection "${collection.title || 'Untitled'}" has been deleted. You can restore it until ${deleteExpiresAt.toISOString()}.`,
              restoreBy: deleteExpiresAt.toISOString(),
            },
          },
        );
      } catch (err) {
        console.warn('Failed to create deletion notification:', err);
        // Don't fail the operation if notification fails
      }
    }

    return { success: true, deletedAt: now.toISOString(), restoreBy: deleteExpiresAt.toISOString() };
  }

  async restoreCollection(collectionId: string, ownerId: string) {
    const collection = (await this.prisma.collection.findUnique({
      where: { id: collectionId },
      select: { ownerId: true, deletedAt: true, deleteExpiresAt: true } as any,
    } as any)) as any;
    if (!collection) throw new NotFoundException('Collection not found');
    if (collection.ownerId !== ownerId) {
      throw new ForbiddenException('Not owner of collection');
    }
    if (!collection.deletedAt) {
      throw new BadRequestException('Collection is not deleted');
    }

    const now = new Date();
    if (collection.deleteExpiresAt && collection.deleteExpiresAt < now) {
      throw new GoneException('Collection recovery window has expired');
    }

    await this.prisma.collection.update({
      where: { id: collectionId },
      data: { deletedAt: null, deleteExpiresAt: null },
    });

    return { success: true };
  }

  /**
   * Delete a single collection item. If it was the only item, delete the collection as well.
   */
  async deleteCollectionItem(
    collectionId: string,
    itemId: string,
    requesterId: string,
  ) {
    // Verify collection exists and owner
    const collection = await this.prisma.collection.findUnique({
      where: { id: collectionId },
      include: { medias: { include: { file: true } } },
    });
    if (!collection) throw new NotFoundException('Collection not found');
    if (collection.ownerId !== requesterId)
      throw new ForbiddenException('Not owner of collection');

    const media = collection.medias.find(
      (m) =>
        m.id === itemId ||
        (m as any).fileUploadId === itemId ||
        m.file?.id === itemId,
    );
    if (!media) throw new NotFoundException('Collection item not found');

    // Delete S3 object for this media first
    const key = media.file?.s3Key;
    if (!key) throw new BadRequestException('No file key found for media');

    try {
      await this.uploadService.deleteS3ObjectByKey(key);
    } catch (err) {
      console.warn('Failed to delete S3 object for media:', media.id, err);
      throw new BadRequestException('Failed to delete file from storage');
    }

    // Then run DB transaction to remove fileUpload, media row, and possibly collection
    try {
      await this.prisma.$transaction(async (tx) => {
        if (media.file && media.file.id) {
          await tx.fileUpload.delete({ where: { id: media.file.id } as any });
        }

        await tx.collectionMedia.delete({ where: { id: media.id } as any });

        const remaining = await tx.collectionMedia.count({
          where: { collectionId } as any,
        });
        const productCount = await tx.collectionProduct.count({
          where: { collectionId } as any,
        });

        if (collection.coverMediaId === media.id) {
          const nextCover = await tx.collectionMedia.findFirst({
            where: { collectionId } as any,
            orderBy: { orderIndex: 'asc' },
            select: { id: true },
          });
          await tx.collection.update({
            where: { id: collectionId },
            data: { coverMediaId: nextCover?.id ?? null },
          });
        }

        if (remaining === 0 && productCount === 0) {
          const now = new Date();
          const deleteExpiresAt = new Date(
            now.getTime() + this.collectionDeleteWindowMs,
          );
          await tx.collection.update({
            where: { id: collectionId },
            data: { deletedAt: now, deleteExpiresAt },
          });
        }
      });
    } catch (err) {
      console.warn('DB transaction failed after S3 deletion for media:', err);
      throw new BadRequestException('Failed to delete media records');
    }

    const [remainingAfter, remainingProducts, deletedInfo] = await Promise.all([
      this.prisma.collectionMedia.count({ where: { collectionId } }),
      this.prisma.collectionProduct.count({ where: { collectionId } }),
      this.prisma.collection.findUnique({
        where: { id: collectionId },
        select: { deletedAt: true } as any,
      }),
    ]);
    const deletedCollection =
      !!deletedInfo?.deletedAt ||
      (remainingAfter === 0 && remainingProducts === 0);
    await (this.prisma.collection as any).updateMany({
      where: { id: collectionId, status: 'DRAFT', deletedAt: null },
      data: { lastActivityAt: new Date(), draftVersion: { increment: 1 } },
    });
    return { success: true, deletedCollection };
  }

  /**
   * Improved listing with better performance
   */
  async listCollections({
    cursor,
    limit = 20,
    requesterId,
  }: {
    cursor?: string;
    limit?: number;
    requesterId?: string;
  }) {
    const items = await this.prisma.collection.findMany({
      where: {
        status: 'PUBLISHED',
        visibility: CollectionVisibility.PUBLIC,
        deletedAt: null,
        isAvailableInStore: false,
      } as any,
      orderBy: [
        { patchesCount: 'desc' }, // Show most patched first
        { createdAt: 'desc' },
      ],
      take: limit + 1,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      include: {
        owner: {
          select: {
            id: true,
            username: true,
            firstName: true,
            lastName: true,
            brandFullName: true,
            profileImage: true,
            profileImageId: true,
            profileImageFile: {
              select: {
                id: true,
                s3Url: true,
                fileName: true,
                originalName: true,
                createdAt: true,
                updatedAt: true,
              },
            },
          },
        },
        medias: {
          include: { file: true },
          orderBy: { orderIndex: 'asc' },
          take: 1, // Only get first media for listing
        },
        _count: {
          select: {
            reactions: true,
            comments: true,
            patches: true,
            views: true,
            medias: true,
          },
        },
      },
    });

    const hasNext = items.length > limit;
    const data = hasNext ? items.slice(0, -1) : items;

    // Hydrate isLiked for requester when available
    let isLikedMap: Record<string, boolean> = {};
    if (requesterId) {
      const ids = data.map((c) => c.id);
      if (ids.length) {
        const liked = await this.prisma.collectionReaction.findMany({
          where: {
            userId: requesterId,
            type: 'LIKE',
            collectionId: { in: ids },
          },
          select: { collectionId: true },
        });
        const set = new Set(liked.map((r) => r.collectionId));
        isLikedMap = ids.reduce(
          (acc, id) => {
            acc[id] = set.has(id);
            return acc;
          },
          {} as Record<string, boolean>,
        );
      }
    }

    return {
      items: data.map((c) => ({
        ...c,
        isLiked: requesterId ? !!isLikedMap[c.id] : false,
      })),
      hasNextPage: hasNext,
      endCursor: data.length ? data[data.length - 1].id : null,
    };
  }

  /**
   * Simplified reaction toggle - your existing logic is good
   */
  async toggleReaction(
    collectionId: string,
    userId: string,
    type: ReactionType,
  ) {
    const ok = await this.canViewCollection(collectionId, userId);
    if (!ok) throw new NotFoundException('Collection not found');
    const collection = await this.prisma.collection.findUnique({
      where: { id: collectionId },
      select: { visibility: true, ownerId: true },
    });
    if (collection && collection.visibility !== CollectionVisibility.PUBLIC) {
      throw new ForbiddenException('Cannot interact with private collection');
    }

    const existing = await this.prisma.collectionReaction.findUnique({
      where: { collectionId_userId: { collectionId, userId } },
    });

    let delta = 0;
    let nowLiked = false;
    if (existing) {
      if (existing.type === type) {
        // Remove reaction
        await this.prisma.collectionReaction.delete({
          where: { id: existing.id },
        });
        if (type === ReactionType.LIKE) {
          delta = -1;
          nowLiked = false;
        }
      } else {
        // Change reaction type
        await this.prisma.collectionReaction.update({
          where: { id: existing.id },
          data: { type },
        });
        if (
          existing.type === ReactionType.DISLIKE &&
          type === ReactionType.LIKE
        ) {
          delta = +1;
        }
        if (
          existing.type === ReactionType.LIKE &&
          type === ReactionType.DISLIKE
        ) {
          // Moving from LIKE to DISLIKE decrements likes for analytics
          delta = -1;
        }
        nowLiked = type === ReactionType.LIKE;
      }
    } else {
      // Create new reaction
      await this.prisma.collectionReaction.create({
        data: {
          id: uuidv4(),
          collectionId,
          userId,
          type,
        },
      });
      if (type === ReactionType.LIKE) {
        delta = +1;
        nowLiked = true;
      }
    }

    // Update denormalized counts
    const [likes, dislikes] = await Promise.all([
      this.prisma.collectionReaction.count({
        where: { collectionId, type: ReactionType.LIKE },
      }),
      this.prisma.collectionReaction.count({
        where: { collectionId, type: ReactionType.DISLIKE },
      }),
    ]);

    const updated = await this.prisma.collection.update({
      where: { id: collectionId },
      data: { likesCount: likes, dislikesCount: dislikes },
    });

    // Update analytics daily likes if changed
    if (this.analytics && delta !== 0) {
      await this.analytics.updateDailyLike(
        ContentTarget.COLLECTION,
        collectionId,
        delta,
      );
    }

    // Notify owner when a new LIKE is added
    if (nowLiked && userId !== collection.ownerId && this.notifications) {
      try {
        await this.notifications.create(
          collection.ownerId,
          NotificationType.LIKE,
          {
            actorId: userId,
            payload: { collectionId },
            dedupeMs: 5 * 60 * 1000,
          },
        );
      } catch {}
    }

    return {
      likes: updated.likesCount,
      dislikes: updated.dislikesCount,
      liked: nowLiked,
    };
  }

  /**
   * Track views with IP-based deduplication
   */
  async recordView(
    collectionId: string,
    viewerId?: string,
    ipAddress?: string,
  ) {
    const ok = await this.canViewCollection(collectionId, viewerId);
    if (!ok) throw new NotFoundException('Collection not found');

    // Create IP hash for privacy
    const ipHash = ipAddress ? this.helperservice.hashIP(ipAddress) : null;

    // Check if view already exists (prevent spam)
    const existingView = await this.prisma.view.findFirst({
      where: {
        collectionId,
        OR: [
          { viewerId: viewerId || undefined },
          { ipHash: ipHash || undefined },
        ],
        createdAt: {
          gte: new Date(Date.now() - 24 * 60 * 60 * 1000), // Within last 24 hours
        },
      },
    });

    if (!existingView) {
      await this.prisma.view.create({
        data: {
          id: uuidv4(),
          collectionId,
          viewerId,
          ipHash,
        },
      });

      // Update denormalized count
      const viewCount = await this.prisma.view.count({
        where: { collectionId },
      });
      await this.prisma.collection.update({
        where: { id: collectionId },
        data: { viewsCount: viewCount },
      });
    }

    return { viewed: !existingView };
  }

  // ============================================
  // CONTRIBUTIONS
  // ============================================

  async requestContribution(
    requesterId: string,
    collectionId: string,
    message?: string,
  ) {
    const collection = await this.prisma.collection.findUnique({
      where: { id: collectionId },
      include: { owner: true },
    });

    if (!collection) {
      throw new NotFoundException('Collection not found');
    }

    if (collection.ownerId === requesterId) {
      throw new BadRequestException('Cannot contribute to your own collection');
    }

    // Check if requester is a brand (optional, but likely desired)
    const requester = await this.prisma.user.findUnique({
      where: { id: requesterId },
    });
    if (!requester || requester.type !== UserType.BRAND) {
      throw new ForbiddenException('Only brands can request to contribute');
    }

    const existing = await this.prisma.contributionRequest.findUnique({
      where: { requesterId_collectionId: { requesterId, collectionId } },
    });

    if (existing) {
      if (existing.status === PatchStatus.PENDING) {
        throw new BadRequestException('Contribution request already pending');
      }
      // Allow re-request if rejected?
      await this.prisma.contributionRequest.update({
        where: { id: existing.id },
        data: { status: PatchStatus.PENDING, message, updatedAt: new Date() },
      });
      return { status: 'PENDING', message: 'Contribution request resent' };
    }

    await this.prisma.contributionRequest.create({
      data: {
        id: uuidv4(),
        requesterId,
        collectionId,
        message,
        status: PatchStatus.PENDING,
      },
    });

    // Notify owner
    if (this.notifications) {
      try {
        await this.notifications.create(
          collection.ownerId,
          NotificationType.CONTRIBUTION_REQUEST,
          {
            actorId: requesterId,
            payload: {
              collectionId,
              collectionTitle: collection.title,
              message,
              targetUrl: `/collections/${collectionId}`,
            },
          },
        );
      } catch {}
    }

    return { status: 'PENDING', message: 'Contribution request sent' };
  }

  async respondToContribution(
    ownerId: string,
    requestId: string,
    status: 'ACCEPTED' | 'REJECTED',
  ) {
    const request = await this.prisma.contributionRequest.findUnique({
      where: { id: requestId },
      include: { collection: true },
    });

    if (!request) {
      throw new NotFoundException('Request not found');
    }

    if (request.collection.ownerId !== ownerId) {
      throw new ForbiddenException('Not authorized');
    }

    if (request.status !== PatchStatus.PENDING) {
      throw new BadRequestException('Request already processed');
    }

    await this.prisma.contributionRequest.update({
      where: { id: requestId },
      data: { status, updatedAt: new Date() },
    });

    // Notify requester
    if (this.notifications) {
      try {
        const type =
          status === PatchStatus.ACCEPTED
            ? NotificationType.CONTRIBUTION_ACCEPTED
            : NotificationType.CONTRIBUTION_REJECTED;
        await this.notifications.create(request.requesterId, type, {
          actorId: ownerId,
          payload: {
            collectionId: request.collectionId,
            collectionTitle: request.collection.title,
            targetUrl: `/collections/${request.collectionId}`,
          },
        });
      } catch {}
    }

    return { status, message: `Contribution request ${status.toLowerCase()}` };
  }

  async getContributionRequests(collectionId: string, ownerId: string) {
    await this.assertOwner(collectionId, ownerId);
    return this.prisma.contributionRequest.findMany({
      where: { collectionId, status: PatchStatus.PENDING },
      include: {
        requester: {
          select: {
            id: true,
            username: true,
            brandFullName: true,
            profileImage: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  // ============================================
  // HELPER METHODS
  // ============================================

  /**
   * PATCHING SYSTEM - Scalable approach
   * Patches are like "reposts" that boost visibility
   */
  async patchCollection(
    collectionId: string,
    patchingBrandId: string,
    weight = 1,
  ) {
    // Verify collection exists and is published
    const collection = await this.prisma.collection.findUnique({
      where: { id: collectionId, status: 'PUBLISHED' },
    });

    if (!collection) {
      throw new NotFoundException('Collection not found');
    }

    // Verify patching user is a brand
    const brand = await this.prisma.user.findUnique({
      where: { id: patchingBrandId },
    });

    if (!brand || brand.type !== UserType.BRAND) {
      throw new ForbiddenException('Only brands can patch collections');
    }

    // Check if brand already patched this collection
    const existingPatch = await this.prisma.patch.findFirst({
      where: {
        collectionId,
        patchingBrandId,
      },
    });

    if (existingPatch) {
      throw new BadRequestException('You have already patched this collection');
    }

    // Create patch record
    const patch = await this.prisma.patch.create({
      data: {
        id: uuidv4(),
        collectionId,
        patchingBrandId,
        weight,
      },
      include: {
        patchingBrand: {
          select: {
            id: true,
            username: true,
            brandFullName: true,
            profileImage: true,
          },
        },
      },
    });

    // Update denormalized patches count
    const totalPatches = await this.prisma.patch.count({
      where: { collectionId },
    });

    await this.prisma.collection.update({
      where: { id: collectionId },
      data: { patchesCount: totalPatches },
    });

    // Optional: Create notification for collection owner
    if (collection.ownerId !== patchingBrandId && this.notifications) {
      try {
        await this.notifications.create(
          collection.ownerId,
          NotificationType.PATCH,
          {
            actorId: patchingBrandId,
            payload: {
              collectionId,
              collectionTitle: collection.title,
              patchWeight: weight,
            },
          },
        );
      } catch {}
    }

    return patch;
  }

  /**
   * Get patches for a collection (who patched it)
   */
  async getCollectionPatches(
    collectionId: string,
    { cursor, limit = 20 }: { cursor?: string; limit?: number },
  ) {
    const patches = await this.prisma.patch.findMany({
      where: { collectionId },
      include: {
        patchingBrand: {
          select: {
            id: true,
            username: true,
            brandFullName: true,
            profileImage: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    });

    const hasNext = patches.length > limit;
    const data = hasNext ? patches.slice(0, -1) : patches;

    return {
      patches: data,
      hasNextPage: hasNext,
      endCursor: data.length ? data[data.length - 1].id : null,
    };
  }

  /**
   * Get collections patched by a specific brand
   */
  async getBrandPatches(
    brandId: string,
    { cursor, limit = 20 }: { cursor?: string; limit?: number },
  ) {
    const patches = await this.prisma.patch.findMany({
      where: { patchingBrandId: brandId },
      include: {
        collection: {
          include: {
            owner: {
              select: {
                id: true,
                username: true,
                brandFullName: true,
                profileImage: true,
              },
            },
            medias: {
              include: { file: true },
              orderBy: { orderIndex: 'asc' },
              take: 1,
            },
            _count: {
              select: {
                reactions: true,
                comments: true,
                patches: true,
                views: true,
              },
            },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    });

    const hasNext = patches.length > limit;
    const data = hasNext ? patches.slice(0, -1) : patches;

    return {
      patches: data,
      hasNextPage: hasNext,
      endCursor: data.length ? data[data.length - 1].id : null,
    };
  }

  /**
   * Remove patch (unpatch)
   */
  async removePatch(collectionId: string, patchingBrandId: string) {
    const patch = await this.prisma.patch.findFirst({
      where: {
        collectionId,
        patchingBrandId,
      },
    });

    if (!patch) {
      throw new NotFoundException('Patch not found');
    }

    await this.prisma.patch.delete({ where: { id: patch.id } });

    // Update denormalized count
    const totalPatches = await this.prisma.patch.count({
      where: { collectionId },
    });

    await this.prisma.collection.update({
      where: { id: collectionId },
      data: { patchesCount: totalPatches },
    });

    return { success: true };
  }

  /**
   * Get reactions for a collection
   */
  async getReactions(collectionId: string, limit = 20) {
    const ok = await this.canViewCollection(collectionId);
    if (!ok) throw new NotFoundException('Collection not found');

    const [reactions, totalLikes, totalDislikes] = await Promise.all([
      this.prisma.collectionReaction.findMany({
        where: { collectionId, type: ReactionType.LIKE },
        include: {
          user: {
            select: {
              id: true,
              username: true,
              firstName: true,
              lastName: true,
              profileImage: true,
            },
          },
        },
        orderBy: { createdAt: 'desc' },
        take: limit,
      }),
      this.prisma.collectionReaction.count({
        where: { collectionId, type: ReactionType.LIKE },
      }),
      this.prisma.collectionReaction.count({
        where: { collectionId, type: ReactionType.DISLIKE },
      }),
    ]);

    return {
      users: reactions.map((r) => r.user),
      totalLikes,
      totalDislikes,
    };
  }

  /**
   * Helper method to create notifications
   */
  private async createNotification(data: {
    recipientId: string;
    actorId: string;
    type: string;
    payload: any;
  }) {
    try {
      await this.prisma.notification.create({
        data: {
          id: uuidv4(),
          recipientId: data.recipientId,
          actorId: data.actorId,
          type: data.type as any,
          payload: data.payload,
          isRead: false,
        },
      });
    } catch (error) {
      console.warn('Failed to create notification:', error);
    }
  }
  // =============================
  // Media-level likes (per upload)
  // =============================
  async toggleMediaLike(mediaId: string, userId: string) {
    const can = await this.canViewMedia(mediaId, userId);
    if (!can) throw new NotFoundException('Media not found');

    const existing = await this.prisma.collectionMediaReaction.findUnique({
      where: {
        collectionMediaId_userId: { collectionMediaId: mediaId, userId },
      },
    });

    let delta = 0;
    let nowLiked = false;
    if (existing) {
      await this.prisma.collectionMediaReaction.delete({
        where: { id: existing.id },
      });
      delta = -1;
      nowLiked = false;
    } else {
      await this.prisma.collectionMediaReaction.create({
        data: {
          id: uuidv4(),
          collectionMediaId: mediaId,
          userId,
          type: ReactionType.LIKE,
        },
      });
      delta = +1;
      nowLiked = true;
    }

    const updated = await this.prisma.collectionMedia.update({
      where: { id: mediaId },
      data: { likesCount: { increment: delta } },
    });
    return { likes: updated.likesCount, liked: nowLiked };
  }

  async getMediaReactions(mediaId: string, limit = 20) {
    const can = await this.canViewMedia(mediaId);
    if (!can) throw new NotFoundException('Media not found');
    const rows = await this.prisma.collectionMediaReaction.findMany({
      where: { collectionMediaId: mediaId, type: ReactionType.LIKE },
      include: {
        user: {
          select: {
            id: true,
            username: true,
            firstName: true,
            lastName: true,
            profileImage: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    const total = await this.prisma.collectionMediaReaction.count({
      where: { collectionMediaId: mediaId, type: ReactionType.LIKE },
    });
    return { users: rows.map((r) => r.user), totalLikes: total };
  }

  async isMediaLikedByUser(mediaId: string, userId: string | undefined) {
    if (!userId) {
      return { liked: false };
    }
    const can = await this.canViewMedia(mediaId, userId);
    if (!can) throw new NotFoundException('Media not found');
    const r = await this.prisma.collectionMediaReaction.findUnique({
      where: {
        collectionMediaId_userId: { collectionMediaId: mediaId, userId },
      },
    });
    return { liked: !!r };
  }

  async isCollectionLikedByUser(
    collectionId: string,
    userId: string | undefined,
  ) {
    if (!userId) {
      return { liked: false };
    }
    const r = await this.prisma.collectionReaction.findUnique({
      where: { collectionId_userId: { collectionId, userId } },
    });
    return { liked: !!r };
  }

  async getLikesSummary(collectionId: string) {
    const collection = await this.prisma.collection.findUnique({
      where: { id: collectionId },
    });
    if (!collection) {
      throw new NotFoundException('Collection not found');
    }
    const mediaAgg = await this.prisma.collectionMedia.aggregate({
      where: { collectionId },
      _sum: { likesCount: true },
    });
    const collectionLikes = collection.likesCount;
    const mediaLikes = mediaAgg._sum.likesCount ?? 0;
    const totalLikes = collectionLikes + mediaLikes;
    return { collectionLikes, mediaLikes, totalLikes };
  }

  // ===================== PHASE 2: Auto-Publishing for Approved Categories =====================

  /**
   * Automatically publish all draft collections waiting for a specific category suggestion
   * Called when admin approves a category suggestion
   */
  async autoPublishPendingCollections(
    suggestionId: string,
    approvedCategoryId: string,
  ): Promise<{
    published: number;
    skipped: number;
    failed: number;
    errors: string[];
  }> {
    const results = {
      published: 0,
      skipped: 0,
      failed: 0,
      errors: [] as string[],
    };

    // Find all draft collections waiting for this suggestion
    const pendingCollections = await this.prisma.collection.findMany({
      where: {
        pendingCategorySuggestionId: suggestionId,
        status: 'DRAFT',
      },
      include: {
        owner: { select: { id: true, username: true, email: true } },
        medias: { include: { file: true } },
      },
    });

    console.log(
      `Found ${pendingCollections.length} collections waiting for suggestion ${suggestionId}`,
    );

    // Process each collection independently
    for (const collection of pendingCollections) {
      try {
        // Verify collection has uploaded media files
        if (!collection.medias || collection.medias.length === 0) {
          console.log(
            `Skipping collection ${collection.id} - no media uploaded`,
          );
          results.skipped++;

          // Notify user that upload is incomplete
          if (this.notifications) {
            await this.notifications.create(
              collection.ownerId,
              NotificationType.COLLECTION_UPLOAD,
              {
                payload: {
                  collectionId: collection.id,
                  message:
                    'Your category was approved, but your collection upload is incomplete. Please complete the upload to publish.',
                },
              },
            );
          }
          continue;
        }

        // Update collection in a transaction
        await this.prisma.$transaction(async (tx) => {
          await tx.collection.update({
            where: { id: collection.id },
            data: {
              categoryId: approvedCategoryId,
              pendingCategorySuggestionId: null,
              draftReason: null,
              status: 'PUBLISHED',
              updatedAt: new Date(),
            },
          });
        });

        results.published++;
        console.log(
          `Published collection ${collection.id} for user ${collection.owner.username}`,
        );

        // Send success notification
        if (this.notifications) {
          await this.notifications.create(
            collection.ownerId,
            NotificationType.COLLECTION_UPLOAD,
            {
              payload: {
                collectionId: collection.id,
                title: collection.title,
                message: `Great news! Your collection "${collection.title}" has been published automatically because the category you requested was approved.`,
              },
            },
          );
        }
      } catch (error) {
        results.failed++;
        const errorMsg = `Failed to publish collection ${collection.id}: ${error.message}`;
        results.errors.push(errorMsg);
        console.error(errorMsg, error);

        // Notify user of failure
        if (this.notifications) {
          await this.notifications.create(
            collection.ownerId,
            NotificationType.COLLECTION_UPLOAD,
            {
              payload: {
                collectionId: collection.id,
                message:
                  'There was an issue publishing your collection automatically. Please try publishing manually.',
              },
            },
          );
        }
      }
    }

    return results;
  }

  /**
   * Handle rejected category suggestions - update linked draft collections
   * Called when admin rejects a category suggestion
   */
  async handleRejectedCategory(
    suggestionId: string,
    rejectionReason: string,
  ): Promise<{ updated: number; notified: number }> {
    const results = { updated: 0, notified: 0 };

    // Find all collections waiting for this suggestion
    const affectedCollections = await this.prisma.collection.findMany({
      where: {
        pendingCategorySuggestionId: suggestionId,
        status: 'DRAFT',
      },
      include: {
        owner: { select: { id: true, username: true, email: true } },
      },
    });

    console.log(
      `Found ${affectedCollections.length} collections affected by rejected suggestion ${suggestionId}`,
    );

    for (const collection of affectedCollections) {
      try {
        // Update collection to reflect rejection
        await this.prisma.collection.update({
          where: { id: collection.id },
          data: {
            draftReason: 'CATEGORY_REJECTED',
            // Keep pendingCategorySuggestionId for reference
            updatedAt: new Date(),
          },
        });

        results.updated++;

        // Notify user
        if (this.notifications) {
          await this.notifications.create(
            collection.ownerId,
            NotificationType.COLLECTION_UPLOAD,
            {
              payload: {
                collectionId: collection.id,
                title: collection.title,
                pendingCategoryName: collection.pendingCategoryName,
                rejectionReason,
                message: `Your category suggestion "${collection.pendingCategoryName}" was not approved. Your collection "${collection.title}" is saved as a draft. You can select a different category to publish it.`,
              },
            },
          );
          results.notified++;
        }
      } catch (error) {
        console.error(`Failed to update collection ${collection.id}:`, error);
      }
    }

    return results;
  }

  // ===================== Invite Links (Feature-flagged) =====================
  private getInviteSecret() {
    const key = process.env.INVITE_TOKEN_SIGNING_KEY;
    if (!key) throw new Error('Missing INVITE_TOKEN_SIGNING_KEY');
    return key;
  }

  async createInviteLink(
    collectionId: string,
    ownerId: string,
    ttlSeconds = 86400,
  ) {
    await this.assertOwner(collectionId, ownerId);
    const payload = {
      cid: collectionId,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + Math.max(60, ttlSeconds),
    } as any;
    const secret = this.getInviteSecret();
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const sig = crypto
      .createHmac('sha256', secret)
      .update(body)
      .digest('base64url');
    const token = `${body}.${sig}`;
    return { token };
  }

  async acceptInvite(token: string, userId: string) {
    const secret = this.getInviteSecret();
    const parts = token.split('.');
    if (parts.length !== 2) throw new BadRequestException('Invalid token');
    const [body, sig] = parts;
    const expected = crypto
      .createHmac('sha256', secret)
      .update(body)
      .digest('base64url');
    if (sig !== expected) throw new BadRequestException('Invalid signature');
    let payload: any;
    try {
      payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    } catch {
      throw new BadRequestException('Invalid token');
    }
    if (!payload?.cid || !payload?.exp)
      throw new BadRequestException('Invalid token');
    if (Date.now() / 1000 > payload.exp)
      throw new BadRequestException('Token expired');
    const collectionId = String(payload.cid);
    await this.prisma.collectionAccess.upsert({
      where: { collectionId_viewerId: { collectionId, viewerId: userId } },
      update: { state: 'APPROVED', grantedBy: null, updatedAt: new Date() },
      create: {
        id: uuidv4(),
        collectionId,
        viewerId: userId,
        state: 'APPROVED',
        grantedBy: null,
      },
    } as any);
    return { success: true };
  }

  // ===================== Metrics =====================
  async getAccessMetrics(collectionId: string, from?: string, to?: string) {
    const fromDate = from
      ? new Date(from)
      : new Date(Date.now() - 30 * 86400000);
    const toDate = to ? new Date(to) : new Date();
    const [pending, approved, revoked] = await Promise.all([
      this.prisma.collectionAccess.count({
        where: {
          collectionId,
          state: 'PENDING',
          createdAt: { gte: fromDate, lte: toDate },
        } as any,
      }),
      this.prisma.collectionAccess.count({
        where: {
          collectionId,
          state: 'APPROVED',
          updatedAt: { gte: fromDate, lte: toDate },
        } as any,
      }),
      this.prisma.collectionAccess.count({
        where: {
          collectionId,
          state: 'REVOKED',
          updatedAt: { gte: fromDate, lte: toDate },
        } as any,
      }),
    ]);
    return {
      pending,
      approved,
      revoked,
      from: fromDate.toISOString(),
      to: toDate.toISOString(),
    };
  }

  async getPrivateViewsMetrics(
    collectionId: string,
    from?: string,
    to?: string,
  ) {
    const c = await this.prisma.collection.findUnique({
      where: { id: collectionId },
      select: { visibility: true },
    });
    if (!c) throw new NotFoundException('Collection not found');
    const fromDate = from
      ? new Date(from)
      : new Date(Date.now() - 30 * 86400000);
    const toDate = to ? new Date(to) : new Date();
    const views = await this.prisma.view.count({
      where: { collectionId, createdAt: { gte: fromDate, lte: toDate } },
    });
    return {
      visibility: c.visibility,
      views,
      from: fromDate.toISOString(),
      to: toDate.toISOString(),
    };
  }

  // ===================== Categories =====================
  async listCategories() {
    const rows = await this.prisma.collectionCategory.findMany({
      where: { isActive: true },
      orderBy: [{ order: 'asc' }, { createdAt: 'asc' }],
      select: {
        id: true,
        slug: true,
        name: true,
        description: true,
        order: true,
      },
    });
    return rows.map((r) => ({
      id: r.id,
      slug: r.slug,
      name: r.name,
      description: r.description,
      order: r.order,
    }));
  }

  // ===================== Update collection (owner only) =====================
  async updateCollection(
    collectionId: string,
    ownerId: string,
    body: UpdateCollectionDto,
  ) {
    await this.assertOwner(collectionId, ownerId);
    const existing = (await this.prisma.collection.findUnique({
      where: { id: collectionId },
      select: { status: true, visibility: true, deletedAt: true, draftVersion: true } as any,
    } as any)) as any;
    if (!existing) throw new NotFoundException('Collection not found');
    if (existing.deletedAt) throw new GoneException('Collection has been deleted');

    const now = new Date();
    if (existing.status === 'DRAFT') {
      const ttlMinutes = Math.max(
        5,
        parseInt(process.env.DRAFT_SESSION_TTL_MINUTES || '30', 10),
      );
      const nextExpiresAt = new Date(now.getTime() + ttlMinutes * 60 * 1000);
      if (typeof body.draftVersion === 'number' && body.draftVersion !== existing.draftVersion) {
        throw new ConflictException({
          code: 'DRAFT_VERSION_CONFLICT',
          message: 'Draft was modified by another session.',
          serverVersion: existing.draftVersion,
        } as any);
      }
      if (body.draftSessionToken) {
        const session = await this.prisma.collectionDraftSession.findFirst({
          where: {
            collectionId,
            ownerId,
            sessionToken: body.draftSessionToken,
            isActive: true,
            expiresAt: { gt: now },
          },
          select: { id: true },
        });
        if (!session) {
          throw new ConflictException({
            code: 'DRAFT_SESSION_CONFLICT',
            message: 'Draft session has expired or is not active.',
          } as any);
        }
        await this.prisma.collectionDraftSession.update({
          where: { id: session.id },
          data: { lastHeartbeatAt: now, expiresAt: nextExpiresAt },
        });
      }
    }

    const data: any = {};
    if (typeof body.title === 'string' || body.title === null)
      data.title = body.title || null;
    if (typeof body.description === 'string' || body.description === null)
      data.description = body.description || null;
    if (typeof body.visibility === 'string') data.visibility = body.visibility;
    if (typeof body.type === 'string') data.type = body.type;
    if (typeof body.isAvailableInStore === 'boolean')
      data.isAvailableInStore = body.isAvailableInStore;
    if (typeof body.minPrice === 'number' || body.minPrice === null)
      data.minPrice = body.minPrice as any;
    if (typeof body.maxPrice === 'number' || body.maxPrice === null)
      data.maxPrice = body.maxPrice as any;
    if (typeof body.saleMinPrice === 'number' || body.saleMinPrice === null)
      data.saleMinPrice = body.saleMinPrice as any;
    if (typeof body.saleMaxPrice === 'number' || body.saleMaxPrice === null)
      data.saleMaxPrice = body.saleMaxPrice as any;
    if (typeof body.saleStartAt === 'string' || body.saleStartAt === null)
      data.saleStartAt = body.saleStartAt ? new Date(body.saleStartAt) : null;
    if (typeof body.saleEndAt === 'string' || body.saleEndAt === null)
      data.saleEndAt = body.saleEndAt ? new Date(body.saleEndAt) : null;
    if (Array.isArray(body.tags)) data.tags = sanitizeTags(body.tags);
    if (typeof body.coverMediaId === 'string' || body.coverMediaId === null) {
      if (body.coverMediaId) {
        const belongs = await this.prisma.collectionMedia.findFirst({
          where: { id: body.coverMediaId, collectionId },
          select: { id: true },
        });
        if (!belongs) {
          throw new BadRequestException('coverMediaId does not belong to collection');
        }
      }
      data.coverMediaId = body.coverMediaId || null;
    }

    if (typeof body.categoryId === 'string' || body.categoryId === null) {
      if (body.categoryId) {
        const category = await this.prisma.collectionCategory.findUnique({
          where: { id: body.categoryId },
          select: { id: true, isActive: true },
        });
        if (!category) throw new NotFoundException('Category not found');
        if (!category.isActive)
          throw new BadRequestException('This category is not active');
      }
      data.categoryId = body.categoryId || null;
    }

    if (existing.status === 'DRAFT') {
      data.lastActivityAt = now;
      data.draftVersion = { increment: 1 };
    }

    const updated = await this.prisma.collection.update({
      where: { id: collectionId },
      data,
      include: {
        owner: {
          select: {
            id: true,
            username: true,
            brandFullName: true,
            profileImage: true,
          },
        },
        // coverMedia relation may not be generated yet until migration applied; comment out include safely
        // coverMedia: { include: { file: true } },
        _count: { select: { medias: true, views: true, comments: true } },
      },
    });
    if (
      typeof body.visibility === 'string' &&
      body.visibility !== existing.visibility &&
      body.visibility === CollectionVisibility.PRIVATE
    ) {
      await this.handleVisibilityChange(collectionId, 'PRIVATE', ownerId);
    }

    return updated;
  }

  // ===================== Cart Preview for Collections =====================
  /**
   * Get cart preview showing available and unavailable products in a collection
   * Used before "Add Entire Collection to Cart"
   */
  async getCollectionCartPreview(collectionId: string, requesterId?: string) {
    const canView = await this.canViewCollection(collectionId, requesterId);
    if (!canView) throw new NotFoundException('Collection not found');

    const collection = await this.prisma.collection.findUnique({
      where: { id: collectionId },
      select: { id: true, title: true },
    });

    const links = await this.prisma.collectionProduct.findMany({
      where: { collectionId },
      include: {
        product: {
          include: {
            brand: { select: { currency: true } },
            variants: {
              select: { size: true, color: true, stock: true, price: true },
            },
          },
        },
      },
      orderBy: { orderIndex: 'asc' },
    });

    const now = new Date();
    const available: any[] = [];
    const unavailable: any[] = [];

    for (const link of links) {
      const p = link.product;
      if (!p) continue;

      const effectivePrice = p.salePrice && 
        (!p.saleStartAt || p.saleStartAt <= now) &&
        (!p.saleEndAt || p.saleEndAt >= now)
        ? Number(p.salePrice)
        : Number(p.price);

      const variants = (p.variants || []).map((v) => ({
        size: v.size,
        color: v.color,
        stock: v.stock,
        inStock: v.stock > 0,
        price: v.price ? Number(v.price) : undefined,
      }));

      const hasAnyInStock = variants.length > 0 
        ? variants.some(v => v.inStock)
        : p.totalStock > 0;
      const canBackorder = !!p.allowBackorders;

      const item = {
        productId: p.id,
        name: p.name,
        thumbnail: p.thumbnail,
        price: Number(p.price),
        salePrice: p.salePrice ? Number(p.salePrice) : undefined,
        effectivePrice,
        currency: p.currency || p.brand?.currency || 'NGN',
        variants,
        defaultSize: p.sizes?.[0],
        defaultColor: p.colors?.[0],
        allowBackorders: canBackorder,
      };

      // Determine availability
      if (p.deletedAt) {
        unavailable.push({ ...item, reason: 'deleted' });
      } else if (p.archivedAt) {
        unavailable.push({ ...item, reason: 'archived' });
      } else if (!p.isActive) {
        unavailable.push({ ...item, reason: 'inactive' });
      } else if (p.publishAt && p.publishAt > now) {
        unavailable.push({ 
          ...item, 
          reason: 'scheduled', 
          availableAt: p.publishAt.toISOString(),
        });
      } else if (!hasAnyInStock && !canBackorder) {
        unavailable.push({ ...item, reason: 'out_of_stock' });
      } else {
        available.push({
          ...item,
          availabilityNote: !hasAnyInStock && canBackorder ? 'backorder' : undefined,
        });
      }
    }

    const availableSubtotal = available.reduce(
      (sum, item) => sum + item.effectivePrice,
      0,
    );

    return {
      collectionId,
      collectionTitle: collection?.title || 'Untitled',
      available,
      unavailable,
      summary: {
        availableCount: available.length,
        unavailableCount: unavailable.length,
        totalCount: links.length,
        availableSubtotal,
        currency: available[0]?.currency || 'NGN',
      },
    };
  }

  // ===================== Price Change Preview =====================
  /**
   * Preview how a product price change will affect collection price ranges
   */
  async getProductPriceChangePreview(
    productId: string,
    newPrice: number,
    ownerId: string,
  ) {
    const product = await this.prisma.product.findFirst({
      where: { id: productId },
      include: { brand: true },
    });

    if (!product) throw new NotFoundException('Product not found');
    if (product.brand.ownerId !== ownerId) {
      throw new ForbiddenException('You can only preview your own products');
    }

    const memberships = await this.prisma.collectionProduct.findMany({
      where: { productId },
      include: {
        collection: {
          select: { id: true, title: true, minPrice: true, maxPrice: true },
        },
      },
    });

    const affectedCollections: any[] = [];

    for (const m of memberships) {
      const links = await this.prisma.collectionProduct.findMany({
        where: { collectionId: m.collectionId },
        include: { product: { select: { id: true, price: true } } },
      });

      const prices = links.map((l) =>
        l.productId === productId ? newPrice : Number(l.product?.price || 0),
      ).filter((p) => p > 0);

      const newMinPrice = prices.length > 0 ? Math.min(...prices) : null;
      const newMaxPrice = prices.length > 0 ? Math.max(...prices) : null;

      affectedCollections.push({
        collectionId: m.collection.id,
        collectionTitle: m.collection.title || 'Untitled',
        currentMinPrice: m.collection.minPrice,
        currentMaxPrice: m.collection.maxPrice,
        newMinPrice,
        newMaxPrice,
        rangeChanged:
          m.collection.minPrice !== newMinPrice ||
          m.collection.maxPrice !== newMaxPrice,
      });
    }

    const currentPrice = Number(product.price);
    const priceChange = newPrice - currentPrice;
    const percentageChange = currentPrice > 0 
      ? ((priceChange / currentPrice) * 100) 
      : 0;

    return {
      productId,
      productName: product.name,
      currentPrice,
      newPrice,
      priceChange,
      percentageChange: Math.round(percentageChange * 100) / 100,
      affectedCollections,
    };
  }

  // ===================== Bulk Upload (Scaffold) =====================
  /**
   * Initialize bulk upload job
   * TODO: Implement with Bull/Redis queue for production
   */
  async initiateBulkUpload(
    collectionId: string,
    ownerId: string,
    mode: 'csv' | 'images' | 'mixed' = 'csv',
    file?: Express.Multer.File,
  ) {
    await this.assertOwner(collectionId, ownerId);

    if (!file || !file.buffer) {
      throw new BadRequestException('CSV file is required for bulk upload');
    }
    const maxFileSize = 25 * 1024 * 1024;
    if (file.size > maxFileSize) {
      throw new BadRequestException('Bulk upload file exceeds 25MB limit');
    }

    const jobId = uuidv4();
    const rows = this.parseBulkCsv(file);
    if (!rows.length) {
      throw new BadRequestException('CSV file contains no rows');
    }

    await this.prisma.collectionBulkUploadJob.create({
      data: {
        id: jobId,
        collectionId,
        ownerId,
        mode,
        status: 'PROCESSING',
        totalRows: rows.length,
      },
    });

    const rowRecords = rows.map((row, index) => {
      const rowId = row.rowId || row.id || `${jobId}:${index + 1}`;
      return {
        id: uuidv4(),
        jobId,
        rowIndex: index + 1,
        rowId,
        status: 'PENDING' as const,
        payload: row as any,
      };
    });

    await this.prisma.collectionBulkUploadRow.createMany({
      data: rowRecords as any,
    });

    let processedRows = 0;
    let successRows = 0;
    let failedRows = 0;
    const errors: Array<{ row: number; field: string; message: string }> = [];

    for (const rowRecord of rowRecords) {
      processedRows += 1;
      try {
        await this.prisma.collectionBulkUploadRow.update({
          where: { id: rowRecord.id },
          data: { status: 'PROCESSING' },
        });

        const payload = rowRecord.payload as Record<string, string>;
        const dto = this.buildBulkProductDto(payload, collectionId);
        const created = await this.storeService.createProduct(ownerId, dto);

        await this.prisma.collectionBulkUploadRow.update({
          where: { id: rowRecord.id },
          data: { status: 'SUCCESS', createdProductId: created.id },
        });
        successRows += 1;
      } catch (error: any) {
        failedRows += 1;
        const message = error?.response?.message || error?.message || 'Row failed';
        errors.push({ row: rowRecord.rowIndex, field: 'row', message });
        await this.prisma.collectionBulkUploadRow.update({
          where: { id: rowRecord.id },
          data: { status: 'FAILED', errorMessage: message },
        });
      }
    }

    const status = failedRows > 0 && successRows > 0
      ? 'PARTIAL'
      : failedRows > 0
        ? 'FAILED'
        : 'COMPLETED';

    await this.prisma.collectionBulkUploadJob.update({
      where: { id: jobId },
      data: {
        status,
        processedRows,
        successRows,
        failedRows,
        errorSummary: errors as any,
        completedAt: new Date(),
      },
    });

    return {
      jobId,
      status: status.toLowerCase(),
      totalRows: rows.length,
      processedRows,
      successRows,
      failedRows,
      errors,
    };
  }

  /**
   * Get bulk upload job status
   */
  async getBulkUploadStatus(jobId: string, ownerId: string) {
    const job = await this.prisma.collectionBulkUploadJob.findFirst({
      where: { id: jobId, ownerId },
      include: { rows: true },
    });
    if (!job) throw new NotFoundException('Bulk upload job not found');

    const failedRows = job.rows.filter((row) => row.status === 'FAILED');
    const errors = failedRows.map((row) => ({
      row: row.rowIndex,
      field: 'row',
      message: row.errorMessage || 'Row failed',
    }));

    return {
      jobId,
      status: job.status.toLowerCase(),
      totalRows: job.totalRows,
      processedRows: job.processedRows,
      successRows: job.successRows,
      failedRows: job.failedRows,
      errors,
      createdAt: job.createdAt.toISOString(),
      completedAt: job.completedAt ? job.completedAt.toISOString() : undefined,
    };
  }

  /**
   * Retry failed bulk upload rows
   */
  async retryBulkUploadRows(
    jobId: string,
    ownerId: string,
    rowIndices: number[],
  ) {
    const job = await this.prisma.collectionBulkUploadJob.findFirst({
      where: { id: jobId, ownerId },
      include: { rows: true },
    });
    if (!job) throw new NotFoundException('Bulk upload job not found');

    const targetRows = Array.isArray(rowIndices) && rowIndices.length > 0
      ? job.rows.filter((row) => rowIndices.includes(row.rowIndex))
      : job.rows.filter((row) => row.status === 'FAILED');

    let retriedCount = 0;
    let successRows = job.successRows;
    let failedRows = job.failedRows;
    const errors: Array<{ row: number; field: string; message: string }> = [];

    for (const row of targetRows) {
      if (row.status === 'SUCCESS') continue;
      retriedCount += 1;
      try {
        await this.prisma.collectionBulkUploadRow.update({
          where: { id: row.id },
          data: { status: 'PROCESSING', errorMessage: null },
        });

        const payload = (row.payload || {}) as Record<string, string>;
        const dto = this.buildBulkProductDto(payload, job.collectionId);
        const created = await this.storeService.createProduct(ownerId, dto);

        await this.prisma.collectionBulkUploadRow.update({
          where: { id: row.id },
          data: { status: 'SUCCESS', createdProductId: created.id },
        });
        successRows += 1;
      } catch (error: any) {
        const message = error?.response?.message || error?.message || 'Row failed';
        errors.push({ row: row.rowIndex, field: 'row', message });
        await this.prisma.collectionBulkUploadRow.update({
          where: { id: row.id },
          data: { status: 'FAILED', errorMessage: message },
        });
      }
    }

    const refreshedRows = await this.prisma.collectionBulkUploadRow.findMany({
      where: { jobId },
      select: { status: true },
    });
    successRows = refreshedRows.filter((row) => row.status === 'SUCCESS').length;
    failedRows = refreshedRows.filter((row) => row.status === 'FAILED').length;
    const processedRows = refreshedRows.length;
    const status = failedRows > 0 && successRows > 0
      ? 'PARTIAL'
      : failedRows > 0
        ? 'FAILED'
        : 'COMPLETED';

    await this.prisma.collectionBulkUploadJob.update({
      where: { id: jobId },
      data: {
        status,
        processedRows,
        successRows,
        failedRows,
        errorSummary: errors as any,
        completedAt: new Date(),
      },
    });

    return {
      jobId,
      retriedCount,
      status: status.toLowerCase(),
    };
  }

  // ===================== Custom Fit Inquiry (Scaffold) =====================
  /**
   * Submit a custom fit inquiry for a collection/product
   * TODO: Implement with messaging system
   */
  async submitCustomFitInquiry(
    collectionId: string,
    requesterId: string,
    dto: {
      productId?: string;
      message: string;
      measurements?: string;
      preferredSize?: string;
    },
  ) {
    const collection = await this.prisma.collection.findUnique({
      where: { id: collectionId },
      select: { ownerId: true, title: true },
    });

    if (!collection) throw new NotFoundException('Collection not found');

    const inquiryId = uuidv4();

    // In production, this would:
    // 1. Create a message/inquiry record
    // 2. Notify the brand owner
    // 3. Track in analytics

    return {
      success: true,
      inquiryId,
      message: 'Your inquiry has been sent to the brand. They will respond soon.',
      estimatedResponseTime: '24-48 hours',
    };
  }

  // ===================== Draft Conflict Detection =====================
  /**
   * Check for draft editing conflicts (multi-device)
   */
  async checkDraftConflict(
    draftId: string,
    ownerId: string,
    deviceName?: string,
    forceNew?: boolean,
    existingToken?: string,
  ) {
    await this.assertOwner(draftId, ownerId);

    const draft = (await this.prisma.collection.findUnique({
      where: { id: draftId },
      select: {
        id: true,
        status: true,
        deletedAt: true,
        updatedAt: true,
      } as any,
    } as any)) as any;

    if (!draft) throw new NotFoundException('Draft not found');
    if (draft.deletedAt) throw new GoneException('Collection has been deleted');
    if (draft.status !== 'DRAFT') {
      throw new BadRequestException('Collection is not a draft');
    }

    const now = new Date();
    const ttlMinutes = Math.max(
      5,
      parseInt(process.env.DRAFT_SESSION_TTL_MINUTES || '30', 10),
    );
    const expiresAt = new Date(now.getTime() + ttlMinutes * 60 * 1000);

    const normalizeDeviceType = (name?: string) => {
      const value = (name || '').toLowerCase();
      if (value.includes('ipad') || value.includes('tablet')) return 'tablet';
      if (value.includes('iphone') || value.includes('android') || value.includes('mobile')) return 'mobile';
      return 'desktop';
    };

    if (existingToken) {
      const existingSession = await this.prisma.collectionDraftSession.findFirst({
        where: {
          collectionId: draftId,
          ownerId,
          sessionToken: existingToken,
          isActive: true,
          expiresAt: { gt: now },
        },
      });
      if (existingSession) {
        await this.prisma.collectionDraftSession.update({
          where: { id: existingSession.id },
          data: { lastHeartbeatAt: now, expiresAt },
        });
        return {
          collectionId: draftId,
          sessionToken: existingToken,
          hasConflict: false,
        };
      }
    }

    const activeSession = await this.prisma.collectionDraftSession.findFirst({
      where: {
        collectionId: draftId,
        ownerId,
        isActive: true,
        expiresAt: { gt: now },
      },
      orderBy: { lastHeartbeatAt: 'desc' },
    });

    if (activeSession && !forceNew) {
      return {
        collectionId: draftId,
        sessionToken: activeSession.sessionToken,
        hasConflict: true,
        conflictDetails: {
          existingSessionToken: activeSession.sessionToken,
          deviceName: activeSession.deviceName ?? 'Unknown device',
          deviceType: (activeSession.deviceType as any) ?? 'desktop',
          startedAt: activeSession.startedAt.toISOString(),
          userId: ownerId,
        },
      };
    }

    if (activeSession && forceNew) {
      await this.prisma.collectionDraftSession.updateMany({
        where: { collectionId: draftId, ownerId, isActive: true },
        data: { isActive: false },
      });
    }

    const sessionToken = uuidv4();
    await this.prisma.collectionDraftSession.create({
      data: {
        id: uuidv4(),
        collectionId: draftId,
        ownerId,
        sessionToken,
        deviceName: deviceName ?? null,
        deviceType: normalizeDeviceType(deviceName),
        lastHeartbeatAt: now,
        expiresAt,
      },
    });

    return {
      collectionId: draftId,
      sessionToken,
      hasConflict: false,
    };
  }

  // ===================== Cover Media Reassignment =====================
  /**
   * Delete collection media and reassign cover if needed
   */
  async deleteCollectionMedia(
    collectionId: string,
    mediaId: string,
    ownerId: string,
  ) {
    await this.assertOwner(collectionId, ownerId);

    const collection = await this.prisma.collection.findUnique({
      where: { id: collectionId },
      select: { coverMediaId: true },
    });

    const media = await this.prisma.collectionMedia.findFirst({
      where: { id: mediaId, collectionId },
      include: { file: true },
    });

    if (!media) throw new NotFoundException('Media not found in collection');

    const key = media.file?.s3Key;
    if (key) {
      await this.uploadService.deleteS3ObjectByKey(key);
    }

    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      if (media.file?.id) {
        await tx.fileUpload.delete({ where: { id: media.file.id } as any });
      }

      await tx.collectionMedia.delete({ where: { id: mediaId } as any });

      if (collection?.coverMediaId === mediaId) {
        const firstRemaining = await tx.collectionMedia.findFirst({
          where: { collectionId },
          orderBy: { orderIndex: 'asc' },
          select: { id: true },
        });

        await tx.collection.update({
          where: { id: collectionId },
          data: { coverMediaId: firstRemaining?.id ?? null },
        });
      }

      const remainingMedia = await tx.collectionMedia.count({
        where: { collectionId },
      });
      const remainingProducts = await tx.collectionProduct.count({
        where: { collectionId },
      });
      if (remainingMedia === 0 && remainingProducts === 0) {
        const deleteExpiresAt = new Date(
          now.getTime() + this.collectionDeleteWindowMs,
        );
        await tx.collection.update({
          where: { id: collectionId },
          data: { deletedAt: now, deleteExpiresAt },
        });
      }
    });

    await (this.prisma.collection as any).updateMany({
      where: { id: collectionId, status: 'DRAFT', deletedAt: null },
      data: { lastActivityAt: new Date(), draftVersion: { increment: 1 } },
    });

    return { success: true, coverReassigned: collection?.coverMediaId === mediaId };
  }

  // ===================== Visibility Change Cart Cleanup =====================
  /**
   * When collection becomes private, clean up carts of non-approved users
   */
  async handleVisibilityChange(
    collectionId: string,
    newVisibility: 'PUBLIC' | 'PRIVATE',
    ownerId: string,
  ) {
    if (newVisibility !== 'PRIVATE') return { cleaned: 0 };

    // Get product IDs in this collection
    const productLinks = await this.prisma.collectionProduct.findMany({
      where: { collectionId },
      select: { productId: true },
    });
    const productIds = productLinks.map((l) => l.productId);

    if (productIds.length === 0) return { cleaned: 0 };

    // Get approved viewer IDs
    const approvedAccess = await this.prisma.collectionAccess.findMany({
      where: { collectionId, state: 'APPROVED' },
      select: { viewerId: true },
    });
    const approvedViewerIds = approvedAccess.map((a) => a.viewerId);

    // Remove cart items from non-approved users
    const deleted = await this.prisma.cartItem.deleteMany({
      where: {
        productId: { in: productIds },
        userId: { notIn: [...approvedViewerIds, ownerId] },
      },
    });

    // Also clean wishlists
    await this.prisma.wishlistItem.deleteMany({
      where: {
        productId: { in: productIds },
        userId: { notIn: [...approvedViewerIds, ownerId] },
      },
    });

    return { cleaned: deleted.count };
  }
}

export { CreateCollectionDto, FinalizeCollectionDto };
