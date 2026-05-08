import {
  Injectable,
  BadRequestException,
  NotFoundException,
  ForbiddenException,
  ConflictException,
  GoneException,
  Optional,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { PrismaService } from 'src/prisma/prisma.service';
import { SystemConfigService } from 'src/admin/system-config/system-config.service';
import { v4 as uuidv4, validate as isUuid } from 'uuid';
import {
  ReactionType,
  UserType,
  Prisma,
  ContentTarget,
  CustomOrderSourceType,
  NotificationType,
  CollectionVisibility,
  CollectionType,
  MessageConversationType,
  MessageContextType,
  MessageKind,
  MessageParticipantRole,
  PatchStatus,
  PatchMode,
  OrderStatus,
} from '@prisma/client';
import { NotificationsService } from 'src/notifications/notifications.service';
import { AnalyticsService } from 'src/analytics/analytics.service';
import {
  CreateCollectionDto,
  DESIGN_MAX_MEDIA_COUNT,
  DESIGN_REQUIRED_MEDIA_COUNT,
  FileSpecDto,
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
import { SystemTagsService } from 'src/tags/system-tags.service';
import { TagIndexService } from 'src/tags/tag-index.service';
import { NotificationsQueueService } from 'src/queue/notifications.queue.service';
import {
  BULK_UPLOAD_QUEUE,
  BULK_UPLOAD_PROCESS_JOB,
  BULK_UPLOAD_RETRY_JOB,
} from 'src/queue/queue.constants';
import { TAG_ENTITY_TYPE } from 'src/tags/tag-entity-type';
import { CategoriesService } from 'src/categories/categories.service';
import { BrandAccessService } from 'src/brands/brand-access.service';
import {
  BRAND_PERMISSIONS,
  BrandPermissionCode,
} from 'src/brands/permissions/brand-permissions';
import {
  canonicalUserProfileSelect,
  resolveProfileImage,
  resolveRequiredProfileField,
} from 'src/common/user-profile-source.helper';
import {
  canonicalBrandProfileSelect,
  resolveRequiredBrandField,
} from 'src/common/brand-profile-source.helper';

type CollectionScope = 'design' | 'store' | 'all';
type CollectionDomainValue = 'DESIGN' | 'STORE';
type FeedMediaAssetDto = {
  id: string;
  fileId: string | null;
  type: 'IMAGE' | 'VIDEO';
  displayUrl: string;
  thumbnailUrl: string | null;
  previewUrl: string | null;
  blurHash: string | null;
  dominantColor: string | null;
  width: number | null;
  height: number | null;
  aspectRatio: number;
  status: 'READY';
  orderIndex: number;
};

@Injectable()
export class CollectionsService {
  private readonly logger = new Logger(CollectionsService.name);
  private readonly defaultCollectionScope: CollectionScope = 'all';

  constructor(
    private readonly prisma: PrismaService,
    private readonly helperservice: HelperService,
    private readonly uploadService: UploadService,
    private readonly storeService: StoreService,
    private readonly analytics?: AnalyticsService,
    private readonly notifications?: NotificationsService,
    private readonly systemTags?: SystemTagsService,
    private readonly tagIndex?: TagIndexService,
    @Optional()
    private readonly categoriesService?: CategoriesService,
    private readonly notificationsQueue?: NotificationsQueueService,
    @InjectQueue(BULK_UPLOAD_QUEUE) private readonly bulkUploadQueue?: Queue,
    private readonly systemConfigService?: SystemConfigService,
    @Optional()
    private readonly brandAccessService?: BrandAccessService,
  ) { }

  private mapCollectionOwner(owner: any) {
    if (!owner) return null;
    const profileImage = resolveProfileImage(owner);
    return {
      id: owner.id,
      username: owner.username,
      firstName: resolveRequiredProfileField(owner, 'firstName'),
      lastName: resolveRequiredProfileField(owner, 'lastName'),
      brandFullName: resolveRequiredBrandField(owner, 'brandFullName') || null,
      profileImage: owner.brand?.logo ?? profileImage.url,
      profileImageId: profileImage.fileId,
      profileImageFile: profileImage.file,
      brand: owner.brand ?? null,
    };
  }

  private selectCollectionOwnerDisplay() {
    return {
      id: true,
      username: true,
      type: true,
      userProfile: { select: canonicalUserProfileSelect },
      brand: { select: canonicalBrandProfileSelect },
    } as const;
  }

  private readonly maxProductsPerCollection = Math.max(
    1,
    parseInt(process.env.MAX_PRODUCTS_PER_COLLECTION || '5', 10),
  );
  private readonly collectionDeleteWindowMs = 30 * 24 * 60 * 60 * 1000;

  async assertDesignCreationAllowed(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        type: true,
        isEmailVerified: true,
      },
    });

    if (!user) {
      throw new ForbiddenException('Only brands can create designs');
    }

    if (!user.isEmailVerified) {
      throw new ForbiddenException('Verify your email before creating designs.');
    }

    if (this.brandAccessService) {
      const context = await this.brandAccessService.getPrimaryBrandContext(userId);
      if (context.activeBrandId) {
        await this.brandAccessService.assertCanManageCatalog(
          userId,
          context.activeBrandId,
          BRAND_PERMISSIONS.CATALOG_WRITE,
        );
        return user;
      }
    }

    if (user.type !== UserType.BRAND) {
      throw new ForbiddenException('Only brands can create designs');
    }

    return user;
  }

  private async resolveCatalogOwnerContext(actorUserId: string): Promise<{
    actorUserId: string;
    ownerId: string;
    brandId: string;
  }> {
    const user = await this.prisma.user.findUnique({
      where: { id: actorUserId },
      select: { id: true, type: true, isEmailVerified: true },
    });

    if (!user) {
      throw new ForbiddenException('Only brands can create collections');
    }

    if (!user.isEmailVerified) {
      throw new ForbiddenException('Verify your email before creating designs.');
    }

    if (this.brandAccessService) {
      const context = await this.brandAccessService.getPrimaryBrandContext(actorUserId);
      if (context.activeBrandId) {
        await this.brandAccessService.assertCanManageCatalog(
          actorUserId,
          context.activeBrandId,
          BRAND_PERMISSIONS.CATALOG_WRITE,
        );
        const brand = await this.prisma.brand.findUnique({
          where: { id: context.activeBrandId },
          select: { id: true, ownerId: true },
        });
        if (brand) {
          return {
            actorUserId,
            ownerId: brand.ownerId,
            brandId: brand.id,
          };
        }
      }
    }

    if (user.type !== UserType.BRAND) {
      throw new ForbiddenException('Only brands can create collections');
    }

    const brand = await this.prisma.brand.findUnique({
      where: { ownerId: actorUserId },
      select: { id: true, ownerId: true },
    });
    if (!brand) {
      throw new ForbiddenException('Only brands can create collections');
    }

    return { actorUserId, ownerId: brand.ownerId, brandId: brand.id };
  }

  private async assertActorCanManageLegacyOwnerCatalog(
    actorUserId: string,
    legacyOwnerId: string,
    permission: BrandPermissionCode = BRAND_PERMISSIONS.CATALOG_WRITE,
  ) {
    if (legacyOwnerId === actorUserId) {
      return;
    }

    if (!this.brandAccessService) {
      throw new ForbiddenException('Not owner');
    }

    const brandId =
      await this.brandAccessService.resolveBrandIdFromBrandOrOwnerId(
        legacyOwnerId,
      );
    await this.brandAccessService.assertCanManageCatalog(
      actorUserId,
      brandId,
      permission,
    );
  }

  private normalizeMeasurementKeys(raw?: string[] | null): string[] {
    if (!Array.isArray(raw)) return [];
    return Array.from(
      new Set(
        raw
          .map((key) => (typeof key === 'string' ? key.trim() : ''))
          .filter((key) => key.length > 0)
          .map((key) => key.toUpperCase()),
      ),
    );
  }

  private normalizeFilterValueIds(raw?: string[] | null): string[] {
    if (!Array.isArray(raw)) return [];
    const unique = Array.from(
      new Set(
        raw
          .map((value) => (typeof value === 'string' ? value.trim() : ''))
          .filter((value) => value.length > 0 && isUuid(value)),
      ),
    );
    return unique;
  }

  private async assertDesignCustomOrderPublishReady(
    sourceId: string,
    ownerId: string,
    customOrderEnabled: boolean,
    tx?: Prisma.TransactionClient,
  ) {
    if (!customOrderEnabled) return;

    const prismaClient = tx ?? this.prisma;
    const activeConfiguration = await prismaClient.customOrderConfiguration.findFirst({
      where: {
        sourceType: CustomOrderSourceType.DESIGN,
        sourceId,
        isActive: true,
        brand: { ownerId },
      },
      select: { id: true },
    });

    if (!activeConfiguration) {
      throw new BadRequestException(
        'Custom orders are enabled, but no active custom-order configuration exists for this design.',
      );
    }
  }

  private async collectStoreCollectionFilterValueIds(collectionId: string): Promise<string[]> {
    const links = await this.prisma.storeCollectionProduct.findMany({
      where: { collectionId },
      select: { productId: true },
    });
    const productIds = Array.from(
      new Set(links.map((link) => link.productId).filter(Boolean)),
    );
    if (productIds.length === 0) return [];

    const rows = await this.prisma.entityFilter.findMany({
      where: {
        entityType: 'PRODUCT',
        entityId: { in: productIds },
      },
      select: { filterValueId: true },
    });

    return Array.from(new Set(rows.map((row) => row.filterValueId)));
  }

  private async syncStoreCollectionFiltersFromProducts(collectionId: string) {
    if (!this.categoriesService) return;
    const productFilterValueIds = await this.collectStoreCollectionFilterValueIds(
      collectionId,
    );
    await this.categoriesService.setEntityFilters(
      'STORE_COLLECTION',
      collectionId,
      this.normalizeFilterValueIds(productFilterValueIds),
    );
  }

  private normalizeCollectionScope(scope?: string): CollectionScope {
    if (scope === 'store') return 'store';
    if (scope === 'all') return 'all';
    return 'design';
  }

  private async enforceDraftSessionLock(
    collectionId: string,
    ownerId: string,
    draftSessionToken?: string,
  ) {
    const now = new Date();
    const activeSession = await this.prisma.collectionDraftSession.findFirst({
      where: {
        collectionId,
        ownerId,
        isActive: true,
        expiresAt: { gt: now },
      },
      orderBy: { lastHeartbeatAt: 'desc' },
      select: {
        id: true,
        sessionToken: true,
        deviceName: true,
        deviceType: true,
        startedAt: true,
      },
    });

    if (!activeSession) return;

    if (!draftSessionToken) {
      throw new ConflictException({
        code: 'DRAFT_SESSION_REQUIRED',
        message: 'An active draft editing session exists. Provide draftSessionToken to continue.',
        conflictDetails: {
          deviceName: activeSession.deviceName ?? 'Unknown device',
          deviceType: (activeSession.deviceType as any) ?? 'desktop',
          startedAt: activeSession.startedAt.toISOString(),
          userId: ownerId,
        },
      } as any);
    }

    if (activeSession.sessionToken !== draftSessionToken) {
      throw new ConflictException({
        code: 'DRAFT_SESSION_CONFLICT',
        message: 'Another active draft session currently holds the lock.',
        conflictDetails: {
          deviceName: activeSession.deviceName ?? 'Unknown device',
          deviceType: (activeSession.deviceType as any) ?? 'desktop',
          startedAt: activeSession.startedAt.toISOString(),
          userId: ownerId,
        },
      } as any);
    }

    const ttlMinutes = Math.max(
      5,
      parseInt(process.env.DRAFT_SESSION_TTL_MINUTES || '30', 10),
    );
    const nextExpiresAt = new Date(now.getTime() + ttlMinutes * 60 * 1000);
    await this.prisma.collectionDraftSession.update({
      where: { id: activeSession.id },
      data: { lastHeartbeatAt: now, expiresAt: nextExpiresAt },
    });
  }

  private scopeToDomain(scope: CollectionScope): CollectionDomainValue | null {
    if (scope === 'design') return 'DESIGN';
    if (scope === 'store') return 'STORE';
    return null;
  }

  private resolveCoverMedia<T extends { id: string }>(
    medias: T[] | null | undefined,
    coverMediaId?: string | null,
  ): T | null {
    if (!Array.isArray(medias) || medias.length === 0) return null;
    if (coverMediaId) {
      const cover = medias.find((media) => media.id === coverMediaId);
      if (cover) return cover;
    }
    return medias[0] ?? null;
  }

  private toCoverOnlyMediaList<T extends { id: string }>(
    medias: T[] | null | undefined,
    coverMediaId?: string | null,
  ): T[] {
    const cover = this.resolveCoverMedia(medias, coverMediaId);
    return cover ? [cover] : [];
  }

  private async assertActiveCategory(categoryId: string) {
    const category = await this.prisma.collectionCategory.findUnique({
      where: { id: categoryId },
      select: { id: true, isActive: true },
    });
    if (!category) throw new NotFoundException('Category not found');
    if (!category.isActive) {
      throw new BadRequestException('This category is not active');
    }
    return category;
  }

  private isReadyFeedFile(file: any): boolean {
    if (!file) return false;
    if (file.originalDeletedAt) return false;
    if (file.processingStatus && file.processingStatus !== 'READY') return false;
    return typeof file.s3Url === 'string' && file.s3Url.trim().length > 0;
  }

  private isVideoFileType(fileType?: string | null): boolean {
    return String(fileType ?? '').toUpperCase().includes('VIDEO');
  }

  private getPreferredVariantUrl(
    file: any,
    kinds: string[],
  ): string | null {
    const variants = Array.isArray(file?.variants) ? file.variants : [];
    for (const kind of kinds) {
      const match =
        variants.find(
          (variant: any) =>
            String(variant?.variantKind ?? '').toUpperCase() === kind &&
            String(variant?.format ?? '').toUpperCase() === 'WEBP',
        ) ??
        variants.find(
          (variant: any) =>
            String(variant?.variantKind ?? '').toUpperCase() === kind,
        );
      if (typeof match?.s3Url === 'string' && match.s3Url.trim().length > 0) {
        return this.uploadService.getPublicDisplayUrl(match) ?? match.s3Url.trim();
      }
    }
    return null;
  }

  private buildFeedMediaAsset(
    args: {
      id: string | null | undefined;
      file: any;
      mediaType?: string | null;
      orderIndex?: number | null;
    },
  ): FeedMediaAssetDto | null {
    const file = args.file;
    if (!this.isReadyFeedFile(file)) {
      this.logger.debug(
        `[feed-contract] media excluded not-ready-or-deleted fileId=${file?.id ?? 'unknown'} status=${file?.processingStatus ?? 'unknown'}`,
      );
      return null;
    }

    const displayUrl =
      this.getPreferredVariantUrl(file, ['DETAIL', 'CARD', 'ZOOM']) ??
      this.uploadService.getPublicDisplayUrl(file) ??
      String(file.s3Url).trim();
    if (!displayUrl) {
      this.logger.debug(`[feed-contract] media excluded missing-display-url fileId=${file?.id ?? 'unknown'}`);
      return null;
    }

    const width =
      typeof file.width === 'number' && Number.isFinite(file.width)
        ? file.width
        : null;
    const height =
      typeof file.height === 'number' && Number.isFinite(file.height)
        ? file.height
        : null;
    const aspectRatio =
      width && height && height > 0 ? width / height : 1;

    return {
      id: String(args.id ?? file.id),
      fileId: typeof file.id === 'string' && file.id.trim() ? file.id : null,
      type: this.isVideoFileType(args.mediaType ?? file.fileType)
        ? 'VIDEO'
        : 'IMAGE',
      displayUrl,
      thumbnailUrl: this.getPreferredVariantUrl(file, ['THUMB']),
      previewUrl: this.getPreferredVariantUrl(file, ['CARD', 'DETAIL']),
      blurHash: null,
      dominantColor: null,
      width,
      height,
      aspectRatio,
      status: 'READY',
      orderIndex:
        typeof args.orderIndex === 'number' && Number.isFinite(args.orderIndex)
          ? args.orderIndex
          : 0,
    };
  }

  private buildFeedBrandAvatar(owner: any): FeedMediaAssetDto | null {
    const brandLogoFile = owner?.brand?.logoImageFile ?? null;
    const profileImageFile = owner?.userProfile?.profileImageFile ?? null;
    const file = brandLogoFile ?? profileImageFile;
    return this.buildFeedMediaAsset({
      id: file?.id,
      file,
      mediaType: file?.fileType,
      orderIndex: 0,
    });
  }

  private async assertCategoryTypeMatchesCategory(
    categoryId: string | null | undefined,
    categoryTypeId: string | null | undefined,
  ) {
    if (!categoryTypeId) return null;
    if (!isUuid(categoryTypeId)) {
      throw new BadRequestException('Sub-category format is invalid');
    }
    if (!categoryId) {
      throw new BadRequestException('Sub-category requires a selected category');
    }

    const categoryType = await this.prisma.collectionCategoryType.findUnique({
      where: { id: categoryTypeId },
      select: { id: true, categoryId: true, isActive: true },
    });
    if (!categoryType) throw new NotFoundException('Sub-category not found');
    if (!categoryType.isActive) {
      throw new BadRequestException('This sub-category is not active');
    }
    if (categoryType.categoryId !== categoryId) {
      throw new BadRequestException(
        'Sub-category does not belong to selected category',
      );
    }
    return categoryType;
  }

  private async lockCollectionForUpdate(
    tx: Prisma.TransactionClient,
    collectionId: string,
    domain: CollectionDomainValue = 'DESIGN',
  ) {
    await tx.$executeRaw(
      domain === 'STORE'
        ? Prisma.sql`SELECT "_id" FROM "StoreCollection" WHERE "_id" = ${collectionId} FOR UPDATE`
        : Prisma.sql`SELECT "_id" FROM "Collection" WHERE "_id" = ${collectionId} FOR UPDATE`,
    );
  }

  private async touchDraftActivity(
    tx: Prisma.TransactionClient,
    collectionId: string,
    domain: CollectionDomainValue = 'DESIGN',
  ) {
    const now = new Date();
    const ttlMinutes = Math.max(
      5,
      parseInt(process.env.DRAFT_SESSION_TTL_MINUTES || '30', 10),
    );
    const nextExpiresAt = new Date(now.getTime() + ttlMinutes * 60 * 1000);
    if (domain === 'STORE') {
      await (tx as any).storeCollection.updateMany({
        where: { id: collectionId, status: 'DRAFT', deletedAt: null },
        data: { lastActivityAt: now, draftVersion: { increment: 1 } },
      });
      return;
    }
    await (tx as any).collection.updateMany({
      where: { id: collectionId, status: 'DRAFT', deletedAt: null },
      data: { lastActivityAt: now, draftVersion: { increment: 1 } },
    });
  }

  private async cleanupSupersededDraftCollections(
    tx: Prisma.TransactionClient,
    ownerId: string,
    publishedCollectionId: string,
    title: string | null | undefined,
    deletedAt: Date,
    domain?: 'DESIGN' | 'STORE' | null,
    isAvailableInStore?: boolean | null,
  ) {
    const normalizedTitle = String(title ?? '').trim();
    if (!normalizedTitle) return;

    await (tx as any).collection.updateMany({
      where: {
        ownerId,
        id: { not: publishedCollectionId },
        status: 'DRAFT',
        deletedAt: null,
        title: normalizedTitle,
        ...(domain ? { domain } : {}),
        ...(typeof isAvailableInStore === 'boolean' ? { isAvailableInStore } : {}),
      },
      data: {
        deletedAt,
        draftReason: 'Superseded by published collection',
        lastActivityAt: deletedAt,
      },
    });
  }

  private async enforcePrimaryMembership(
    tx: Prisma.TransactionClient,
    productId: string,
  ) {
    const links = await tx.storeCollectionProduct.findMany({
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
    await tx.storeCollectionProduct.updateMany({
      where: { productId },
      data: { isPrimary: false },
    });
    await tx.storeCollectionProduct.updateMany({
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
    const productLinks = await this.prisma.storeCollectionProduct.findMany({
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

  private isCollectionTagIndexed(collection: {
    status?: string | null;
    visibility?: CollectionVisibility | null;
    deletedAt?: Date | null;
  }): boolean {
    if (collection.deletedAt) return false;
    if (collection.status !== 'PUBLISHED') return false;
    return (collection.visibility ?? CollectionVisibility.PUBLIC) === CollectionVisibility.PUBLIC;
  }

  private getIndexedCollectionTags(
    collection: {
      status?: string | null;
      visibility?: CollectionVisibility | null;
      deletedAt?: Date | null;
      tags?: Array<string | null | undefined> | null;
    },
    fallbackTags?: Array<string | null | undefined>,
  ): string[] {
    if (!this.isCollectionTagIndexed(collection)) return [];
    const source = fallbackTags ?? (Array.isArray(collection.tags) ? collection.tags : []);
    return sanitizeTags(source.map((tag) => String(tag ?? '')), 30);
  }

  private areTagsEqual(a: string[], b: string[]): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  }

  private isProductTagIndexed(product: {
    isActive?: boolean | null;
    publishAt?: Date | null;
    archivedAt?: Date | null;
    deletedAt?: Date | null;
  }): boolean {
    if (!product.isActive) return false;
    if (product.deletedAt || product.archivedAt) return false;
    const now = new Date();
    if (product.publishAt && product.publishAt > now) return false;
    return true;
  }

  private getIndexedProductTags(
    product: {
      isActive?: boolean | null;
      publishAt?: Date | null;
      archivedAt?: Date | null;
      deletedAt?: Date | null;
      tags?: Array<string | null | undefined> | null;
    },
    fallbackTags?: Array<string | null | undefined>,
  ): string[] {
    if (!this.isProductTagIndexed(product)) return [];
    const source = fallbackTags ?? (Array.isArray(product.tags) ? product.tags : []);
    return sanitizeTags(source.map((tag) => String(tag ?? '')), 30);
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
      const access = await this.prisma.collectionAccess.findFirst({
        where: {
          viewerId: requesterId,
          state: 'APPROVED',
          collection: {
            ownerId: c.ownerId,
            visibility: CollectionVisibility.PRIVATE,
            status: 'PUBLISHED',
            deletedAt: null,
          },
        },
        select: { id: true },
      } as any);
      return Boolean(access);
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
    const links = await this.prisma.storeCollectionProduct.findMany({
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

    await this.prisma.storeCollection.update({
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
  private deriveBrandAccessState(
    rows: Array<{ state?: string | null }>,
  ): 'APPROVED' | 'PENDING' | 'REVOKED' | 'NONE' {
    if (rows.some((row) => row.state === 'APPROVED')) return 'APPROVED';
    if (rows.some((row) => row.state === 'PENDING')) return 'PENDING';
    if (rows.some((row) => row.state === 'REVOKED')) return 'REVOKED';
    return 'NONE';
  }

  private getLatestRejectedBrandAccess(
    rows: Array<{
      state?: string | null;
      notes?: string | null;
      updatedAt: Date;
      createdAt?: Date;
    }>,
  ) {
    return rows
      .filter((row) => row.state === 'REVOKED' && row.notes === 'REJECTED')
      .sort((left, right) => {
        const leftTime = left.updatedAt?.getTime?.() ?? left.createdAt?.getTime?.() ?? 0;
        const rightTime =
          right.updatedAt?.getTime?.() ?? right.createdAt?.getTime?.() ?? 0;
        return rightTime - leftTime;
      })[0] ?? null;
  }

  private async applyBrandAccessState(
    collectionId: string,
    ownerId: string,
    viewerIds: string[],
    state: 'PENDING' | 'APPROVED' | 'REVOKED',
    options?: {
      notes?: string | null;
      grantedBy?: string | null;
      createdAt?: Date;
      updatedAt?: Date;
    },
  ) {
    const uniqueViewerIds = Array.from(
      new Set(viewerIds.map((viewerId) => String(viewerId ?? '').trim()).filter(Boolean)),
    );

    if (uniqueViewerIds.length === 0) {
      return;
    }

    const now = options?.updatedAt ?? new Date();
    const existingRows = await this.prisma.collectionAccess.findMany({
      where: {
        viewerId: { in: uniqueViewerIds },
        collection: {
          ownerId,
          visibility: CollectionVisibility.PRIVATE,
          status: 'PUBLISHED',
          deletedAt: null,
        },
      },
      select: { id: true, viewerId: true },
    } as any);

    const existingIdsByViewer = new Map<string, string[]>();
    for (const row of existingRows) {
      const ids = existingIdsByViewer.get(row.viewerId) ?? [];
      ids.push(row.id);
      existingIdsByViewer.set(row.viewerId, ids);
    }

    const operations: Prisma.PrismaPromise<any>[] = [];

    for (const viewerId of uniqueViewerIds) {
      const existingIds = existingIdsByViewer.get(viewerId) ?? [];
      if (existingIds.length > 0) {
        operations.push(
          this.prisma.collectionAccess.updateMany({
            where: { id: { in: existingIds } },
            data: {
              state,
              notes: options?.notes ?? null,
              grantedBy: options?.grantedBy ?? null,
              updatedAt: now,
            },
          } as any),
        );
        continue;
      }

      operations.push(
        this.prisma.collectionAccess.create({
          data: {
            id: uuidv4(),
            collectionId,
            viewerId,
            state,
            notes: options?.notes ?? null,
            grantedBy: options?.grantedBy ?? null,
            createdAt: options?.createdAt ?? now,
            updatedAt: now,
          },
        } as any),
      );
    }

    if (operations.length > 0) {
      await this.prisma.$transaction(operations);
    }
  }

  async requestAccess(collectionId: string, requesterId: string) {
    const c = (await this.prisma.collection.findUnique({
      where: { id: collectionId },
      select: {
        id: true,
        ownerId: true,
        status: true,
        visibility: true,
        deletedAt: true,
        owner: {
          select: this.selectCollectionOwnerDisplay(),
        },
      } as any,
    } as any)) as any;
    if (!c || c.deletedAt || c.status !== 'PUBLISHED')
      throw new NotFoundException('Collection not found');
    if (c.visibility === CollectionVisibility.PUBLIC)
      return { state: 'APPROVED' };
    if (c.ownerId === requesterId) return { state: 'APPROVED' };
    const now = new Date();
    const existingRows = await this.prisma.collectionAccess.findMany({
      where: {
        viewerId: requesterId,
        collection: {
          ownerId: c.ownerId,
          visibility: CollectionVisibility.PRIVATE,
          status: 'PUBLISHED',
          deletedAt: null,
        },
      },
      select: {
        id: true,
        collectionId: true,
        state: true,
        notes: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: [{ updatedAt: 'desc' }, { createdAt: 'desc' }],
    } as any);
    const brandState = this.deriveBrandAccessState(existingRows);
    // Cooldown after rejection
    // Default cooldown: 72h (configurable via env PRIVATE_ACCESS_COOLDOWN_MS)
    const cooldownMs = Math.max(
      0,
      parseInt(process.env.PRIVATE_ACCESS_COOLDOWN_MS || '') ||
      72 * 60 * 60 * 1000,
    );
    const rejectedAccess = this.getLatestRejectedBrandAccess(existingRows);
    if (brandState === 'APPROVED') {
      return { state: 'APPROVED' };
    }
    if (brandState === 'PENDING') {
      console.log('metrics.access_request', { collectionId, requesterId });
      return { state: 'PENDING' };
    }
    if (rejectedAccess) {
      const elapsed = now.getTime() - new Date(rejectedAccess.updatedAt).getTime();
      if (elapsed < cooldownMs) {
        const nextAllowedAt = new Date(
          rejectedAccess.updatedAt.getTime() + cooldownMs,
        ).toISOString();
        return { state: 'PENDING', cooldownActive: true, nextAllowedAt } as any;
      }
    }
    await this.applyBrandAccessState(
      collectionId,
      c.ownerId,
      [requesterId],
      'PENDING',
      {
        notes: null,
        grantedBy: null,
        createdAt: now,
        updatedAt: now,
      },
    );
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
            brandName:
              resolveRequiredBrandField(c.owner, 'brandFullName') ||
              c.owner?.username ||
              null,
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

  private async assertOwner(
    collectionId: string,
    ownerId: string,
    expectedDomain?: CollectionDomainValue,
    permission: BrandPermissionCode = BRAND_PERMISSIONS.CATALOG_WRITE,
  ) {
    if (expectedDomain === 'STORE') {
      const s = await this.prisma.storeCollection.findUnique({
        where: { id: collectionId },
        select: { ownerId: true, deletedAt: true },
      });
      if (!s) throw new NotFoundException('Collection not found');
      if (s.deletedAt) throw new GoneException('Collection has been deleted');
      await this.assertActorCanManageLegacyOwnerCatalog(
        ownerId,
        s.ownerId,
        permission,
      );
      return {
        ownerId: s.ownerId,
        deletedAt: s.deletedAt,
        domain: 'STORE' as CollectionDomainValue,
      };
    }

    const c = (await this.prisma.collection.findUnique({
      where: { id: collectionId },
      select: { ownerId: true, deletedAt: true, domain: true } as any,
    } as any)) as any;
    if (!c && !expectedDomain) {
      const s = await this.prisma.storeCollection.findUnique({
        where: { id: collectionId },
        select: { ownerId: true, deletedAt: true },
      });
      if (!s) throw new NotFoundException('Collection not found');
      if (s.deletedAt) throw new GoneException('Collection has been deleted');
      await this.assertActorCanManageLegacyOwnerCatalog(
        ownerId,
        s.ownerId,
        permission,
      );
      return {
        ownerId: s.ownerId,
        deletedAt: s.deletedAt,
        domain: 'STORE' as CollectionDomainValue,
      };
    }
    if (!c) throw new NotFoundException('Collection not found');
    if (c.deletedAt) throw new GoneException('Collection has been deleted');
    await this.assertActorCanManageLegacyOwnerCatalog(
      ownerId,
      c.ownerId,
      permission,
    );
    if (expectedDomain && c.domain !== expectedDomain) {
      throw new BadRequestException('Design action attempted on a store collection.');
    }
    return c as { ownerId: string; deletedAt: Date | null; domain?: CollectionDomainValue };
  }

  async listAccessRequests(
    collectionId: string,
    ownerId: string,
    limit = 20,
    cursor?: string,
  ) {
    await this.assertOwner(collectionId, ownerId);
    const rows = await this.prisma.collectionAccess.findMany({
      where: { collectionId, state: 'PENDING' },
      include: {
        viewer: { select: this.selectCollectionOwnerDisplay() },
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
        viewer: { select: this.selectCollectionOwnerDisplay() },
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
      collection: {
        ownerId: brandId,
        visibility: CollectionVisibility.PRIVATE,
        status: 'PUBLISHED',
        deletedAt: null,
      },
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
    const privateCollectionCount = await this.prisma.collection.count({
      where: {
        ownerId: brandId,
        visibility: CollectionVisibility.PRIVATE,
        status: 'PUBLISHED',
        deletedAt: null,
      } as any,
    });

    const rows = await this.prisma.collectionAccess.findMany({
      where,
      include: {
        viewer: {
          select: this.selectCollectionOwnerDisplay(),
        },
        collection: {
          select: {
            id: true,
            title: true,
            coverMediaId: true,
            medias: {
              select: {
                id: true,
                orderIndex: true,
                file: { select: { id: true, s3Url: true } },
              },
              orderBy: { orderIndex: 'asc' },
            },
            _count: { select: { medias: true } },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    } as any);

    const groupedByViewer = new Map<string, any[]>();
    for (const row of rows as any[]) {
      const group = groupedByViewer.get(row.viewerId) ?? [];
      group.push(row);
      groupedByViewer.set(row.viewerId, group);
    }

    const aggregated = Array.from(groupedByViewer.values())
      .map((groupRows) => {
        const orderedRows = [...groupRows].sort(
          (left, right) =>
            right.updatedAt.getTime() - left.updatedAt.getTime() ||
            right.createdAt.getTime() - left.createdAt.getTime(),
        );
        const latest = orderedRows[0];
        const earliest = [...groupRows].sort(
          (left, right) => left.createdAt.getTime() - right.createdAt.getTime(),
        )[0];
        const brandState = this.deriveBrandAccessState(groupRows);
        if (brandState !== state) {
          return null;
        }
        const cover = this.resolveCoverMedia(
          latest?.collection?.medias,
          latest?.collection?.coverMediaId ?? null,
        );
        return {
          id: latest.id,
          collectionId: latest.collectionId,
          viewerId: latest.viewerId,
          state: brandState,
          createdAt: earliest.createdAt,
          updatedAt: latest.updatedAt,
          privateCollectionCount,
          viewer: this.mapCollectionOwner(latest.viewer),
          collection: latest?.collection
            ? {
                ...latest.collection,
                owner: this.mapCollectionOwner(latest.collection.owner),
                title:
                  privateCollectionCount > 1
                    ? `${privateCollectionCount} private designs`
                    : latest.collection.title,
                coverMediaId: latest.collection.coverMediaId ?? cover?.id ?? null,
                medias: cover ? [cover] : [],
              }
            : latest?.collection,
        };
      })
      .filter(Boolean)
      .sort(
        (left: any, right: any) =>
          right.updatedAt.getTime() - left.updatedAt.getTime(),
      );

    const totalCount = aggregated.length;
    const startIndex = pageNum
      ? (pageNum - 1) * take
      : cursor
        ? Math.max(
            0,
            aggregated.findIndex((item: any) => item.id === cursor) + 1,
          )
        : 0;
    const items = aggregated.slice(startIndex, startIndex + take);
    const hasNextPage = startIndex + take < totalCount;
    const totalPages = Math.max(1, Math.ceil(totalCount / take));
    return {
      items,
      hasNextPage,
      endCursor: pageNum
        ? null
        : items.length
          ? (items[items.length - 1] as any).id
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
        deletedAt: null,
      },
      select: {
        id: true,
        title: true,
        coverMediaId: true,
        medias: {
          select: {
            id: true,
            orderIndex: true,
            file: { select: { id: true, s3Url: true } },
          },
          orderBy: [{ orderIndex: 'asc' }],
        },
        _count: { select: { medias: true } },
      },
    });

    let brandState: 'APPROVED' | 'PENDING' | 'REVOKED' | 'NONE' = 'NONE';
    if (viewerId) {
      const acc = await this.prisma.collectionAccess.findMany({
        where: {
          viewerId,
          collection: {
            ownerId: brandId,
            visibility: CollectionVisibility.PRIVATE,
            status: 'PUBLISHED',
            deletedAt: null,
          },
        },
        select: {
          state: true,
          notes: true,
          updatedAt: true,
        },
      } as any);
      brandState = this.deriveBrandAccessState(acc as any);
    }

    return {
      items: collections.map((c) => {
        const cover = this.resolveCoverMedia(c.medias, c.coverMediaId ?? null);
        return {
          collectionId: c.id,
          title: c.title,
          coverMediaId: c.coverMediaId ?? cover?.id ?? null,
          coverFileId: cover?.file?.id ?? null,
          coverUrl: cover?.file?.s3Url ?? null,
          itemCount: c._count.medias,
          state: brandState as
            | 'APPROVED'
            | 'PENDING'
            | 'REVOKED'
            | 'NONE',
        };
      }),
    };
  }

  async approveAccessBulk(
    collectionId: string,
    ownerId: string,
    userIds: string[],
  ) {
    await this.assertOwner(collectionId, ownerId);
    const now = new Date();
    const owner = await this.prisma.user.findUnique({
      where: { id: ownerId },
      select: this.selectCollectionOwnerDisplay(),
    });
    const viewers = await this.prisma.user.findMany({
      where: { id: { in: userIds } },
      select: this.selectCollectionOwnerDisplay(),
    });
    const viewerNameById = new Map(
      viewers.map((viewer) => {
        const display = this.mapCollectionOwner(viewer);
        return [
          viewer.id,
          display?.username || display?.firstName || null,
        ] as const;
      }),
    );
    const ownerDisplay = this.mapCollectionOwner(owner);
    await this.applyBrandAccessState(
      collectionId,
      ownerId,
      userIds,
      'APPROVED',
      {
        notes: null,
        grantedBy: ownerId,
        createdAt: now,
        updatedAt: now,
      },
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
              brandName: ownerDisplay?.brandFullName || ownerDisplay?.username || null,
              username: viewerNameById.get(uid) ?? null,
              targetUrl: `/profile/${ownerId}?tab=Content&visibility=Private`,
            },
          },
        );
      } catch { }
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
    const now = new Date();
    const owner = await this.prisma.user.findUnique({
      where: { id: ownerId },
      select: this.selectCollectionOwnerDisplay(),
    });
    const viewer = await this.prisma.user.findUnique({
      where: { id: userId },
      select: this.selectCollectionOwnerDisplay(),
    });
    const ownerDisplay = this.mapCollectionOwner(owner);
    const viewerDisplay = this.mapCollectionOwner(viewer);
    await this.applyBrandAccessState(
      collectionId,
      ownerId,
      [userId],
      state,
      {
        notes: state === 'REVOKED' ? 'REVOKED' : null,
        grantedBy: ownerId,
        createdAt: now,
        updatedAt: now,
      },
    );
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
            brandName: ownerDisplay?.brandFullName || ownerDisplay?.username || null,
            username: viewerDisplay?.username || viewerDisplay?.firstName || null,
            targetUrl:
              state === 'APPROVED'
                ? `/profile/${ownerId}?tab=Content&visibility=Private`
                : `/profile/${ownerId}?tab=private`,
          },
        },
      );
    } catch { }
    console.log('metrics.access_update_state', { collectionId, userId, state });
    return { success: true };
  }

  async rejectAccess(collectionId: string, ownerId: string, userId: string) {
    await this.assertOwner(collectionId, ownerId);
    const owner = await this.prisma.user.findUnique({
      where: { id: ownerId },
      select: this.selectCollectionOwnerDisplay(),
    });
    const viewer = await this.prisma.user.findUnique({
      where: { id: userId },
      select: this.selectCollectionOwnerDisplay(),
    });
    const ownerDisplay = this.mapCollectionOwner(owner);
    const viewerDisplay = this.mapCollectionOwner(viewer);
    const existing = await this.prisma.collectionAccess.findMany({
      where: {
        viewerId: userId,
        collection: {
          ownerId,
          visibility: CollectionVisibility.PRIVATE,
          status: 'PUBLISHED',
          deletedAt: null,
        },
      },
      select: { state: true },
    } as any);
    if (this.deriveBrandAccessState(existing as any) !== 'PENDING') {
      // Idempotent: no-op if already decided
      return { success: true };
    }
    await this.applyBrandAccessState(
      collectionId,
      ownerId,
      [userId],
      'REVOKED',
      {
        notes: 'REJECTED',
        grantedBy: ownerId,
        updatedAt: new Date(),
      },
    );
    try {
      await this.notifications?.create(
        userId,
        NotificationType.PRIVATE_ACCESS_REJECTED,
        {
          actorId: ownerId,
          payload: {
            collectionId,
            brandName: ownerDisplay?.brandFullName || ownerDisplay?.username || null,
            username: viewerDisplay?.username || viewerDisplay?.firstName || null,
            targetUrl: `/profile/${ownerId}?tab=private`,
          },
        },
      );
    } catch { }
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

    const rows = await this.prisma.collectionAccess.findMany({
      where: {
        viewerId: userId,
        collection: {
          visibility: CollectionVisibility.PRIVATE,
          status: 'PUBLISHED',
          deletedAt: null,
        },
      },
      include: {
        collection: {
          select: {
            id: true,
            title: true,
            coverMediaId: true,
            ownerId: true,
            owner: {
              select: this.selectCollectionOwnerDisplay(),
            },
            medias: {
              select: {
                id: true,
                orderIndex: true,
                file: { select: { s3Url: true } },
              },
              orderBy: { orderIndex: 'asc' },
            },
            _count: { select: { medias: true } },
          },
        },
      },
      orderBy: [{ updatedAt: 'desc' }, { createdAt: 'desc' }],
    });

    const groupedByBrand = new Map<string, typeof rows>();
    for (const row of rows) {
      const brandKey = row.collection?.ownerId;
      if (!brandKey) continue;
      const group = groupedByBrand.get(brandKey) ?? [];
      group.push(row);
      groupedByBrand.set(brandKey, group);
    }

    const ownerIds = Array.from(groupedByBrand.keys());
    const privateCollectionCounts = new Map<string, number>(
      await Promise.all(
        ownerIds.map(async (ownerId): Promise<[string, number]> => [
          ownerId,
          await this.prisma.collection.count({
            where: {
              ownerId,
              visibility: CollectionVisibility.PRIVATE,
              status: 'PUBLISHED',
              deletedAt: null,
            } as any,
          }),
        ]),
      ),
    );

    const aggregated = Array.from(groupedByBrand.entries())
      .map(([ownerId, groupRows]) => {
        const brandState = this.deriveBrandAccessState(groupRows as any);
        if (status && brandState !== stateMap[status]) {
          return null;
        }
        const orderedRows = [...groupRows].sort(
          (left, right) =>
            right.updatedAt.getTime() - left.updatedAt.getTime() ||
            right.createdAt.getTime() - left.createdAt.getTime(),
        );
        const latest = orderedRows[0];
        const earliest = [...groupRows].sort(
          (left, right) => left.createdAt.getTime() - right.createdAt.getTime(),
        )[0];
        const privateCollectionCount = privateCollectionCounts.get(ownerId) ?? 0;
        const cover = this.resolveCoverMedia(
          latest.collection?.medias,
          latest.collection?.coverMediaId ?? null,
        );
        const ownerDisplay = this.mapCollectionOwner(latest.collection?.owner);
        return {
          id: latest.id,
          collectionId: latest.collectionId,
          title:
            privateCollectionCount > 1
              ? `${privateCollectionCount} private designs`
              : latest.collection?.title || 'Untitled',
          brand: {
            id: ownerDisplay?.id,
            name:
              ownerDisplay?.brandFullName ||
              ownerDisplay?.username,
            profileImage: ownerDisplay?.profileImage,
            profileImageId: ownerDisplay?.profileImageId,
            profileImageFile: ownerDisplay?.profileImageFile,
          },
          coverUrl: cover?.file?.s3Url || null,
          itemCount: privateCollectionCount,
          state: brandState,
          requestedAt: earliest.createdAt,
          updatedAt: latest.updatedAt,
        };
      })
      .filter(Boolean)
      .sort(
        (left: any, right: any) =>
          right.updatedAt.getTime() - left.updatedAt.getTime(),
      );

    const totalCount = aggregated.length;
    const skip = (page - 1) * take;
    const items = aggregated.slice(skip, skip + take);
    const totalPages = Math.max(1, Math.ceil(totalCount / take));

    return {
      items,
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
    const rows = await this.prisma.collectionAccess.findMany({
      where: {
        viewerId: userId,
        collection: {
          visibility: CollectionVisibility.PRIVATE,
          status: 'PUBLISHED',
          deletedAt: null,
        },
      },
      include: {
        collection: {
          select: {
            id: true,
            title: true,
            coverMediaId: true,
            ownerId: true,
            owner: {
              select: this.selectCollectionOwnerDisplay(),
            },
            medias: {
              select: {
                id: true,
                orderIndex: true,
                file: { select: { s3Url: true } },
              },
              orderBy: { orderIndex: 'asc' },
            },
            _count: { select: { medias: true } },
          },
        },
      },
      orderBy: [{ updatedAt: 'desc' }, { createdAt: 'desc' }],
    });

    const groupedByBrand = new Map<string, typeof rows>();
    for (const row of rows) {
      const brandKey = row.collection?.ownerId;
      if (!brandKey) continue;
      const group = groupedByBrand.get(brandKey) ?? [];
      group.push(row);
      groupedByBrand.set(brandKey, group);
    }

    const ownerIds = Array.from(groupedByBrand.keys());
    const privateCollectionCounts = new Map<string, number>(
      await Promise.all(
        ownerIds.map(async (ownerId): Promise<[string, number]> => [
          ownerId,
          await this.prisma.collection.count({
            where: {
              ownerId,
              visibility: CollectionVisibility.PRIVATE,
              status: 'PUBLISHED',
              deletedAt: null,
            } as any,
          }),
        ]),
      ),
    );

    const aggregated = Array.from(groupedByBrand.entries())
      .map(([ownerId, groupRows]) => {
        const brandState = this.deriveBrandAccessState(groupRows as any);
        if (brandState !== 'APPROVED') {
          return null;
        }
        const orderedRows = [...groupRows].sort(
          (left, right) =>
            right.updatedAt.getTime() - left.updatedAt.getTime() ||
            right.createdAt.getTime() - left.createdAt.getTime(),
        );
        const latest = orderedRows[0];
        const privateCollectionCount = privateCollectionCounts.get(ownerId) ?? 0;
        const cover = this.resolveCoverMedia(
          latest.collection?.medias,
          latest.collection?.coverMediaId ?? null,
        );
        const ownerDisplay = this.mapCollectionOwner(latest.collection?.owner);
        return {
          id: latest.id,
          collectionId: latest.collectionId,
          title:
            privateCollectionCount > 1
              ? `${privateCollectionCount} private designs`
              : latest.collection?.title || 'Untitled',
          brand: {
            id: ownerDisplay?.id,
            name:
              ownerDisplay?.brandFullName ||
              ownerDisplay?.username,
            profileImage: ownerDisplay?.profileImage,
            profileImageId: ownerDisplay?.profileImageId,
            profileImageFile: ownerDisplay?.profileImageFile,
          },
          coverUrl: cover?.file?.s3Url || null,
          itemCount: privateCollectionCount,
          grantedAt: latest.updatedAt,
        };
      })
      .filter(Boolean)
      .sort(
        (left: any, right: any) =>
          right.grantedAt.getTime() - left.grantedAt.getTime(),
      );

    const totalCount = aggregated.length;
    const skip = (page - 1) * take;
    const items = aggregated.slice(skip, skip + take);
    const totalPages = Math.max(1, Math.ceil(totalCount / take));

    return {
      items,
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

    await this.prisma.collectionAccess.deleteMany({
      where: {
        viewerId: userId,
        state: 'PENDING',
        collection: {
          ownerId: access.collection.ownerId,
          visibility: CollectionVisibility.PRIVATE,
          status: 'PUBLISHED',
          deletedAt: null,
        },
      },
    } as any);

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

    await this.prisma.collectionAccess.deleteMany({
      where: {
        viewerId: userId,
        state: 'APPROVED',
        collection: {
          ownerId: access.collection.ownerId,
          visibility: CollectionVisibility.PRIVATE,
          status: 'PUBLISHED',
          deletedAt: null,
        },
      },
    } as any);

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
    const catalogContext = await this.resolveCatalogOwnerContext(userId);
    const ownerId = catalogContext.ownerId;

    const hasFiles = Array.isArray(dto.files) && dto.files.length > 0;
    if (hasFiles && dto.files!.length > DESIGN_MAX_MEDIA_COUNT) {
      throw new BadRequestException(`Maximum ${DESIGN_MAX_MEDIA_COUNT} files per design`);
    }

    // Store-collection session initialization (no media required)
    if (!hasFiles && dto.mode) {
      if (dto.categoryId) {
        await this.assertActiveCategory(dto.categoryId);
      }
      if (dto.categoryTypeId) {
        await this.assertCategoryTypeMatchesCategory(
          dto.categoryId ?? null,
          dto.categoryTypeId,
        );
      }

      const draftsCount = await (this.prisma.storeCollection as any).count({
        where: { ownerId, status: 'DRAFT', deletedAt: null },
      });
      if (draftsCount >= 4) {
        throw new BadRequestException(
          'You can have maximum 4 draft collections. Please publish or delete an existing draft to continue.',
        );
      }

      const collectionId = uuidv4();
      const now = new Date();
      const collection = await (this.prisma.storeCollection as any).create({
        data: {
          id: collectionId,
          ownerId,
          title: dto.title?.trim() || null,
          description: dto.description?.trim() || null,
          status: 'DRAFT',
          visibility: dto.visibility ?? CollectionVisibility.PUBLIC,
          type: dto.type ?? CollectionType.EVERYBODY,
          tags: Array.isArray(dto.tags) ? sanitizeTags(dto.tags) : [],
          categoryId: dto.categoryId || null,
          categoryTypeId: dto.categoryTypeId || null,
          draftVersion: 0,
        },
      });
      const indexedCollectionTags = this.getIndexedCollectionTags(
        {
          status: collection.status,
          visibility: collection.visibility as CollectionVisibility,
          deletedAt: null,
          tags: collection.tags ?? [],
        },
        collection.tags ?? [],
      );
      if (this.tagIndex && indexedCollectionTags.length > 0) {
        await this.tagIndex.syncEntityTags(
          TAG_ENTITY_TYPE.COLLECTION,
          collection.id,
          [],
          indexedCollectionTags,
          { maxCount: 30 },
        );
      }

      return {
        sessionId: collection.id,
        expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      };
    }

    if (dto.draftOnly) {
      if (dto.categoryId) {
        await this.assertActiveCategory(dto.categoryId);
      }
      if (dto.categoryTypeId) {
        await this.assertCategoryTypeMatchesCategory(
          dto.categoryId ?? null,
          dto.categoryTypeId,
        );
      }

      const sanitizedTags = sanitizeTags(dto.tags ?? []);
      const collectionId = uuidv4();
      const now = new Date();
      const collection = await (this.prisma.collection as any).create({
        data: {
          id: collectionId,
          owner: { connect: { id: ownerId } },
          domain: 'DESIGN',
          title: dto.title?.trim() || null,
          description: dto.description?.trim() || null,
          minPrice: dto.minPrice,
          maxPrice: dto.maxPrice,
          isAvailableInStore: dto.isAvailableInStore ?? false,
          sizingMode: dto.sizingMode ?? 'NONE',
          rtwSizes: Array.isArray(dto.rtwSizes) ? dto.rtwSizes : [],
          rtwSizeSystem: dto.rtwSizeSystem ?? null,
          rtwSizeType: dto.rtwSizeType ?? null,
          customGender: dto.customGender ?? null,
          customMeasurementKeys: this.normalizeMeasurementKeys(
            dto.customMeasurementKeys,
          ),
          customFreeformPointIds: Array.isArray(dto.customFreeformPointIds)
            ? dto.customFreeformPointIds
            : [],
          fitPreference: dto.fitPreference ?? null,
          targetAgeGroup: dto.targetAgeGroup ?? 'ADULT',
          tags: sanitizedTags,
          status: 'DRAFT',
          visibility: dto.visibility ?? CollectionVisibility.PUBLIC,
          type: dto.type ?? CollectionType.EVERYBODY,
          ...(dto.categoryId
            ? { category: { connect: { id: dto.categoryId } } }
            : {}),
          ...(dto.categoryTypeId
            ? { categoryType: { connect: { id: dto.categoryTypeId } } }
            : {}),
          lastActivityAt: now,
          draftVersion: 0,
        },
      });

      const initialFilterValueIds = this.normalizeFilterValueIds(
        dto.filterValueIds,
      );
      if (this.categoriesService) {
        await this.categoriesService.setEntityFilters(
          'COLLECTION',
          collection.id,
          initialFilterValueIds,
        );
      }

      const indexedCollectionTags = this.getIndexedCollectionTags(
        {
          status: collection.status,
          visibility: collection.visibility as CollectionVisibility,
          deletedAt: null,
          tags: sanitizedTags,
        },
        sanitizedTags,
      );
      if (this.tagIndex && indexedCollectionTags.length > 0) {
        await this.tagIndex.syncEntityTags(
          TAG_ENTITY_TYPE.COLLECTION,
          collection.id,
          [],
          indexedCollectionTags,
          { maxCount: 30 },
        );
      }

      if (!hasFiles) {
        return {
          collectionId: collection.id,
          uploads: [],
          expiresIn: 30 * 60 * 1000,
        };
      }

      const uploadData = await Promise.all(
        dto.files.map(async (fileSpec, index) => {
          // Validate and determine file type
          const fileType = this.helperservice.determineFileType(
            fileSpec.type,
            fileSpec.fileType,
          );
          await this.helperservice.validateFileSpec(fileSpec, fileType);

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
            expiresIn: (presign as any).expiresIn || 600,
          };
        }),
      );

      return {
        collectionId: collection.id,
        uploads: uploadData,
        expiresIn: 600,
        tags: sanitizedTags,
        draftStatus: {
          isDraft: true,
        },
      };
    }

    if (!dto.title || !dto.title.trim()) {
      throw new BadRequestException('Title is required');
    }

    if (!dto.categoryId) {
      throw new BadRequestException('Category is required');
    }

    if (!isUuid(dto.categoryId)) {
      throw new BadRequestException('Category format is invalid');
    }

    // Validate files array
    if (!dto.files || dto.files.length === 0) {
      throw new BadRequestException('At least one file is required');
    }

    if (dto.files.length > DESIGN_MAX_MEDIA_COUNT) {
      throw new BadRequestException(`Maximum ${DESIGN_MAX_MEDIA_COUNT} files per design`);
    }

    // PHASE 2: Use shared tag normalization utility
    const sanitizedTags = sanitizeTags(dto.tags ?? []);

    if (sanitizedTags.length === 0) {
      throw new BadRequestException('At least one descriptive tag is required');
    }

    // Require a valid, active category
    await this.assertActiveCategory(dto.categoryId);
    if (dto.categoryTypeId) {
      await this.assertCategoryTypeMatchesCategory(
        dto.categoryId,
        dto.categoryTypeId,
      );
    }
    const finalCategoryId = dto.categoryId;
    const collectionStatus: 'DRAFT' | 'PUBLISHED' = 'DRAFT';

    // Create collection in DRAFT status
    const collectionId = uuidv4();
    const now = new Date();
    const collection = await (this.prisma.collection as any).create({
      data: {
        id: collectionId,
        owner: { connect: { id: ownerId } },
        domain: 'DESIGN',
        title: dto.title,
        description: dto.description,
        minPrice: dto.minPrice,
        maxPrice: dto.maxPrice,
        isAvailableInStore: false,
        sizingMode: dto.sizingMode ?? 'NONE',
        rtwSizes: Array.isArray(dto.rtwSizes) ? dto.rtwSizes : [],
        rtwSizeSystem: dto.rtwSizeSystem ?? null,
        rtwSizeType: dto.rtwSizeType ?? null,
        customGender: dto.customGender ?? null,
        customMeasurementKeys: this.normalizeMeasurementKeys(
          dto.customMeasurementKeys,
        ),
        customFreeformPointIds: Array.isArray(dto.customFreeformPointIds)
          ? dto.customFreeformPointIds
          : [],
        fitPreference: dto.fitPreference ?? null,
        targetAgeGroup: dto.targetAgeGroup ?? 'ADULT',
        tags: sanitizedTags,
        status: collectionStatus,
        visibility: dto.visibility ?? CollectionVisibility.PUBLIC,
        type: dto.type ?? CollectionType.EVERYBODY,
        // Set required category
        category: { connect: { id: finalCategoryId } },
        categoryType: dto.categoryTypeId
          ? { connect: { id: dto.categoryTypeId } }
          : undefined,
        lastActivityAt: now,
        draftVersion: 0,
      },
    });

    const initialFilterValueIds = this.normalizeFilterValueIds(
      dto.filterValueIds,
    );
    if (this.categoriesService) {
      await this.categoriesService.setEntityFilters(
        'COLLECTION',
        collection.id,
        initialFilterValueIds,
      );
    }

    const indexedCollectionTags = this.getIndexedCollectionTags(
      {
        status: collection.status,
        visibility: collection.visibility as CollectionVisibility,
        deletedAt: null,
        tags: sanitizedTags,
      },
      sanitizedTags,
    );
    if (this.tagIndex && indexedCollectionTags.length > 0) {
      await this.tagIndex.syncEntityTags(
        TAG_ENTITY_TYPE.COLLECTION,
        collection.id,
        [],
        indexedCollectionTags,
        { maxCount: 30 },
      );
    }

    // Generate presigned URLs for each file using UploadService (creates presign DB entries)
    const uploadData = await Promise.all(
      dto.files.map(async (fileSpec, index) => {
        // Validate and determine file type
        const fileType = this.helperservice.determineFileType(
          fileSpec.type,
          fileSpec.fileType,
        );
        await this.helperservice.validateFileSpec(fileSpec, fileType);

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

  async initializeCollectionMediaUploads(
    collectionId: string,
    userId: string,
    files: FileSpecDto[],
    scope: CollectionScope = 'design',
  ) {
    const resolvedScope = this.normalizeCollectionScope(scope);
    const expectedDomain = this.scopeToDomain(resolvedScope);
    if (expectedDomain !== 'DESIGN') {
      throw new BadRequestException(
        'Media upload initialization is only supported for designs.',
      );
    }

    await this.assertOwner(collectionId, userId, 'DESIGN');

    if (!Array.isArray(files) || files.length === 0) {
      throw new BadRequestException('At least one file is required');
    }
    if (files.length > DESIGN_MAX_MEDIA_COUNT) {
      throw new BadRequestException(`Maximum ${DESIGN_MAX_MEDIA_COUNT} files per design`);
    }

    const existingMediaCount = await this.prisma.collectionMedia.count({
      where: { collectionId },
    });
    if (existingMediaCount + files.length > DESIGN_MAX_MEDIA_COUNT) {
      throw new BadRequestException(
        `Adding these files would exceed the ${DESIGN_MAX_MEDIA_COUNT}-file design limit.`,
      );
    }

    const uploads = await Promise.all(
      files.map(async (fileSpec, index) => {
        const fileType = this.helperservice.determineFileType(
          fileSpec.type,
          fileSpec.fileType,
        );
        await this.helperservice.validateFileSpec(fileSpec, fileType);

        const presign = await this.uploadService.createPresignedPost(
          userId,
          fileSpec.name,
          fileType as any,
          fileSpec.type,
          { collectionId, orderIndex: existingMediaCount + index },
        );

        return {
          fileId: (presign as any).fileId,
          orderIndex: existingMediaCount + index,
          expectedKey: (presign as any).key,
          uploadUrl: (presign as any).url,
          uploadFields: (presign as any).fields,
          expiresIn: (presign as any).expiresIn || 600,
        };
      }),
    );

    return {
      collectionId,
      uploads,
      expiresIn: 600,
    };
  }

  async getMarketFeed(options?: {
    cursor?: string;
    limit?: number;
    tag?: string;
    category?: string;
    countsPolicy?: 'combined';
    requesterId?: string; // Add requesterId to check thread status
  }) {
    const { cursor, limit = 20, tag, category, requesterId } = options ?? {};
    const take = Math.min(Math.max(limit, 1), 40);
    this.logger.debug(
      `[feed] market query start cursor=${cursor ?? 'none'} limit=${take} tag=${tag ?? 'all'} category=${category ?? 'all'}`,
    );
    const readyMediaWhere = {
      file: {
        processingStatus: 'READY',
        originalDeletedAt: null,
        s3Url: { not: '' },
      },
    } as any;

    const where: Prisma.CollectionWhereInput = {
      domain: 'DESIGN',
      status: 'PUBLISHED',
      visibility: CollectionVisibility.PUBLIC,
      deletedAt: null,
      medias: {
        some: readyMediaWhere,
      } as any,
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
    } as Prisma.CollectionWhereInput;

    const collections = await this.prisma.collection.findMany({
      where,
      take: take + 1,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      include: {
        owner: {
          select: this.selectCollectionOwnerDisplay(),
        },
        medias: {
          where: readyMediaWhere,
          include: {
            file: {
              include: {
                variants: true,
              },
            },
          },
          orderBy: [{ orderIndex: 'asc' }],
        },
        _count: {
          select: {
            reactions: true,
            comments: true,
            collectionCollabs: true,
          },
        },
      },
    });

    const hasNextPage = collections.length > take;
    const data = hasNextPage ? collections.slice(0, -1) : collections;
    this.logger.debug(
      `[feed] market query result fetched=${collections.length} page=${data.length} hasNextPage=${hasNextPage}`,
    );
    if (collections.length === 0 && typeof (this.prisma.collection as any).count === 'function') {
      try {
        const [publishedPublic, withAnyMedia, readyOriginals, blockedByProcessing] =
          await Promise.all([
            this.prisma.collection.count({
              where: {
                domain: 'DESIGN',
                status: 'PUBLISHED',
                visibility: CollectionVisibility.PUBLIC,
                deletedAt: null,
              } as any,
            }),
            this.prisma.collection.count({
              where: {
                domain: 'DESIGN',
                status: 'PUBLISHED',
                visibility: CollectionVisibility.PUBLIC,
                deletedAt: null,
                medias: { some: {} },
              } as any,
            }),
            this.prisma.collection.count({ where } as any),
            this.prisma.collection.count({
              where: {
                domain: 'DESIGN',
                status: 'PUBLISHED',
                visibility: CollectionVisibility.PUBLIC,
                deletedAt: null,
                medias: {
                  some: {
                    file: {
                      processingStatus: { not: 'READY' },
                      originalDeletedAt: null,
                      s3Url: { not: '' },
                    },
                  },
                },
              } as any,
            }),
          ]);
        this.logger.debug(
          `[feed-contract] market exclusion summary publishedPublic=${publishedPublic} withAnyMedia=${withAnyMedia} readyOriginals=${readyOriginals} blockedByProcessing=${blockedByProcessing}`,
        );
      } catch (error) {
        this.logger.warn(`[feed-contract] market exclusion summary failed: ${String(error)}`);
      }
    }

    const feedRows = data
      .map((collection) => {
        const coverMediaId = (collection as any).coverMediaId as string | null;
        const coverMedia =
          (coverMediaId
            ? collection.medias.find((media) => media.id === coverMediaId)
            : null) ?? collection.medias[0] ?? null;
        if (!coverMedia) {
          this.logger.debug(`[feed-contract] collection excluded missing-ready-cover collectionId=${collection.id}`);
          return null;
        }

        return {
          collection,
          media: coverMedia,
        };
      })
      .filter(
        (
          row,
        ): row is {
          collection: (typeof data)[number];
          media: (typeof data)[number]['medias'][number];
        } => Boolean(row),
      );

    // Hydrate isThreaded for requester when available
    let isThreadedMap: Record<string, boolean> = {};
    if (requesterId) {
      const mediaIds = feedRows.map((row) => row.media.id);
      if (mediaIds.length) {
        const threaded = await this.prisma.collectionMediaReaction.findMany({
          where: {
            userId: requesterId,
            type: ReactionType.THREAD,
            collectionMediaId: { in: mediaIds },
          },
          select: { collectionMediaId: true },
        });
        const set = new Set(threaded.map((r) => r.collectionMediaId));
        isThreadedMap = mediaIds.reduce((acc, id) => {
          acc[id] = set.has(id);
          return acc;
        }, {} as Record<string, boolean>);
      }
    }

    const items = feedRows.map(({ collection, media }) => {
      const owner = this.mapCollectionOwner(collection.owner)!;
      const primaryMedia = this.buildFeedMediaAsset({
        id: media.id,
        file: media.file,
        mediaType: media.mediaType,
        orderIndex: media.orderIndex,
      });
      if (!primaryMedia) {
        this.logger.debug(`[feed-contract] media excluded unavailable-primary collectionId=${collection.id} mediaId=${media.id}`);
        return null;
      }

      const mediaItems = collection.medias
        .map((entry) =>
          this.buildFeedMediaAsset({
            id: entry.id,
            file: entry.file,
            mediaType: entry.mediaType,
            orderIndex: entry.orderIndex,
          }),
        )
        .filter((asset): asset is FeedMediaAssetDto => Boolean(asset));
      if (mediaItems.length === 0) {
        this.logger.debug(`[feed-contract] collection excluded no-valid-media collectionId=${collection.id}`);
        return null;
      }

      const logoFileId = owner.profileImageId ?? owner.profileImageFile?.id ?? null;
      const avatar = this.buildFeedBrandAvatar(collection.owner);
      const combinedCommentsCount =
        (collection.commentsCount ?? 0) + (media.commentsCount ?? 0);
      const commentsCount =
        options?.countsPolicy === 'combined'
          ? combinedCommentsCount
          : media.commentsCount ?? collection.commentsCount ?? 0;

      const base = {
        id: media.id,
        collectionId: collection.id,
        sourceType: 'DESIGN',
        title: collection.title ?? '',
        description: collection.description ?? null,
        brand: {
          id: owner.brand?.id ?? owner.id,
          name: owner.brandFullName ?? owner.username ?? '',
          username: owner.username ?? null,
          avatar,
        },
        primaryMedia,
        mediaItems,
        stats: {
          likes: collection._count?.reactions ?? collection.threadsCount ?? 0,
          comments: commentsCount,
          threads: media.threadsCount ?? 0,
          patches: collection.collectionCollabsCount ?? 0,
        },
        viewerState: {
          isLiked: false,
          isThreaded: requesterId ? !!isThreadedMap[media.id] : false,
          isPatched: false,
          canBag: Boolean(collection.customOrderEnabled),
          isBagged: false,
        },
        tags: collection.tags ?? [],
        createdAt: collection.createdAt.toISOString(),
        updatedAt: collection.updatedAt.toISOString(),
        // Temporary legacy compatibility for current web and older mobile builds.
        coverMediaId: (collection as any).coverMediaId ?? media.id,
        mediaType: media.mediaType,
        mediaFileId: media.fileUploadId,
        mediaUrl: primaryMedia.displayUrl,
        collectionTitle: collection.title ?? '',
        collectionDescription: collection.description ?? '',
        minPrice: collection.minPrice,
        maxPrice: collection.maxPrice,
        saleMinPrice: collection.saleMinPrice,
        saleMaxPrice: collection.saleMaxPrice,
        saleStartAt: collection.saleStartAt,
        saleEndAt: collection.saleEndAt,
        sizingMode: collection.sizingMode,
        customMeasurementKeys: collection.customMeasurementKeys ?? [],
        customAvailable: collection.customOrderEnabled === true,
        threadsCount: media.threadsCount,
        commentsCount: media.commentsCount,
        collectionCollabCount: collection.collectionCollabsCount,
        brandId: owner.brand?.id ?? owner.id,
        brandName: owner.brandFullName ?? owner.username ?? '',
        username: owner.username ?? '',
        brandLogo: avatar?.displayUrl ?? owner.profileImage ?? null,
        brandLogoFileId: logoFileId ?? null,
        isThreaded: requesterId ? !!isThreadedMap[media.id] : false,
      };

      if (options?.countsPolicy === 'combined') {
        (base as any).combinedCommentsCount = combinedCommentsCount;
      }

      return base;
    }).filter((item): item is NonNullable<typeof item> => Boolean(item));
    this.logger.debug(
      `[feed] market response items=${items.length} nextCursor=${hasNextPage ? (data[data.length - 1]?.id ?? 'none') : 'none'}`,
    );

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
    scope?: CollectionScope,
  ) {
    const resolvedScope = this.normalizeCollectionScope(scope);
    const expectedDomain = this.scopeToDomain(resolvedScope);
    const hasCompletions = Array.isArray(dto.completions) && dto.completions.length > 0;
    if (expectedDomain === 'STORE') {
      return this.finalizeStoreCollection(collectionId, userId, dto);
    }

    await this.assertOwner(collectionId, userId, expectedDomain ?? 'DESIGN');
    const collection = await this.prisma.collection.findUnique({
      where: { id: collectionId },
    });

    if (!collection) {
      throw new NotFoundException('Collection not found');
    }

    if (expectedDomain && (collection as any).domain !== expectedDomain) {
      throw new BadRequestException(
        'Finalize requested with design scope for a store collection.',
      );
    }

    const requestedAction = dto.action ?? (dto.shouldPublish === false ? 'draft' : 'publish');

    if (collection.status !== 'DRAFT') {
      if (collection.status === 'PUBLISHED' && requestedAction === 'draft') {
        throw new BadRequestException(
          'This collection is already published. Unpublish it before saving draft changes, or discard the draft.',
        );
      }
      if (collection.status === 'PUBLISHED' && !hasCompletions) {
        const published = await this.prisma.collection.findUnique({
          where: { id: collectionId },
          include: {
            owner: { select: this.selectCollectionOwnerDisplay() },
            medias: { include: { file: true }, orderBy: { orderIndex: 'asc' } },
            _count: {
              select: {
                reactions: true,
                comments: true,
                collectionCollabs: true,
                views: true,
              },
            },
          },
        });
        if (published) {
          return { ...published, owner: this.mapCollectionOwner(published.owner) };
        }
      }
      if (collection.status !== 'PUBLISHED' || !hasCompletions) {
        throw new BadRequestException('Collection is not in draft status');
      }
    }

    if (
      typeof dto.draftVersion === 'number' &&
      dto.draftVersion !== (collection as any).draftVersion
    ) {
      throw new ConflictException({
        code: 'DRAFT_VERSION_CONFLICT',
        message: 'Draft was modified by another session.',
        serverVersion: (collection as any).draftVersion,
      } as any);
    }
    await this.enforceDraftSessionLock(
      collectionId,
      collection.ownerId,
      dto.draftSessionToken,
    );

    if (!hasCompletions) {
      const previousVisibility = collection.visibility;
      if (!dto.collectionMetadata && !dto.action && dto.shouldPublish === undefined) {
        throw new BadRequestException('Missing upload completions');
      }
      const metadata = dto.collectionMetadata ?? {};
      const action = dto.action ?? (dto.shouldPublish === false ? 'draft' : 'publish');
      const normalizedFilterValueIds = this.normalizeFilterValueIds(
        metadata.filterValueIds,
      );
      const shouldUpdateFilters = Array.isArray(metadata.filterValueIds);
      const resolvedNextTags = Array.isArray(metadata.tags)
        ? sanitizeTags(metadata.tags, 30)
        : collection.tags ?? [];
      const nextCustomOrderEnabled =
        typeof (metadata as any).customOrderEnabled === 'boolean'
          ? Boolean((metadata as any).customOrderEnabled)
          : Boolean((collection as any).customOrderEnabled);

      if (action === 'publish') {
        const nextTitle = metadata.title ?? collection.title;
        if (!nextTitle || !nextTitle.trim()) {
          throw new BadRequestException('Title is required to publish');
        }
        if (resolvedNextTags.length === 0) {
          throw new BadRequestException('At least one descriptive tag is required');
        }
        const nextCategoryId = metadata.categoryId ?? collection.categoryId;
        if (!nextCategoryId) {
          throw new BadRequestException('Category is required to publish');
        }
        await this.assertActiveCategory(nextCategoryId);

        const nextCategoryTypeId =
          metadata.categoryTypeId ?? (collection as any).categoryTypeId;
        if (!nextCategoryTypeId) {
          throw new BadRequestException('Sub-category is required to publish');
        }
        await this.assertCategoryTypeMatchesCategory(
          nextCategoryId,
          nextCategoryTypeId,
        );
        await this.assertDesignCustomOrderPublishReady(
          collectionId,
          collection.ownerId,
          nextCustomOrderEnabled,
        );
      }

      if (
        metadata.categoryId !== undefined ||
        metadata.categoryTypeId !== undefined
      ) {
        const nextCategoryId = metadata.categoryId ?? collection.categoryId;
        const nextCategoryTypeId =
          metadata.categoryTypeId ?? (collection as any).categoryTypeId;
        if (nextCategoryId) {
          await this.assertActiveCategory(nextCategoryId);
        }
        if (nextCategoryTypeId) {
          await this.assertCategoryTypeMatchesCategory(
            nextCategoryId,
            nextCategoryTypeId,
          );
        }
      }

      const updated = await this.prisma.$transaction(async (tx) => {
        const isStoreDomain = (collection as any).domain === 'STORE';

        if (!isStoreDomain) {
          if (action === 'publish') {
            const mediaCount = await tx.collectionMedia.count({
              where: { collectionId },
            });
            if (mediaCount < DESIGN_REQUIRED_MEDIA_COUNT) {
              throw new BadRequestException(
                `Front, Back, Left, and Right media are required to publish (${DESIGN_REQUIRED_MEDIA_COUNT} media minimum).`,
              );
            }
            if (mediaCount > DESIGN_MAX_MEDIA_COUNT) {
              throw new BadRequestException(
                `Maximum ${DESIGN_MAX_MEDIA_COUNT} design media assets can be published.`,
              );
            }
          }

          const now = new Date();
          const updatedCollection = await tx.collection.update({
            where: { id: collectionId },
            data: {
              title: metadata.title ?? collection.title,
              description: metadata.description ?? collection.description,
              visibility: metadata.visibility ?? collection.visibility,
              type: metadata.type ?? collection.type,
              categoryId: metadata.categoryId ?? collection.categoryId,
              categoryTypeId:
                metadata.categoryTypeId ?? (collection as any).categoryTypeId,
              domain: 'DESIGN',
              isAvailableInStore: false,
              tags: resolvedNextTags,
              minPrice: collection.minPrice,
              maxPrice: collection.maxPrice,
              saleMinPrice: collection.saleMinPrice,
              saleMaxPrice: collection.saleMaxPrice,
              sizingMode: metadata.sizingMode ?? (collection as any).sizingMode,
              rtwSizes: Array.isArray(metadata.rtwSizes)
                ? metadata.rtwSizes
                : (collection as any).rtwSizes,
              rtwSizeSystem:
                metadata.rtwSizeSystem ?? (collection as any).rtwSizeSystem,
              rtwSizeType: metadata.rtwSizeType ?? (collection as any).rtwSizeType,
              customGender:
                metadata.customGender ?? (collection as any).customGender,
              customMeasurementKeys: Array.isArray(metadata.customMeasurementKeys)
                ? this.normalizeMeasurementKeys(metadata.customMeasurementKeys)
                : (collection as any).customMeasurementKeys,
              customOrderEnabled:
                typeof (metadata as any).customOrderEnabled === 'boolean'
                  ? Boolean((metadata as any).customOrderEnabled)
                  : Boolean((collection as any).customOrderEnabled),
              customFreeformPointIds: Array.isArray(
                metadata.customFreeformPointIds,
              )
                ? metadata.customFreeformPointIds
                : (collection as any).customFreeformPointIds,
              fitPreference:
                metadata.fitPreference ?? (collection as any).fitPreference,
              targetAgeGroup:
                metadata.targetAgeGroup ?? (collection as any).targetAgeGroup,
              status: action === 'publish' ? 'PUBLISHED' : 'DRAFT',
              ...(action === 'draft'
                ? { lastActivityAt: now, draftVersion: { increment: 1 } }
                : {}),
            },
          });
          if (action === 'publish') {
            await this.cleanupSupersededDraftCollections(
              tx,
              collection.ownerId,
              collectionId,
              updatedCollection.title,
              now,
              'DESIGN',
              false,
            );
          }
          return updatedCollection;
        }

        const links = await tx.storeCollectionProduct.findMany({
          where: { collectionId },
          include: {
            product: {
              select: {
                id: true,
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
        if (action === 'publish') {
          const inactiveIds = links
            .filter(
              (l) =>
                l.product &&
                l.product.deletedAt == null &&
                l.product.archivedAt == null &&
                l.product.isActive === false,
            )
            .map((l) => l.product!.id);
          if (inactiveIds.length > 0) {
            await tx.product.updateMany({
              where: { id: { in: inactiveIds } },
              data: { isActive: true },
            });
            links.forEach((l) => {
              if (l.product && inactiveIds.includes(l.product.id)) {
                l.product.isActive = true;
              }
            });
          }
        }

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

        const updatedCollection = await tx.collection.update({
          where: { id: collectionId },
          data: {
            title: metadata.title ?? collection.title,
            description: metadata.description ?? collection.description,
            visibility: metadata.visibility ?? collection.visibility,
            type: metadata.type ?? collection.type,
            categoryId: metadata.categoryId ?? collection.categoryId,
            categoryTypeId:
              metadata.categoryTypeId ?? (collection as any).categoryTypeId,
            domain:
              (collection as any).domain === 'STORE' ? 'STORE' : 'DESIGN',
            isAvailableInStore: (collection as any).domain === 'STORE',
            tags: resolvedNextTags,
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
        if (action === 'publish') {
          await this.cleanupSupersededDraftCollections(
            tx,
            userId,
            collectionId,
            updatedCollection.title,
            now,
            (updatedCollection as any).domain ?? null,
            Boolean((updatedCollection as any).isAvailableInStore),
          );
        }
        return updatedCollection;
      });

      if (
        (metadata.visibility ?? collection.visibility) !== previousVisibility &&
        (metadata.visibility ?? collection.visibility) === CollectionVisibility.PRIVATE
      ) {
        await this.handleVisibilityChange(collectionId, 'PRIVATE', userId);
      }
      const previousIndexedTags = this.getIndexedCollectionTags(
        {
          status: collection.status,
          visibility: collection.visibility as CollectionVisibility,
          deletedAt: collection.deletedAt,
          tags: collection.tags ?? [],
        },
        collection.tags ?? [],
      );
      const nextIndexedTags = this.getIndexedCollectionTags(
        {
          status: action === 'publish' ? 'PUBLISHED' : 'DRAFT',
          visibility:
            (metadata.visibility ?? collection.visibility) as CollectionVisibility,
          deletedAt: null,
          tags: resolvedNextTags,
        },
        resolvedNextTags,
      );
      const shouldSyncCollectionTags =
        Array.isArray(metadata.tags) ||
        !this.areTagsEqual(previousIndexedTags, nextIndexedTags);

      if (this.systemTags && shouldSyncCollectionTags) {
        await this.systemTags.syncTags(previousIndexedTags, nextIndexedTags);
      }
      if (this.tagIndex && shouldSyncCollectionTags) {
        await this.tagIndex.syncEntityTags(
          TAG_ENTITY_TYPE.COLLECTION,
          collectionId,
          previousIndexedTags,
          nextIndexedTags,
          { maxCount: 30 },
        );
      }

      if (shouldUpdateFilters && this.categoriesService) {
        await this.categoriesService.setEntityFilters(
          'COLLECTION',
          collectionId,
          normalizedFilterValueIds,
        );
      }

      return updated;
    }

    // Verify all uploads completed successfully and create central FileUpload records via UploadService
    if ((collection as any).domain === 'STORE') {
      throw new BadRequestException(
        'Store collections cannot be finalized with media uploads.',
      );
    }

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

    const enqueueAt = new Date();
    for (const entry of verifiedFiles) {
      const file = entry.file;
      await (this.prisma as any).presignedUpload.updateMany({
        where: { id: file.id, status: 'USED' },
        data: { processingEnqueuedAt: enqueueAt },
      });

      await this.uploadService.enqueueImageProcessing(file.id);
    }

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
    const completionAction = dto.action ?? (dto.shouldPublish === false ? 'draft' : 'publish');
    const newStatus = completionAction === 'publish' ? 'PUBLISHED' : 'DRAFT';
    const completionCustomOrderEnabled =
      typeof dto.collectionMetadata?.customOrderEnabled === 'boolean'
        ? Boolean(dto.collectionMetadata.customOrderEnabled)
        : Boolean((collection as any).customOrderEnabled);
    if (newStatus === 'PUBLISHED') {
      await this.assertDesignCustomOrderPublishReady(
        collectionId,
        collection.ownerId,
        completionCustomOrderEnabled,
      );
    }

    const finalizeAt = new Date();
    const publishedCollection = await this.prisma.collection.update({
      where: { id: collectionId },
      data: {
        domain: 'DESIGN',
        isAvailableInStore: false,
        status: newStatus,
        coverMediaId,
        ...(newStatus === 'DRAFT'
          ? { lastActivityAt: finalizeAt, draftVersion: { increment: 1 } }
          : {}),
      },
      include: {
        owner: { select: this.selectCollectionOwnerDisplay() },
        medias: { include: { file: true }, orderBy: { orderIndex: 'asc' } },
        _count: {
          select: {
            reactions: true,
            comments: true,
            collectionCollabs: true,
            views: true,
          },
        },
      },
    });

    const publishedOwner = this.mapCollectionOwner(publishedCollection.owner);
    if (newStatus === 'PUBLISHED') {
      await this.cleanupSupersededDraftCollections(
        this.prisma as any,
        collection.ownerId,
        collectionId,
        publishedCollection.title,
        finalizeAt,
        'DESIGN',
        false,
      );
    }

    const normalizedFinalizeFilterValueIds = this.normalizeFilterValueIds(
      dto.collectionMetadata?.filterValueIds,
    );
    if (Array.isArray(dto.collectionMetadata?.filterValueIds) && this.categoriesService) {
      await this.categoriesService.setEntityFilters(
        'COLLECTION',
        collectionId,
        normalizedFinalizeFilterValueIds,
      );
    }

    // Notify patchers if published
    if (newStatus === 'PUBLISHED' && this.notifications) {
      // Fetch patchers (user-to-brand patches)
      const patchers = await this.prisma.patchConnection.findMany({
        where: {
          targetId: collection.ownerId,
          status: PatchStatus.ACCEPTED,
          mode: PatchMode.USER_TO_BRAND,
        },
        select: { requesterId: true },
      });
      const recipientIds = patchers
        .map((p) => p.requesterId)
        .filter((id) => id && id !== collection.ownerId);

      if (recipientIds.length > 0 && this.notificationsQueue) {
        try {
          await this.notificationsQueue.enqueueFanout({
            recipientIds,
            notificationType: NotificationType.COLLECTION_UPLOAD,
            actorId: userId,
            payload: {
              collectionId: publishedCollection.id,
              collectionTitle: publishedCollection.title,
              targetUrl: `/collections/${publishedCollection.id}`,
              message: `${publishedOwner?.brandFullName || publishedOwner?.username} created a new collection: ${publishedCollection.title}`,
            },
          });
        } catch (e) {
          console.warn('Failed to enqueue collection publish fanout', e);
        }
      } else if (recipientIds.length > 0) {
        // Fan-out notifications (fallback)
        for (const recipientId of recipientIds) {
          try {
            await this.notifications.create(
              recipientId,
              NotificationType.COLLECTION_UPLOAD,
              {
                actorId: userId,
                payload: {
                  collectionId: publishedCollection.id,
                  collectionTitle: publishedCollection.title,
                  targetUrl: `/collections/${publishedCollection.id}`,
                  message: `${publishedOwner?.brandFullName || publishedOwner?.username} created a new collection: ${publishedCollection.title}`,
                },
              },
            );
          } catch (e) {
            console.warn(`Failed to notify patcher ${recipientId}`, e);
          }
        }
      }

      try {
        await this.notifications.create(userId, NotificationType.COLLECTION_UPLOAD, {
          actorId: userId,
          payload: {
            collectionId: publishedCollection.id,
            collectionTitle: publishedCollection.title,
            targetUrl: `/collections/${publishedCollection.id}`,
            message: `Your design "${publishedCollection.title}" is now live`,
          },
        });
      } catch (e) {
        console.warn('Failed to notify collection owner of publish', e);
      }
    }

    return {
      ...publishedCollection,
      owner: this.mapCollectionOwner(publishedCollection.owner),
    };
  }

  private async finalizeStoreCollection(
    collectionId: string,
    userId: string,
    dto: FinalizeCollectionDto,
  ) {
    await this.assertOwner(collectionId, userId, 'STORE');
    const collection = await this.prisma.storeCollection.findUnique({
      where: { id: collectionId },
    });
    if (!collection) {
      throw new NotFoundException('Collection not found');
    }
    if (collection.status !== 'DRAFT') {
      if (collection.status === 'PUBLISHED') {
        const existing = await this.prisma.storeCollection.findUnique({
          where: { id: collectionId },
          include: {
            owner: { select: this.selectCollectionOwnerDisplay() },
            products: {
              include: {
                product: {
                  include: { variants: { select: { id: true } } },
                },
              },
              orderBy: { orderIndex: 'asc' },
            },
          },
        });
        if (existing) {
          return { ...existing, owner: this.mapCollectionOwner(existing.owner) };
        }
      }
      throw new BadRequestException('Collection is not in draft status');
    }

    if (Array.isArray(dto.completions) && dto.completions.length > 0) {
      throw new BadRequestException(
        'Store collections cannot be finalized with media uploads.',
      );
    }
    if (!dto.collectionMetadata && !dto.action && dto.shouldPublish === undefined) {
      throw new BadRequestException('Missing collection metadata');
    }

    const metadata = dto.collectionMetadata ?? {};
    const action = dto.action ?? (dto.shouldPublish === false ? 'draft' : 'publish');
    const resolvedNextTags = Array.isArray(metadata.tags)
      ? sanitizeTags(metadata.tags, 30)
      : collection.tags ?? [];
    const normalizedManualFilterValueIds = this.normalizeFilterValueIds(
      metadata.filterValueIds,
    );
    const resolvedFilterValueIds = Array.isArray(metadata.filterValueIds)
      ? normalizedManualFilterValueIds
      : await this.collectStoreCollectionFilterValueIds(collectionId);

    if (action === 'publish') {
      const nextTitle = metadata.title ?? collection.title;
      if (!nextTitle || !nextTitle.trim()) {
        throw new BadRequestException('Title is required to publish');
      }
      if (resolvedNextTags.length === 0) {
        throw new BadRequestException('At least one descriptive tag is required');
      }
      const nextCategoryId = metadata.categoryId ?? collection.categoryId;
      if (!nextCategoryId) {
        throw new BadRequestException('Category is required to publish');
      }
      await this.assertActiveCategory(nextCategoryId);
      const nextCategoryTypeId =
        metadata.categoryTypeId ?? (collection as any).categoryTypeId;
      if (!nextCategoryTypeId) {
        throw new BadRequestException('Sub-category is required to publish');
      }
      await this.assertCategoryTypeMatchesCategory(
        nextCategoryId,
        nextCategoryTypeId,
      );
    }

    if (metadata.categoryId !== undefined || metadata.categoryTypeId !== undefined) {
      const nextCategoryId = metadata.categoryId ?? collection.categoryId;
      const nextCategoryTypeId =
        metadata.categoryTypeId ?? (collection as any).categoryTypeId;
      if (nextCategoryId) {
        await this.assertActiveCategory(nextCategoryId);
      }
      if (nextCategoryTypeId) {
        await this.assertCategoryTypeMatchesCategory(
          nextCategoryId,
          nextCategoryTypeId,
        );
      }
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const links = await tx.storeCollectionProduct.findMany({
        where: { collectionId },
        include: {
          product: {
            select: {
              id: true,
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
      if (action === 'publish') {
        const inactiveIds = links
          .filter(
            (l) =>
              l.product &&
              l.product.deletedAt == null &&
              l.product.archivedAt == null &&
              l.product.isActive === false,
          )
          .map((l) => l.product!.id);
        if (inactiveIds.length > 0) {
          await tx.product.updateMany({
            where: { id: { in: inactiveIds } },
            data: { isActive: true },
          });
          links.forEach((l) => {
            if (l.product && inactiveIds.includes(l.product.id)) {
              l.product.isActive = true;
            }
          });
        }
      }

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

      return tx.storeCollection.update({
        where: { id: collectionId },
        data: {
          title: metadata.title ?? collection.title,
          description: metadata.description ?? collection.description,
          visibility: metadata.visibility ?? collection.visibility,
          type: metadata.type ?? collection.type,
          categoryId: metadata.categoryId ?? collection.categoryId,
          categoryTypeId:
            metadata.categoryTypeId ?? (collection as any).categoryTypeId,
          tags: resolvedNextTags,
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

    const previousIndexedTags = this.getIndexedCollectionTags(
      {
        status: collection.status,
        visibility: collection.visibility as CollectionVisibility,
        deletedAt: collection.deletedAt,
        tags: collection.tags ?? [],
      },
      collection.tags ?? [],
    );
    const nextIndexedTags = this.getIndexedCollectionTags(
      {
        status: action === 'publish' ? 'PUBLISHED' : 'DRAFT',
        visibility:
          (metadata.visibility ?? collection.visibility) as CollectionVisibility,
        deletedAt: null,
        tags: resolvedNextTags,
      },
      resolvedNextTags,
    );
    const shouldSyncCollectionTags =
      Array.isArray(metadata.tags) ||
      !this.areTagsEqual(previousIndexedTags, nextIndexedTags);

    if (this.systemTags && shouldSyncCollectionTags) {
      await this.systemTags.syncTags(previousIndexedTags, nextIndexedTags);
    }
    if (this.tagIndex && shouldSyncCollectionTags) {
      await this.tagIndex.syncEntityTags(
        TAG_ENTITY_TYPE.COLLECTION,
        collectionId,
        previousIndexedTags,
        nextIndexedTags,
        { maxCount: 30 },
      );
    }

    if (this.categoriesService) {
      await this.categoriesService.setEntityFilters(
        'STORE_COLLECTION',
        collectionId,
        this.normalizeFilterValueIds(resolvedFilterValueIds),
      );
    }

    return updated;
  }

  // ===================== Store Collection Membership =====================
  async addProductsToCollection(
    collectionId: string,
    ownerId: string,
    productIds: string[],
  ) {
    const collectionOwner = await this.assertOwner(collectionId, ownerId, 'STORE');
    if (!Array.isArray(productIds) || productIds.length === 0) {
      throw new BadRequestException('productIds is required');
    }

    const result = await this.prisma.$transaction(async (tx) => {
      await this.lockCollectionForUpdate(tx, collectionId, 'STORE');
      const products = await tx.product.findMany({
        where: { id: { in: productIds }, deletedAt: null },
        include: { brand: true },
      });

      if (products.length !== productIds.length) {
        throw new NotFoundException('One or more products not found');
      }

      for (const p of products) {
        if (p.brand?.ownerId !== collectionOwner.ownerId) {
          throw new ForbiddenException('Not owner of one or more products');
        }
      }

      const existingLinks = await tx.storeCollectionProduct.findMany({
        where: { collectionId, productId: { in: productIds } },
        select: { productId: true },
      });
      const existingSet = new Set(existingLinks.map((l) => l.productId));

      const existingCount = await tx.storeCollectionProduct.count({
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

        const memberships = await tx.storeCollectionProduct.findMany({
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

        const existingPrimary = await tx.storeCollectionProduct.findFirst({
          where: { productId, isPrimary: true },
          select: { collectionId: true },
        });
        const shouldBePrimary = !existingPrimary;

        await tx.storeCollectionProduct.create({
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

      await this.touchDraftActivity(tx, collectionId, 'STORE');
      return { success: true };
    }, { timeout: 15000 });

    // Do non-critical recompute work asynchronously to keep add-to-collection fast.
    void Promise.allSettled([
      this.recalculateCollectionPriceRange(collectionId),
      this.syncStoreCollectionFiltersFromProducts(collectionId),
    ]).catch(() => undefined);
    return result;
  }

  async removeProductsFromCollection(
    collectionId: string,
    ownerId: string,
    productIds: string[],
  ) {
    await this.assertOwner(collectionId, ownerId, 'STORE');
    if (!Array.isArray(productIds) || productIds.length === 0) {
      throw new BadRequestException('productIds is required');
    }

    const result = await this.prisma.$transaction(async (tx) => {
      await this.lockCollectionForUpdate(tx, collectionId, 'STORE');
      const existingLinks = await tx.storeCollectionProduct.findMany({
        where: { collectionId, productId: { in: productIds } },
        select: { productId: true, isPrimary: true },
      });

      await tx.storeCollectionProduct.deleteMany({
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

      await this.touchDraftActivity(tx, collectionId, 'STORE');
      return { success: true };
    }, { timeout: 15000 });

    // Do non-critical recompute work asynchronously to keep remove flow fast.
    void Promise.allSettled([
      this.recalculateCollectionPriceRange(collectionId),
      this.syncStoreCollectionFiltersFromProducts(collectionId),
    ]).catch(() => undefined);
    return result;
  }

  async reorderCollectionProducts(
    collectionId: string,
    ownerId: string,
    items: Array<{ productId: string; orderIndex: number }>,
  ) {
    await this.assertOwner(collectionId, ownerId, 'STORE');
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

    const existing = await this.prisma.storeCollectionProduct.findMany({
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
        await tx.storeCollectionProduct.updateMany({
          where: { collectionId, productId: item.productId },
          data: { orderIndex: item.orderIndex },
        });
      }

      await this.touchDraftActivity(tx, collectionId, 'STORE');
    });

    return { success: true };
  }

  async reorderCollectionMedia(
    collectionId: string,
    ownerId: string,
    items: Array<{ mediaId: string; orderIndex: number }>,
    scope: CollectionScope = 'design',
  ) {
    const resolvedScope = this.normalizeCollectionScope(scope);
    const expectedDomain = this.scopeToDomain(resolvedScope);
    if (expectedDomain !== 'DESIGN') {
      throw new BadRequestException(
        'Media reordering is only supported for designs.',
      );
    }

    await this.assertOwner(collectionId, ownerId, 'DESIGN');

    if (!Array.isArray(items) || items.length === 0) {
      throw new BadRequestException('items is required');
    }

    const mediaIdSet = new Set(items.map((item) => item.mediaId));
    if (mediaIdSet.size !== items.length) {
      throw new BadRequestException('Duplicate mediaId in reorder request');
    }

    const orderIndexSet = new Set(items.map((item) => item.orderIndex));
    if (orderIndexSet.size !== items.length) {
      throw new BadRequestException('Duplicate orderIndex in reorder request');
    }

    if (items.some((item) => item.orderIndex < 0)) {
      throw new BadRequestException('orderIndex must be non-negative');
    }

    await this.prisma.$transaction(async (tx) => {
      await this.lockCollectionForUpdate(tx, collectionId, 'DESIGN');

      const collection = await tx.collection.findUnique({
        where: { id: collectionId },
        select: {
          id: true,
          status: true,
          coverMediaId: true,
        } as any,
      });
      if (!collection) {
        throw new NotFoundException('Collection not found');
      }

      const existingMedia = await tx.collectionMedia.findMany({
        where: { collectionId },
        select: { id: true },
        orderBy: { orderIndex: 'asc' },
      });

      if (existingMedia.length !== items.length) {
        throw new BadRequestException(
          'Reorder request must include every design media item exactly once.',
        );
      }

      const existingIdSet = new Set(existingMedia.map((media) => media.id));
      for (const mediaId of items.map((item) => item.mediaId)) {
        if (!existingIdSet.has(mediaId)) {
          throw new BadRequestException(
            'Reorder request contains media that does not belong to design.',
          );
        }
      }

      const normalizedItems = [...items]
        .sort((a, b) => a.orderIndex - b.orderIndex)
        .map((item, index) => ({
          mediaId: item.mediaId,
          orderIndex: index,
        }));

      for (const item of normalizedItems) {
        await tx.collectionMedia.update({
          where: { id: item.mediaId },
          data: { orderIndex: item.orderIndex },
        });
      }

      const currentCoverMediaId =
        typeof (collection as any).coverMediaId === 'string'
          ? ((collection as any).coverMediaId as string)
          : null;
      const currentStatus =
        typeof (collection as any).status === 'string'
          ? ((collection as any).status as string)
          : null;
      const nextCoverMediaId =
        normalizedItems.find((item) => item.mediaId === currentCoverMediaId)
          ?.mediaId ??
        normalizedItems[0]?.mediaId ??
        null;

      await tx.collection.update({
        where: { id: collectionId },
        data: {
          coverMediaId: nextCoverMediaId,
          ...(currentStatus === 'DRAFT'
            ? {
                lastActivityAt: new Date(),
                draftVersion: { increment: 1 },
              }
            : {}),
        } as any,
      });
    });

    return { success: true };
  }

  async archiveCollection(
    collectionId: string,
    ownerId: string,
    scope?: CollectionScope,
  ) {
    const resolvedScope = this.normalizeCollectionScope(scope);
    const expectedDomain = this.scopeToDomain(resolvedScope);
    if (expectedDomain === 'STORE') {
      await this.assertOwner(
        collectionId,
        ownerId,
        'STORE',
        BRAND_PERMISSIONS.CATALOG_DELETE,
      );
      const collection = await this.prisma.storeCollection.findUnique({
        where: { id: collectionId },
        select: { status: true, visibility: true, deletedAt: true, tags: true },
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

      await this.prisma.storeCollection.update({
        where: { id: collectionId },
        data: { status: 'ARCHIVED', archivedFromStatus: collection.status },
      });

      const previousIndexedTags = this.getIndexedCollectionTags(
        {
          status: collection.status,
          visibility: collection.visibility,
          deletedAt: collection.deletedAt,
          tags: collection.tags ?? [],
        },
        collection.tags ?? [],
      );
      if (previousIndexedTags.length > 0 && this.systemTags) {
        await this.systemTags.syncTags(previousIndexedTags, []);
      }
      if (previousIndexedTags.length > 0 && this.tagIndex) {
        await this.tagIndex.syncEntityTags(
          TAG_ENTITY_TYPE.COLLECTION,
          collectionId,
          previousIndexedTags,
          [],
          { maxCount: 30 },
        );
      }

      return { success: true, status: 'ARCHIVED' };
    }

    await this.assertOwner(
      collectionId,
      ownerId,
      expectedDomain ?? undefined,
      BRAND_PERMISSIONS.CATALOG_DELETE,
    );
    const collection = await this.prisma.collection.findUnique({
      where: { id: collectionId },
      select: { status: true, visibility: true, deletedAt: true, tags: true },
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

    const previousIndexedTags = this.getIndexedCollectionTags(
      {
        status: collection.status,
        visibility: collection.visibility,
        deletedAt: collection.deletedAt,
        tags: collection.tags ?? [],
      },
      collection.tags ?? [],
    );
    if (previousIndexedTags.length > 0 && this.systemTags) {
      await this.systemTags.syncTags(previousIndexedTags, []);
    }
    if (previousIndexedTags.length > 0 && this.tagIndex) {
      await this.tagIndex.syncEntityTags(
        TAG_ENTITY_TYPE.COLLECTION,
        collectionId,
        previousIndexedTags,
        [],
        { maxCount: 30 },
      );
    }

    return { success: true, status: 'ARCHIVED' };
  }

  async unarchiveCollection(
    collectionId: string,
    ownerId: string,
    scope?: CollectionScope,
  ) {
    const resolvedScope = this.normalizeCollectionScope(scope);
    const expectedDomain = this.scopeToDomain(resolvedScope);
    if (expectedDomain === 'STORE') {
      await this.assertOwner(
        collectionId,
        ownerId,
        'STORE',
        BRAND_PERMISSIONS.CATALOG_DELETE,
      );
      await this.ensureAdminRepublishUnlocked('StoreCollection', collectionId);
      const collection = await this.prisma.storeCollection.findUnique({
        where: { id: collectionId },
        select: {
          status: true,
          archivedFromStatus: true,
          visibility: true,
          deletedAt: true,
          tags: true,
        },
      });
      if (!collection) throw new NotFoundException('Collection not found');
      if (collection.status !== 'ARCHIVED') {
        throw new BadRequestException('Collection is not archived');
      }

      const restoreStatus = collection.archivedFromStatus ?? 'DRAFT';
      await this.prisma.storeCollection.update({
        where: { id: collectionId },
        data: { status: restoreStatus, archivedFromStatus: null },
      });

      const previousIndexedTags = this.getIndexedCollectionTags(
        {
          status: collection.status,
          visibility: collection.visibility,
          deletedAt: collection.deletedAt,
          tags: collection.tags ?? [],
        },
        collection.tags ?? [],
      );
      const nextIndexedTags = this.getIndexedCollectionTags(
        {
          status: restoreStatus,
          visibility: collection.visibility,
          deletedAt: null,
          tags: collection.tags ?? [],
        },
        collection.tags ?? [],
      );
      if (this.systemTags && !this.areTagsEqual(previousIndexedTags, nextIndexedTags)) {
        await this.systemTags.syncTags(previousIndexedTags, nextIndexedTags);
      }
      if (this.tagIndex && !this.areTagsEqual(previousIndexedTags, nextIndexedTags)) {
        await this.tagIndex.syncEntityTags(
          TAG_ENTITY_TYPE.COLLECTION,
          collectionId,
          previousIndexedTags,
          nextIndexedTags,
          { maxCount: 30 },
        );
      }

      return { success: true, status: restoreStatus };
    }

    await this.assertOwner(
      collectionId,
      ownerId,
      expectedDomain ?? undefined,
      BRAND_PERMISSIONS.CATALOG_DELETE,
    );
    await this.ensureAdminRepublishUnlocked('Collection', collectionId);
    const collection = await this.prisma.collection.findUnique({
      where: { id: collectionId },
      select: {
        status: true,
        archivedFromStatus: true,
        visibility: true,
        deletedAt: true,
        tags: true,
      },
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

    const previousIndexedTags = this.getIndexedCollectionTags(
      {
        status: collection.status,
        visibility: collection.visibility,
        deletedAt: collection.deletedAt,
        tags: collection.tags ?? [],
      },
      collection.tags ?? [],
    );
    const nextIndexedTags = this.getIndexedCollectionTags(
      {
        status: restoreStatus,
        visibility: collection.visibility,
        deletedAt: null,
        tags: collection.tags ?? [],
      },
      collection.tags ?? [],
    );
    if (this.systemTags && !this.areTagsEqual(previousIndexedTags, nextIndexedTags)) {
      await this.systemTags.syncTags(previousIndexedTags, nextIndexedTags);
    }
    if (this.tagIndex && !this.areTagsEqual(previousIndexedTags, nextIndexedTags)) {
      await this.tagIndex.syncEntityTags(
        TAG_ENTITY_TYPE.COLLECTION,
        collectionId,
        previousIndexedTags,
        nextIndexedTags,
        { maxCount: 30 },
      );
    }

    return { success: true, status: restoreStatus };
  }

  async requestCollectionRepublishApproval(
    collectionId: string,
    ownerId: string,
    reason?: string,
    scope?: CollectionScope,
  ) {
    const resolvedScope = this.normalizeCollectionScope(scope);
    const expectedDomain = this.scopeToDomain(resolvedScope);

    if (expectedDomain === 'STORE') {
      await this.assertOwner(collectionId, ownerId, 'STORE');
      const collection = await this.prisma.storeCollection.findUnique({
        where: { id: collectionId },
        select: { id: true, title: true, status: true },
      });
      if (!collection) throw new NotFoundException('Collection not found');
      if (collection.status !== 'ARCHIVED') {
        throw new BadRequestException('Collection is not archived');
      }

      let isAdminLocked = false;
      try {
        await this.ensureAdminRepublishUnlocked('StoreCollection', collectionId);
      } catch (error) {
        if (error instanceof ForbiddenException) {
          isAdminLocked = true;
        } else {
          throw error;
        }
      }
      if (!isAdminLocked) {
        throw new BadRequestException('This collection is not currently blocked by admin moderation');
      }

      await this.notifyAdminsForRepublishRequest(
        ownerId,
        'STORE_COLLECTION',
        collectionId,
        collection.title ?? 'Untitled',
        reason,
      );
      return {
        success: true,
        message: 'Republish request sent to admin for review',
      };
    }

    await this.assertOwner(collectionId, ownerId, expectedDomain ?? undefined);
    const collection = await this.prisma.collection.findUnique({
      where: { id: collectionId },
      select: { id: true, title: true, status: true },
    });
    if (!collection) throw new NotFoundException('Collection not found');
    if (collection.status !== 'ARCHIVED') {
      throw new BadRequestException('Collection is not archived');
    }

    let isAdminLocked = false;
    try {
      await this.ensureAdminRepublishUnlocked('Collection', collectionId);
    } catch (error) {
      if (error instanceof ForbiddenException) {
        isAdminLocked = true;
      } else {
        throw error;
      }
    }
    if (!isAdminLocked) {
      throw new BadRequestException('This collection is not currently blocked by admin moderation');
    }

    await this.notifyAdminsForRepublishRequest(
      ownerId,
      'COLLECTION',
      collectionId,
      collection.title ?? 'Untitled',
      reason,
    );
    return {
      success: true,
      message: 'Republish request sent to admin for review',
    };
  }

  private async ensureAdminRepublishUnlocked(
    targetType: 'Collection' | 'StoreCollection',
    targetId: string,
  ) {
    const logs = await (this.prisma as any).adminAuditLog.findMany({
      where: {
        action: 'ADMIN_COLLECTION_MODERATE',
        targetType,
        targetId,
      },
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: {
        newState: true,
      },
    });

    for (const log of logs) {
      const state =
        log?.newState && typeof log.newState === 'object' && !Array.isArray(log.newState)
          ? (log.newState as Record<string, unknown>)
          : {};
      const action = String(state.action ?? '').toUpperCase();
      const status = String(state.status ?? '').toUpperCase();

      if (action === 'REPUBLISH' || status === 'PUBLISHED') {
        return;
      }

      if (action === 'UNPUBLISH' || status === 'ARCHIVED') {
        throw new ForbiddenException(
          'This content was unpublished by admin and cannot be republished until admin approval.',
        );
      }
    }
  }

  private async notifyAdminsForRepublishRequest(
    actorId: string,
    targetType: 'COLLECTION' | 'STORE_COLLECTION',
    targetId: string,
    title: string,
    reason?: string,
  ) {
    if (!this.notifications) return;

    const admins = await this.prisma.user.findMany({
      where: {
        role: { in: ['Admin', 'SuperAdmin'] as any },
        status: 'ACTIVE',
      },
      select: { id: true },
      take: 100,
    });

    await Promise.all(
      admins
        .filter((admin) => admin.id !== actorId)
        .map((admin) =>
          this.notifications!.create(admin.id, NotificationType.ADMIN_ACTION, {
            actorId,
            payload: {
              targetType,
              targetId,
              action: 'REPUBLISH_REQUEST',
              reason: reason?.trim() || null,
              message: `A brand requested republish approval for "${title}".${reason?.trim() ? ` Reason: ${reason.trim()}` : ''}`,
            },
          }).catch(() => undefined),
        ),
    );
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
    await this.assertOwner(collectionId, ownerId, 'STORE');
    const links = await this.prisma.storeCollectionProduct.findMany({
      where: { collectionId },
      select: { productId: true },
    });
    const productIds = links.map((l) => l.productId);
    if (productIds.length === 0) return { success: true };

    const data: Prisma.ProductUpdateInput = {};
    const nextTags = Array.isArray(template.tags)
      ? sanitizeTags(template.tags)
      : undefined;
    const previousProducts =
      nextTags && (this.systemTags || this.tagIndex)
        ? await this.prisma.product.findMany({
          where: { id: { in: productIds } },
          select: {
            id: true,
            tags: true,
            isActive: true,
            publishAt: true,
            deletedAt: true,
            archivedAt: true,
          },
        })
        : [];
    if (typeof template.description === 'string') {
      data.description = template.description;
    }
    if (Array.isArray(template.tags)) {
      data.tags = nextTags ?? [];
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

    if (this.systemTags && nextTags !== undefined) {
      for (const p of previousProducts) {
        const previousIndexedTags = this.getIndexedProductTags(p, p.tags ?? []);
        const nextIndexedTags = this.getIndexedProductTags(p, nextTags);
        if (!this.areTagsEqual(previousIndexedTags, nextIndexedTags)) {
          await this.systemTags.syncTags(previousIndexedTags, nextIndexedTags);
        }
      }
    }
    if (this.tagIndex && nextTags !== undefined) {
      for (const p of previousProducts) {
        const previousIndexedTags = this.getIndexedProductTags(p, p.tags ?? []);
        const nextIndexedTags = this.getIndexedProductTags(p, nextTags);
        if (!this.areTagsEqual(previousIndexedTags, nextIndexedTags)) {
          await this.tagIndex.syncEntityTags(
            TAG_ENTITY_TYPE.PRODUCT,
            p.id,
            previousIndexedTags,
            nextIndexedTags,
            { maxCount: 30 },
          );
        }
      }
    }

    await this.recalculateCollectionPriceRange(collectionId);

    return { success: true };
  }

  async createProductInCollection(
    collectionId: string,
    ownerId: string,
    dto: CreateProductDto,
  ) {
    await this.assertOwner(collectionId, ownerId, 'STORE');
    const created = await this.storeService.createProduct(ownerId, {
      ...dto,
      collectionId,
    });
    await (this.prisma.storeCollection as any).updateMany({
      where: { id: collectionId, status: 'DRAFT', deletedAt: null },
      data: { lastActivityAt: new Date(), draftVersion: { increment: 1 } },
    });
    await this.syncStoreCollectionFiltersFromProducts(collectionId);
    return created;
  }

  /**
   * Enhanced get method with proper includes
   */
  async getCollection(
    id: string,
    requesterId?: string,
    scope?: CollectionScope,
  ) {
    const resolvedScope = scope ? this.normalizeCollectionScope(scope) : 'all';
    const expectedDomain = this.scopeToDomain(resolvedScope);
    if (expectedDomain === 'STORE') {
      return this.getStoreCollection(id, requesterId);
    }

    // When scope='all', try design collection first; if not found, fall back to store collection
    if (!expectedDomain) {
      const designViewable = await this.canViewCollection(id, requesterId);
      if (!designViewable) {
        // Not found in designs table — try store collections
        try {
          return await this.getStoreCollection(id, requesterId);
        } catch {
          // Store collection also not found — throw the original design not-found
          throw new NotFoundException('Collection not found');
        }
      }
    } else {
      const ok = await this.canViewCollection(id, requesterId);
      if (!ok) throw new NotFoundException('Collection not found');
    }
    const collection = (await this.prisma.collection.findUnique({
      where: { id },
      include: {
        owner: {
          select: this.selectCollectionOwnerDisplay(),
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
              select: this.selectCollectionOwnerDisplay(),
            },
          },
        },
        _count: {
          select: {
            reactions: true,
            comments: true,
            collectionCollabs: true,
            views: true,
            medias: true,
          },
        },
      },
    } as any)) as any;
    if (expectedDomain && collection?.domain !== expectedDomain) {
      throw new NotFoundException('Collection not found');
    }

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
      _sum: { threadsCount: true },
    });

    const appliedFilters = this.categoriesService
      ? await this.categoriesService.getEntityFilters('COLLECTION', id)
      : [];
    const filterValueIds = Array.from(
      new Set(appliedFilters.map((filter) => filter.valueId)),
    );
    const totalThreads = collection.threadsCount + (mediaAgg._sum.threadsCount ?? 0);

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
    const primaryProductLink = (products || [])[0] ?? null;
    const primaryProduct = primaryProductLink?.product;
    const primaryProductImages = Array.isArray(primaryProduct?.images)
      ? primaryProduct.images
      : [];
    const firstProductWithCover = (products || []).find((link: any) => {
      const p = link?.product;
      const images = Array.isArray(p?.images) ? p.images : [];
      return Boolean(p?.thumbnail) || images.length > 0;
    });
    const productCoverUrl =
      primaryProduct?.thumbnail ??
      (primaryProductImages.length > 0 ? primaryProductImages[0] : null) ??
      firstProductWithCover?.product?.thumbnail ??
      (Array.isArray(firstProductWithCover?.product?.images)
        ? firstProductWithCover.product.images[0]
        : null);

    const { threadsCount, collectionCollabsCount, medias, ...rest } = collection as any;
    const mappedMedias = Array.isArray(medias)
      ? medias.map((m: any) => {
        const { threadsCount: mediaThreadsCount, ...mediaRest } = m;
        return { ...mediaRest, threadsCount: mediaThreadsCount };
      })
      : medias;
    return {
      ...rest,
      owner: this.mapCollectionOwner(rest.owner),
      reactions: Array.isArray(rest.reactions)
        ? rest.reactions.map((reaction: any) => ({
            ...reaction,
            user: this.mapCollectionOwner(reaction.user),
          }))
        : rest.reactions,
      medias: mappedMedias,
      filters: appliedFilters,
      filterValueIds,
      threadsCount: threadsCount,
      collectionCollabCount: collectionCollabsCount,
      products,
      totalThreads,
      coverImageUrl: coverFromMedia || productCoverUrl,
    };
  }

  private async canViewStoreCollection(
    collectionId: string,
    requesterId?: string,
  ): Promise<boolean> {
    const c = await this.prisma.storeCollection.findUnique({
      where: { id: collectionId },
      select: { ownerId: true, status: true, visibility: true, deletedAt: true },
    });
    if (!c) return false;
    if (c.deletedAt) return false;
    if (requesterId && requesterId === c.ownerId) return true;
    if (c.status !== 'PUBLISHED') return false;
    return c.visibility === CollectionVisibility.PUBLIC;
  }

  private async getStoreCollection(id: string, requesterId?: string) {
    const ok = await this.canViewStoreCollection(id, requesterId);
    if (!ok) throw new NotFoundException('Collection not found');

    const collection = await this.prisma.storeCollection.findUnique({
      where: { id },
      include: {
        owner: {
          select: this.selectCollectionOwnerDisplay(),
        },
        products: {
          include: {
            product: {
              include: { variants: { select: { id: true } } },
            },
          },
          orderBy: { orderIndex: 'asc' },
        },
      },
    });
    if (!collection) throw new NotFoundException('Collection not found');

    const isOwner = !!(requesterId && collection.ownerId === requesterId);
    const now = new Date();
    const allowInactiveDraftProducts = isOwner && collection.status === 'DRAFT';
    const products = (collection.products || []).filter((link: any) => {
      const p = link?.product;
      if (!p) return false;
      if (p.deletedAt || p.archivedAt) return false;
      if (!allowInactiveDraftProducts && !p.isActive) return false;
      if (!isOwner && p.publishAt && p.publishAt > now) return false;
      return true;
    }) as any[];

    const primaryProductLink = (products || [])[0] ?? null;
    const primaryProduct = primaryProductLink?.product;
    const primaryProductImages = Array.isArray(primaryProduct?.images)
      ? primaryProduct.images
      : [];
    const firstProductWithCover = (products || []).find((link: any) => {
      const p = link?.product;
      const images = Array.isArray(p?.images) ? p.images : [];
      return Boolean(p?.thumbnail) || images.length > 0;
    });
    const productCoverUrl =
      primaryProduct?.thumbnail ??
      (primaryProductImages.length > 0 ? primaryProductImages[0] : null) ??
      firstProductWithCover?.product?.thumbnail ??
      (Array.isArray(firstProductWithCover?.product?.images)
        ? firstProductWithCover.product.images[0]
        : null);

    const appliedFilters = this.categoriesService
      ? await this.categoriesService.getEntityFilters('STORE_COLLECTION', id)
      : [];
    const filterValueIds = Array.from(
      new Set(appliedFilters.map((filter) => filter.valueId)),
    );
    const filterSelection = appliedFilters.reduce((acc, filter) => {
      const current = acc[filter.dimensionId] ?? [];
      if (!current.includes(filter.valueId)) {
        acc[filter.dimensionId] = [...current, filter.valueId];
      }
      return acc;
    }, {} as Record<string, string[]>);

    return {
      ...collection,
      owner: this.mapCollectionOwner(collection.owner),
      domain: 'STORE' as const,
      isAvailableInStore: true,
      medias: [],
      coverMediaId: null,
      collectionCollabCount: collection.collectionCollabsCount,
      totalThreads: collection.threadsCount,
      filters: appliedFilters,
      filterValueIds,
      filterSelection,
      products,
      coverImageUrl: productCoverUrl,
    };
  }

  /**
   * PHASE 6: Get draft collections for current user
   */
  async getMyDraftCollections(userId: string) {
    const publishedTitleRows = await this.prisma.collection.findMany({
      where: {
        ownerId: userId,
        status: 'PUBLISHED',
        deletedAt: null,
      },
      select: { title: true },
    });
    const publishedTitles = publishedTitleRows
      .map((item) => item.title?.trim())
      .filter((title): title is string => Boolean(title));

    const items = await this.prisma.collection.findMany({
      where: {
        ownerId: userId,
        status: 'DRAFT',
        deletedAt: null,
        ...(publishedTitles.length > 0
          ? { title: { notIn: publishedTitles } }
          : {}),
      },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        title: true,
        description: true,
        pendingCategoryName: true,
        draftReason: true,
        createdAt: true,
        coverMediaId: true,
        medias: {
          include: { file: true },
          orderBy: { orderIndex: 'asc' },
        },
        _count: {
          select: { medias: true },
        },
      },
    });

    // Generate signed URLs for cover images
    const fileIds = items
      .map((c) =>
        this.resolveCoverMedia(c.medias, c.coverMediaId ?? null)?.fileUploadId,
      )
      .filter((id): id is string => !!id);

    const signedUrlMap =
      await this.uploadService.getBatchPublicSignedUrls(fileIds);

    return {
      items: items.map((c) => {
        const cover = this.resolveCoverMedia(c.medias, c.coverMediaId ?? null);
        const coverImage = cover?.fileUploadId
          ? (signedUrlMap.get(cover.fileUploadId) ?? null)
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
      scope?: CollectionScope;
      includeDeleted?: boolean;
      onlyDeleted?: boolean;
    },
  ) {
    const {
      cursor,
      limit = 20,
      visibility,
      scope = this.defaultCollectionScope,
      includeDeleted = false,
      onlyDeleted = false,
    } = options || {};
    const resolvedScope = this.normalizeCollectionScope(scope);
    if (resolvedScope === 'store') {
      return this.getUserStoreCollections(userId, requesterId, {
        cursor,
        limit,
        visibility,
        includeDeleted,
        onlyDeleted,
      });
    }
    const domainFilter = this.scopeToDomain(resolvedScope);
    const privateFeature =
      (process.env.FEATURE_PRIVATE_COLLECTIONS ?? 'true') !== 'false';
    const canAccessDeleted = requesterId === userId;
    const shouldIncludeDeleted = canAccessDeleted && includeDeleted;
    const shouldOnlyDeleted = canAccessDeleted && onlyDeleted;
    const where: any = { ownerId: userId };
    if (shouldOnlyDeleted) {
      where.deletedAt = { not: null };
    } else if (!shouldIncludeDeleted) {
      where.deletedAt = null;
    }
    if (domainFilter) {
      where.domain = domainFilter;
    }
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
        '[collections.service.getUserCollections] userId=%s requesterId=%s visibility=%s scope=%s featurePrivate=%s',
        userId,
        requesterId ?? 'anon',
        visibility ?? 'public',
        resolvedScope,
        privateFeature,
      );
    } catch { }

    // Default: published only for non-owner
    if (requesterId !== userId) {
      where.deletedAt = null;
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
      if (!shouldOnlyDeleted) {
        where.status = 'PUBLISHED';
      }

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
        domain: true,
        title: true,
        description: true,
        status: true,
        visibility: true,
        type: true,
        categoryId: true,
        categoryTypeId: true,
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
        deletedAt: true,
        deleteExpiresAt: true,
        createdAt: true,
        updatedAt: true,
        threadsCount: true,
        dislikesCount: true,
        commentsCount: true,
        collectionCollabsCount: true,
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
          orderBy: [
            { isPrimary: 'desc' },
            { orderIndex: 'asc' },
          ],
          include: {
            product: {
              select: {
                id: true,
                thumbnail: true,
                images: true,
                isActive: true,
                archivedAt: true,
                deletedAt: true,
                publishAt: true,
              },
            },
          },
          take: this.maxProductsPerCollection,
        },
        _count: {
          select: {
            reactions: true,
            comments: true,
            collectionCollabs: true,
            views: true,
            medias: true,
          },
        },
        owner: {
          select: this.selectCollectionOwnerDisplay(),
        },
      },
    });
    try {
      console.log(
        '[collections.service.getUserCollections] rows=%d where=%j',
        items.length,
        where,
      );
    } catch { }

    const hasNext = items.length > limit;
    const data = hasNext ? items.slice(0, -1) : items;

    // Hydrate isThreaded for requester when available
    let isThreadedMap: Record<string, boolean> = {};
    if (requesterId) {
      const ids = data.map((c) => c.id);
      if (ids.length) {
        const threaded = await this.prisma.collectionReaction.findMany({
          where: {
            userId: requesterId,
            type: ReactionType.THREAD,
            collectionId: { in: ids },
          },
          select: { collectionId: true },
        });
        const set = new Set(threaded.map((r) => r.collectionId));
        isThreadedMap = ids.reduce(
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
      const owner = this.mapCollectionOwner(c.owner);
      if (owner?.profileImageFile?.id) {
        fileIds.add(owner.profileImageFile.id);
      } else if (owner?.profileImageId) {
        fileIds.add(owner.profileImageId);
      }
    });

    const signedUrlMap = await this.uploadService.getBatchPublicSignedUrls(
      Array.from(fileIds),
    );

    return {
      items: data.map((c) => {
        const { collectionCollabsCount, threadsCount, ...rest } = c as any;
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

        const owner = this.mapCollectionOwner(c.owner);
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
          ...rest,
          collectionCollabCount: collectionCollabsCount,
          threadsCount: threadsCount,
          medias: mappedMedias,
          owner: ownerWithSignedUrl,
          isThreaded: requesterId ? !!isThreadedMap[c.id] : false,
        };
      }),
      hasNextPage: hasNext,
      endCursor: data.length ? data[data.length - 1].id : null,
    };
  }

  private async getUserStoreCollections(
    userId: string,
    requesterId?: string,
    options?: {
      cursor?: string;
      limit?: number;
      visibility?: 'public' | 'private' | 'all';
      includeDeleted?: boolean;
      onlyDeleted?: boolean;
    },
  ) {
    const {
      cursor,
      limit = 20,
      visibility,
      includeDeleted = false,
      onlyDeleted = false,
    } = options || {};
    const canAccessDeleted = requesterId === userId;
    const shouldIncludeDeleted = canAccessDeleted && includeDeleted;
    const shouldOnlyDeleted = canAccessDeleted && onlyDeleted;
    const where: any = {
      ownerId: userId,
      isSystemGenerated: false,
    };
    if (shouldOnlyDeleted) {
      where.deletedAt = { not: null };
    } else if (!shouldIncludeDeleted) {
      where.deletedAt = null;
    }

    if (requesterId !== userId) {
      where.status = 'PUBLISHED';
      if (!visibility || visibility === 'public') {
        where.visibility = CollectionVisibility.PUBLIC;
      } else if (visibility === 'private') {
        where.visibility = CollectionVisibility.PRIVATE;
      }
    } else if (visibility === 'public') {
      where.visibility = CollectionVisibility.PUBLIC;
    } else if (visibility === 'private') {
      where.visibility = CollectionVisibility.PRIVATE;
    }

    const items = await this.prisma.storeCollection.findMany({
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
        categoryTypeId: true,
        isSystemGenerated: true,
        minPrice: true,
        maxPrice: true,
        tags: true,
        saleMinPrice: true,
        saleMaxPrice: true,
        saleStartAt: true,
        saleEndAt: true,
        deletedAt: true,
        deleteExpiresAt: true,
        createdAt: true,
        updatedAt: true,
        threadsCount: true,
        dislikesCount: true,
        commentsCount: true,
        collectionCollabsCount: true,
        viewsCount: true,
        _count: {
          select: {
            products: true,
          },
        },
        products: {
          orderBy: [{ orderIndex: 'asc' }],
          include: {
            product: {
              select: {
                id: true,
                thumbnail: true,
                images: true,
                isActive: true,
                archivedAt: true,
                deletedAt: true,
                publishAt: true,
              },
            },
          },
          take: this.maxProductsPerCollection,
        },
        owner: {
          select: this.selectCollectionOwnerDisplay(),
        },
      },
    });

    const hasNext = items.length > limit;
    const data = hasNext ? items.slice(0, -1) : items;
    const now = new Date();
    const isOwnerRequester = requesterId === userId;

    const isRemoteMediaValue = (value: unknown): value is string => {
      if (typeof value !== 'string') return false;
      const normalized = value.trim();
      if (!normalized) return false;
      return (
        normalized.startsWith('http') ||
        normalized.startsWith('/') ||
        normalized.startsWith('data:') ||
        normalized.includes('://') ||
        normalized.includes('?')
      );
    };

    const collectionPreviewById = new Map<
      string,
      {
        coverUrl: string | null;
        coverFileId: string | null;
        preview: Array<{ url: string | null; fileId: string | null }>;
        visibleCount: number;
        visibleLinks: any[];
      }
    >();

    const fileIds = new Set<string>();
    data.forEach((c: any) => {
      const owner = this.mapCollectionOwner(c.owner);
      if (owner?.profileImageFile?.id) {
        fileIds.add(owner.profileImageFile.id);
      } else if (owner?.profileImageId) {
        fileIds.add(owner.profileImageId);
      }

      const links = Array.isArray(c.products) ? c.products : [];
      const visibleLinks = links.filter((link: any) => {
        const product = link?.product;
        if (!product) return false;
        if (product.deletedAt || product.archivedAt || !product.isActive) {
          return false;
        }
        if (!isOwnerRequester && product.publishAt && product.publishAt > now) {
          return false;
        }
        return true;
      });
      const rawCandidates = Array.from(
        new Set(
          visibleLinks
            .flatMap((link: any) => {
              const product = link?.product;
              if (!product) return [];
              const thumbnail =
                typeof product.thumbnail === 'string'
                  ? product.thumbnail.trim()
                  : '';
              const images = Array.isArray(product.images)
                ? product.images
                    .map((image: unknown) =>
                      typeof image === 'string' ? image.trim() : '',
                    )
                    .filter(Boolean)
                : [];
              return thumbnail ? [thumbnail, ...images] : images;
            })
            .filter((value: string) => value.length > 0),
        ),
      ) as string[];

      rawCandidates.forEach((candidate: string) => {
        if (!isRemoteMediaValue(candidate) && isUuid(candidate)) {
          fileIds.add(candidate);
        }
      });

      const firstCandidate = (rawCandidates[0] as string | undefined) ?? null;
      let coverUrl: string | null = null;
      let coverFileId: string | null = null;
      if (firstCandidate) {
        if (isRemoteMediaValue(firstCandidate)) {
          coverUrl = firstCandidate;
        } else if (isUuid(firstCandidate)) {
          coverFileId = firstCandidate;
        }
      }

      const preview = rawCandidates
        .slice(0, 8)
        .map((candidate) => {
          if (isRemoteMediaValue(candidate)) {
            return { url: candidate, fileId: null };
          }
          if (isUuid(candidate)) {
            return { url: null, fileId: candidate };
          }
          return null;
        })
        .filter(
          (
            item,
          ): item is { url: string | null; fileId: string | null } =>
            Boolean(item),
        );

      collectionPreviewById.set(c.id, {
        coverUrl,
        coverFileId,
        preview,
        visibleCount: visibleLinks.length,
        visibleLinks,
      });
    });
    const signedUrlMap = await this.uploadService.getBatchPublicSignedUrls(
      Array.from(fileIds),
    );

    return {
      items: data.map((c: any) => {
        const logoOwner = this.mapCollectionOwner(c.owner);
        const logoId = logoOwner?.profileImageFile?.id || logoOwner?.profileImageId;
        const previewMeta = collectionPreviewById.get(c.id);
        const visibleCount = previewMeta?.visibleCount ?? 0;
        const coverFromFileId =
          previewMeta?.coverFileId && signedUrlMap.has(previewMeta.coverFileId)
            ? signedUrlMap.get(previewMeta.coverFileId) ?? null
            : null;
        const coverImage = previewMeta?.coverUrl ?? coverFromFileId ?? null;
        const previewImages = (previewMeta?.preview ?? [])
          .map((item) => {
            if (item.url) {
              return { url: item.url, fileId: null };
            }
            if (item.fileId && signedUrlMap.has(item.fileId)) {
              return {
                url: signedUrlMap.get(item.fileId) ?? null,
                fileId: item.fileId,
              };
            }
            if (item.fileId) {
              return { url: null, fileId: item.fileId };
            }
            return null;
          })
          .filter(
            (item): item is { url: string | null; fileId: string | null } =>
              Boolean(item && (item.url || item.fileId)),
          );
        let owner = logoOwner;
        if (logoId && signedUrlMap.has(logoId)) {
          owner = {
            ...owner,
            profileImage: signedUrlMap.get(logoId)!,
            profileImageFile: owner.profileImageFile
              ? { ...owner.profileImageFile, s3Url: signedUrlMap.get(logoId)! }
              : null,
          };
        }
        return {
          ...c,
          domain: 'STORE',
          isAvailableInStore: true,
          deletedAt: c.deletedAt ?? null,
          deleteExpiresAt: c.deleteExpiresAt ?? null,
          medias: [],
          coverMediaId: null,
          coverImage,
          coverFileId: previewMeta?.coverFileId ?? null,
          previewImages,
          products: previewMeta?.visibleLinks ?? [],
          itemCount: visibleCount,
          collectionCollabCount: c.collectionCollabsCount,
          owner,
        };
      }),
      hasNextPage: hasNext,
      endCursor: data.length ? data[data.length - 1].id : null,
    };
  }

  /**
   * Delete entire collection and all its media (S3 + DB)
   */
  async deleteCollection(
    collectionId: string,
    requesterId: string,
    scope?: CollectionScope,
  ) {
    const resolvedScope = this.normalizeCollectionScope(scope);
    const expectedDomain = this.scopeToDomain(resolvedScope);
    if (expectedDomain === 'STORE') {
      await this.assertOwner(
        collectionId,
        requesterId,
        'STORE',
        BRAND_PERMISSIONS.CATALOG_DELETE,
      );
      const collection = await this.prisma.storeCollection.findUnique({
        where: { id: collectionId },
      });
      if (!collection) throw new NotFoundException('Collection not found');
      if (collection.deletedAt) {
        return { success: true, deletedAt: collection.deletedAt };
      }

      const previousIndexedTags = this.getIndexedCollectionTags(
        {
          status: collection.status,
          visibility: collection.visibility,
          deletedAt: collection.deletedAt,
          tags: collection.tags ?? [],
        },
        collection.tags ?? [],
      );

      const now = new Date();
      const deleteExpiresAt = new Date(
        now.getTime() + this.collectionDeleteWindowMs,
      );
      await this.prisma.storeCollection.update({
        where: { id: collectionId },
        data: { deletedAt: now, deleteExpiresAt },
      });

      const productLinks = await this.prisma.storeCollectionProduct.findMany({
        where: { collectionId },
        select: { productId: true },
      });
      const productIds = productLinks.map((l) => l.productId);
      if (productIds.length) {
        await this.prisma.cartItem.deleteMany({ where: { productId: { in: productIds } } });
      }

      if (previousIndexedTags.length > 0 && this.systemTags) {
        await this.systemTags.syncTags(previousIndexedTags, []);
      }
      if (previousIndexedTags.length > 0 && this.tagIndex) {
        await this.tagIndex.syncEntityTags(
          TAG_ENTITY_TYPE.COLLECTION,
          collectionId,
          previousIndexedTags,
          [],
          { maxCount: 30 },
        );
      }

      return {
        success: true,
        deletedAt: now.toISOString(),
        restoreBy: deleteExpiresAt.toISOString(),
      };
    }

    // Verify collection and ownership
    const collection = (await this.prisma.collection.findUnique({
      where: { id: collectionId },
      include: { medias: { include: { file: true } } },
    } as any)) as any;
    if (!collection) throw new NotFoundException('Collection not found');
    await this.assertActorCanManageLegacyOwnerCatalog(
      requesterId,
      collection.ownerId,
      BRAND_PERMISSIONS.CATALOG_DELETE,
    );
    if (expectedDomain && collection.domain !== expectedDomain) {
      throw new BadRequestException(
        'Delete requested with design scope for a store collection.',
      );
    }

    if (collection.deletedAt) {
      return { success: true, deletedAt: collection.deletedAt };
    }

    const previousIndexedTags = this.getIndexedCollectionTags(
      {
        status: collection.status,
        visibility: collection.visibility,
        deletedAt: collection.deletedAt,
        tags: collection.tags ?? [],
      },
      collection.tags ?? [],
    );

    const now = new Date();
    const deleteExpiresAt = new Date(now.getTime() + this.collectionDeleteWindowMs);

    await this.prisma.collection.update({
      where: { id: collectionId },
      data: {
        deletedAt: now,
        deleteExpiresAt,
      },
    });

    const productLinks = await this.prisma.storeCollectionProduct.findMany({
      where: { collectionId },
      select: { productId: true },
    });
    const productIds = productLinks.map((l) => l.productId);
    if (productIds.length) {
      await this.prisma.cartItem.deleteMany({ where: { productId: { in: productIds } } });
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

    if (previousIndexedTags.length > 0 && this.systemTags) {
      await this.systemTags.syncTags(previousIndexedTags, []);
    }
    if (previousIndexedTags.length > 0 && this.tagIndex) {
      await this.tagIndex.syncEntityTags(
        TAG_ENTITY_TYPE.COLLECTION,
        collectionId,
        previousIndexedTags,
        [],
        { maxCount: 30 },
      );
    }

    return { success: true, deletedAt: now.toISOString(), restoreBy: deleteExpiresAt.toISOString() };
  }

  async duplicateCollection(
    collectionId: string,
    requesterId: string,
    scope?: CollectionScope,
  ) {
    const resolvedScope = this.normalizeCollectionScope(scope);
    const expectedDomain = this.scopeToDomain(resolvedScope);
    if (expectedDomain === 'STORE') {
      const source = await this.prisma.storeCollection.findUnique({
        where: { id: collectionId },
      });
      if (!source) throw new NotFoundException('Collection not found');
      await this.assertActorCanManageLegacyOwnerCatalog(
        requesterId,
        source.ownerId,
      );
      if (source.deletedAt) {
        throw new GoneException('Collection has been deleted');
      }

      const sourceLinks = await this.prisma.storeCollectionProduct.findMany({
        where: { collectionId },
        orderBy: [{ orderIndex: 'asc' }, { createdAt: 'asc' }],
        select: { productId: true, orderIndex: true },
      });

      const maxMembershipConflicts: string[] = [];
      for (const link of sourceLinks) {
        const membershipCount = await this.prisma.storeCollectionProduct.count({
          where: { productId: link.productId },
        });
        if (membershipCount >= 3) {
          maxMembershipConflicts.push(link.productId);
        }
      }
      if (maxMembershipConflicts.length > 0) {
        throw new ConflictException({
          code: 'COLLECTION_MAX_MEMBERSHIP',
          message: 'One or more products already belong to maximum 3 collections.',
          productIds: maxMembershipConflicts,
        } as any);
      }

      const baseTitle = String(source.title || 'Untitled collection').trim();
      const copiedTags = Array.isArray(source.tags)
        ? sanitizeTags(source.tags, 30)
        : [];
      const duplicateId = uuidv4();
      const now = new Date();
      const duplicateTitle = baseTitle
        ? `Copy of ${baseTitle}`
        : 'Copy of collection';

      await this.prisma.$transaction(async (tx) => {
        await tx.storeCollection.create({
          data: {
            id: duplicateId,
            ownerId: source.ownerId,
            title: duplicateTitle,
            description: source.description ?? null,
            status: 'DRAFT',
            visibility: source.visibility,
            type: source.type,
            categoryId: source.categoryId ?? null,
            categoryTypeId: source.categoryTypeId ?? null,
            tags: copiedTags,
            minPrice: source.minPrice ?? null,
            maxPrice: source.maxPrice ?? null,
            saleMinPrice: source.saleMinPrice ?? null,
            saleMaxPrice: source.saleMaxPrice ?? null,
            saleStartAt: source.saleStartAt ?? null,
            saleEndAt: source.saleEndAt ?? null,
            lastActivityAt: now,
            draftVersion: 0,
          },
        });

        if (sourceLinks.length > 0) {
          await tx.storeCollectionProduct.createMany({
            data: sourceLinks.map((link, index) => ({
              id: uuidv4(),
              collectionId: duplicateId,
              productId: link.productId,
              orderIndex:
                typeof link.orderIndex === 'number' ? link.orderIndex : index,
              isPrimary: false,
            })),
            skipDuplicates: true,
          });
        }
      });

      await this.recalculateCollectionPriceRange(duplicateId);

      const indexedTags = this.getIndexedCollectionTags(
        {
          status: 'DRAFT',
          visibility: source.visibility,
          deletedAt: null,
          tags: copiedTags,
        },
        copiedTags,
      );
      if (indexedTags.length > 0 && this.systemTags) {
        await this.systemTags.syncTags([], indexedTags);
      }
      if (indexedTags.length > 0 && this.tagIndex) {
        await this.tagIndex.syncEntityTags(
          TAG_ENTITY_TYPE.COLLECTION,
          duplicateId,
          [],
          indexedTags,
          { maxCount: 30 },
        );
      }

      const duplicated = await this.prisma.storeCollection.findUnique({
        where: { id: duplicateId },
        include: {
          owner: {
            select: this.selectCollectionOwnerDisplay(),
          },
          products: {
            include: { product: true },
            orderBy: { orderIndex: 'asc' },
          },
        },
      });
      if (!duplicated) throw new NotFoundException('Collection not found');
      return { ...duplicated, owner: this.mapCollectionOwner(duplicated.owner) };
    }

    const source = (await this.prisma.collection.findUnique({
      where: { id: collectionId },
      select: {
        id: true,
        ownerId: true,
        domain: true,
        title: true,
        description: true,
        status: true,
        visibility: true,
        type: true,
        categoryId: true,
        categoryTypeId: true,
        isAvailableInStore: true,
        tags: true,
        minPrice: true,
        maxPrice: true,
        saleMinPrice: true,
        saleMaxPrice: true,
        saleStartAt: true,
        saleEndAt: true,
        deletedAt: true,
      } as any,
    } as any)) as any;

    if (!source) throw new NotFoundException('Collection not found');
    await this.assertActorCanManageLegacyOwnerCatalog(requesterId, source.ownerId);
    if (expectedDomain && source.domain !== expectedDomain) {
      throw new BadRequestException(
        'Duplicate requested with design scope for a store collection.',
      );
    }
    if (source.deletedAt) {
      throw new GoneException('Collection has been deleted');
    }

    const sourceLinks = await this.prisma.storeCollectionProduct.findMany({
      where: { collectionId },
      orderBy: [{ orderIndex: 'asc' }, { createdAt: 'asc' }],
      select: { productId: true, orderIndex: true },
    });

    const maxMembershipConflicts: string[] = [];
    for (const link of sourceLinks) {
      const membershipCount = await this.prisma.storeCollectionProduct.count({
        where: { productId: link.productId },
      });
      if (membershipCount >= 3) {
        maxMembershipConflicts.push(link.productId);
      }
    }
    if (maxMembershipConflicts.length > 0) {
      throw new ConflictException({
        code: 'COLLECTION_MAX_MEMBERSHIP',
        message: 'One or more products already belong to maximum 3 collections.',
        productIds: maxMembershipConflicts,
      } as any);
    }

    const baseTitle = String(source.title || 'Untitled collection').trim();
    const copiedTags = Array.isArray(source.tags) ? sanitizeTags(source.tags, 30) : [];
    const duplicateId = uuidv4();
    const now = new Date();
    const duplicateTitle = baseTitle ? `Copy of ${baseTitle}` : 'Copy of collection';
    const duplicateDomain: CollectionDomainValue =
      source.domain === 'STORE' || source.isAvailableInStore ? 'STORE' : 'DESIGN';

    await this.prisma.$transaction(async (tx) => {
      await tx.collection.create({
        data: {
          id: duplicateId,
          ownerId: source.ownerId,
          domain: duplicateDomain,
          title: duplicateTitle,
          description: source.description ?? null,
          status: 'DRAFT',
          visibility: source.visibility,
          type: source.type,
          categoryId: source.categoryId ?? null,
          categoryTypeId: source.categoryTypeId ?? null,
          isAvailableInStore: duplicateDomain === 'STORE',
          tags: copiedTags,
          minPrice: source.minPrice ?? null,
          maxPrice: source.maxPrice ?? null,
          saleMinPrice: source.saleMinPrice ?? null,
          saleMaxPrice: source.saleMaxPrice ?? null,
          saleStartAt: source.saleStartAt ?? null,
          saleEndAt: source.saleEndAt ?? null,
          lastActivityAt: now,
          draftVersion: 0,
        } as any,
      });

      if (sourceLinks.length > 0) {
        await tx.storeCollectionProduct.createMany({
          data: sourceLinks.map((link, index) => ({
            id: uuidv4(),
            collectionId: duplicateId,
            productId: link.productId,
            orderIndex: typeof link.orderIndex === 'number' ? link.orderIndex : index,
            isPrimary: false,
          })),
          skipDuplicates: true,
        });
      }
    });

    await this.recalculateCollectionPriceRange(duplicateId);

    const indexedTags = this.getIndexedCollectionTags(
      {
        status: 'DRAFT',
        visibility: source.visibility,
        deletedAt: null,
        tags: copiedTags,
      },
      copiedTags,
    );
    if (indexedTags.length > 0 && this.systemTags) {
      await this.systemTags.syncTags([], indexedTags);
    }
    if (indexedTags.length > 0 && this.tagIndex) {
      await this.tagIndex.syncEntityTags(
        TAG_ENTITY_TYPE.COLLECTION,
        duplicateId,
        [],
        indexedTags,
        { maxCount: 30 },
      );
    }

    const duplicated = await this.prisma.collection.findUnique({
      where: { id: duplicateId },
      include: {
        owner: {
          select: this.selectCollectionOwnerDisplay(),
        },
        _count: { select: { medias: true, views: true, comments: true } },
      },
    });

    if (!duplicated) throw new NotFoundException('Collection not found');
    return { ...duplicated, owner: this.mapCollectionOwner(duplicated.owner) };
  }

  async restoreCollection(collectionId: string, ownerId: string) {
    const storeCollection = await this.prisma.storeCollection.findUnique({
      where: { id: collectionId },
      select: {
        ownerId: true,
        deletedAt: true,
        deleteExpiresAt: true,
        status: true,
        visibility: true,
        tags: true,
      },
    });
    if (storeCollection) {
      await this.assertActorCanManageLegacyOwnerCatalog(
        ownerId,
        storeCollection.ownerId,
        BRAND_PERMISSIONS.CATALOG_DELETE,
      );
      if (!storeCollection.deletedAt) {
        throw new BadRequestException('Collection is not deleted');
      }
      const now = new Date();
      if (storeCollection.deleteExpiresAt && storeCollection.deleteExpiresAt < now) {
        throw new GoneException('Collection recovery window has expired');
      }

      await this.prisma.storeCollection.update({
        where: { id: collectionId },
        data: { deletedAt: null, deleteExpiresAt: null },
      });

      const previousIndexedTags = this.getIndexedCollectionTags(
        {
          status: storeCollection.status,
          visibility: storeCollection.visibility,
          deletedAt: storeCollection.deletedAt,
          tags: storeCollection.tags ?? [],
        },
        storeCollection.tags ?? [],
      );
      const nextIndexedTags = this.getIndexedCollectionTags(
        {
          status: storeCollection.status,
          visibility: storeCollection.visibility,
          deletedAt: null,
          tags: storeCollection.tags ?? [],
        },
        storeCollection.tags ?? [],
      );
      if (this.systemTags && !this.areTagsEqual(previousIndexedTags, nextIndexedTags)) {
        await this.systemTags.syncTags(previousIndexedTags, nextIndexedTags);
      }
      if (this.tagIndex && !this.areTagsEqual(previousIndexedTags, nextIndexedTags)) {
        await this.tagIndex.syncEntityTags(
          TAG_ENTITY_TYPE.COLLECTION,
          collectionId,
          previousIndexedTags,
          nextIndexedTags,
          { maxCount: 30 },
        );
      }

      return { success: true };
    }

    const collection = (await this.prisma.collection.findUnique({
      where: { id: collectionId },
      select: {
        ownerId: true,
        deletedAt: true,
        deleteExpiresAt: true,
        status: true,
        visibility: true,
        tags: true,
      } as any,
    } as any)) as any;
    if (!collection) throw new NotFoundException('Collection not found');
    await this.assertActorCanManageLegacyOwnerCatalog(
      ownerId,
      collection.ownerId,
      BRAND_PERMISSIONS.CATALOG_DELETE,
    );
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

    const previousIndexedTags = this.getIndexedCollectionTags(
      {
        status: collection.status,
        visibility: collection.visibility,
        deletedAt: collection.deletedAt,
        tags: collection.tags ?? [],
      },
      collection.tags ?? [],
    );
    const nextIndexedTags = this.getIndexedCollectionTags(
      {
        status: collection.status,
        visibility: collection.visibility,
        deletedAt: null,
        tags: collection.tags ?? [],
      },
      collection.tags ?? [],
    );
    if (this.systemTags && !this.areTagsEqual(previousIndexedTags, nextIndexedTags)) {
      await this.systemTags.syncTags(previousIndexedTags, nextIndexedTags);
    }
    if (this.tagIndex && !this.areTagsEqual(previousIndexedTags, nextIndexedTags)) {
      await this.tagIndex.syncEntityTags(
        TAG_ENTITY_TYPE.COLLECTION,
        collectionId,
        previousIndexedTags,
        nextIndexedTags,
        { maxCount: 30 },
      );
    }

    return { success: true };
  }

  async permanentlyDeleteCollection(
    collectionId: string,
    ownerId: string,
    scope?: CollectionScope,
  ) {
    const resolvedScope = this.normalizeCollectionScope(scope);
    const expectedDomain = this.scopeToDomain(resolvedScope);

    if (expectedDomain === 'STORE') {
      const storeCollection = await this.prisma.storeCollection.findUnique({
        where: { id: collectionId },
        select: { id: true, ownerId: true, deletedAt: true },
      });
      if (!storeCollection) throw new NotFoundException('Collection not found');
      await this.assertActorCanManageLegacyOwnerCatalog(
        ownerId,
        storeCollection.ownerId,
        BRAND_PERMISSIONS.CATALOG_DELETE,
      );
      if (!storeCollection.deletedAt) {
        throw new BadRequestException(
          'Collection must be deleted before permanent removal',
        );
      }

      await this.prisma.storeCollection.delete({ where: { id: collectionId } });
      return { success: true, permanentlyDeleted: true };
    }

    const collection = await this.prisma.collection.findUnique({
      where: { id: collectionId },
      include: { medias: { include: { file: true } } },
    });
    if (!collection) throw new NotFoundException('Collection not found');
    await this.assertActorCanManageLegacyOwnerCatalog(
      ownerId,
      collection.ownerId,
      BRAND_PERMISSIONS.CATALOG_DELETE,
    );
    if (expectedDomain && collection.domain !== expectedDomain) {
      throw new BadRequestException(
        'Permanent delete requested with design scope for a store collection.',
      );
    }
    if (!collection.deletedAt) {
      throw new BadRequestException(
        'Collection must be deleted before permanent removal',
      );
    }

    const fileIds = collection.medias
      .map((media) => media.file?.id)
      .filter((id): id is string => Boolean(id));
    const s3Keys = collection.medias
      .map((media) => media.file?.s3Key)
      .filter((key): key is string => Boolean(key));

    if (s3Keys.length > 0) {
      try {
        await this.uploadService.deleteS3ObjectsByKeys(s3Keys);
      } catch (error) {
        console.warn(
          `Failed to delete S3 objects while permanently deleting collection ${collectionId}:`,
          error,
        );
      }
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.collection.delete({ where: { id: collectionId } });
      if (fileIds.length > 0) {
        await tx.fileUpload.deleteMany({ where: { id: { in: fileIds } } });
      }
    });

    return { success: true, permanentlyDeleted: true };
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
    await this.assertActorCanManageLegacyOwnerCatalog(
      requesterId,
      collection.ownerId,
      BRAND_PERMISSIONS.CATALOG_DELETE,
    );

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

    const previousIndexedTags = this.getIndexedCollectionTags(
      {
        status: collection.status,
        visibility: collection.visibility,
        deletedAt: collection.deletedAt,
        tags: collection.tags ?? [],
      },
      collection.tags ?? [],
    );

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
        const productCount = await tx.storeCollectionProduct.count({
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
      this.prisma.storeCollectionProduct.count({ where: { collectionId } }),
      this.prisma.collection.findUnique({
        where: { id: collectionId },
        select: { deletedAt: true } as any,
      }),
    ]);
    const deletedCollection =
      !!deletedInfo?.deletedAt ||
      (remainingAfter === 0 && remainingProducts === 0);
    if (deletedCollection) {
      if (previousIndexedTags.length > 0 && this.systemTags) {
        await this.systemTags.syncTags(previousIndexedTags, []);
      }
      if (previousIndexedTags.length > 0 && this.tagIndex) {
        await this.tagIndex.syncEntityTags(
          TAG_ENTITY_TYPE.COLLECTION,
          collectionId,
          previousIndexedTags,
          [],
          { maxCount: 30 },
        );
      }
    }
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
        domain: 'DESIGN',
        status: 'PUBLISHED',
        visibility: CollectionVisibility.PUBLIC,
        deletedAt: null,
      } as any,
      orderBy: [
        { collectionCollabsCount: 'desc' }, // Show most collabed first
        { createdAt: 'desc' },
      ],
      take: limit + 1,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      include: {
        owner: {
          select: this.selectCollectionOwnerDisplay(),
        },
        medias: {
          select: {
            id: true,
            orderIndex: true,
            file: {
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
          orderBy: { orderIndex: 'asc' },
        },
        _count: {
          select: {
            reactions: true,
            comments: true,
            collectionCollabs: true,
            views: true,
            medias: true,
          },
        },
      },
    });

    const hasNext = items.length > limit;
    const data = hasNext ? items.slice(0, -1) : items;

    // Hydrate isThreaded for requester when available
    let isThreadedMap: Record<string, boolean> = {};
    if (requesterId) {
      const ids = data.map((c) => c.id);
      if (ids.length) {
        const threaded = await this.prisma.collectionReaction.findMany({
          where: {
            userId: requesterId,
            type: ReactionType.THREAD,
            collectionId: { in: ids },
          },
          select: { collectionId: true },
        });
        const set = new Set(threaded.map((r) => r.collectionId));
        isThreadedMap = ids.reduce(
          (acc, id) => {
            acc[id] = set.has(id);
            return acc;
          },
          {} as Record<string, boolean>,
        );
      }
    }

    return {
      items: data.map((c) => {
        const coverMedias = this.toCoverOnlyMediaList(
          c.medias as any[],
          c.coverMediaId ?? null,
        );
        const { collectionCollabsCount, threadsCount, ...rest } = c as any;
        return {
          ...rest,
          coverMediaId: c.coverMediaId ?? coverMedias[0]?.id ?? null,
          medias: coverMedias,
          collectionCollabCount: collectionCollabsCount,
          threadsCount: threadsCount,
          isThreaded: requesterId ? !!isThreadedMap[c.id] : false,
        };
      }),
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
      select: {
        visibility: true,
        ownerId: true,
        title: true,
        owner: {
          select: this.selectCollectionOwnerDisplay(),
        },
      },
    });
    if (collection && collection.visibility !== CollectionVisibility.PUBLIC) {
      throw new ForbiddenException('Cannot interact with private collection');
    }

    const existing = await this.prisma.collectionReaction.findUnique({
      where: { collectionId_userId: { collectionId, userId } },
    });

    let delta = 0;
    let nowThreaded = false;
    if (existing) {
      if (existing.type === type) {
        // Remove reaction
        await this.prisma.collectionReaction.delete({
          where: { id: existing.id },
        });
        if (type === ReactionType.THREAD) {
          delta = -1;
          nowThreaded = false;
        }
      } else {
        // Change reaction type
        await this.prisma.collectionReaction.update({
          where: { id: existing.id },
          data: { type },
        });
        if (
          existing.type === ReactionType.DISLIKE &&
          type === ReactionType.THREAD
        ) {
          delta = +1;
        }
        if (
          existing.type === ReactionType.THREAD &&
          type === ReactionType.DISLIKE
        ) {
          // Moving from THREAD to DISLIKE decrements threads for analytics
          delta = -1;
        }
        nowThreaded = type === ReactionType.THREAD;
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
      if (type === ReactionType.THREAD) {
        delta = +1;
        nowThreaded = true;
      }
    }

    // Update denormalized counts
    const [threads, dislikes] = await Promise.all([
      this.prisma.collectionReaction.count({
        where: { collectionId, type: ReactionType.THREAD },
      }),
      this.prisma.collectionReaction.count({
        where: { collectionId, type: ReactionType.DISLIKE },
      }),
    ]);

    const updated = await this.prisma.collection.update({
      where: { id: collectionId },
      data: { threadsCount: threads, dislikesCount: dislikes },
    });

    // Update analytics daily threads if changed
    if (this.analytics && delta !== 0) {
      await this.analytics.updateDailyThread(
        ContentTarget.COLLECTION,
        collectionId,
        delta,
      );
    }

    // Notify owner when a new THREAD is added
    if (nowThreaded && userId !== collection.ownerId && this.notifications) {
      try {
        await this.notifications.create(
          collection.ownerId,
          NotificationType.THREAD,
          {
            actorId: userId,
            payload: {
              collectionId,
              targetType: 'COLLECTION',
              contentTitle: collection.title ?? undefined,
            },
            dedupeMs: 5 * 60 * 1000,
          },
        );
      } catch { }
    }

    // Notify patchers about engagement on brand content
    if (
      nowThreaded &&
      this.notifications &&
      collection.owner?.type === UserType.BRAND
    ) {
      const collectionLabel = collection.title
        ? `"${collection.title}"`
        : 'a collection';
      const patchers = await this.prisma.patchConnection.findMany({
        where: {
          targetId: collection.ownerId,
          status: PatchStatus.ACCEPTED,
          mode: PatchMode.USER_TO_BRAND,
        },
        select: { requesterId: true },
      });

      const recipientIds = patchers
        .map((p) => p.requesterId)
        .filter((id) => id && id !== userId);

      if (recipientIds.length > 0 && this.notificationsQueue) {
        try {
          await this.notificationsQueue.enqueueFanout({
            recipientIds,
            notificationType: NotificationType.THREAD,
            actorId: userId,
            payload: {
              collectionId,
              targetUrl: `/collections/${collectionId}`,
              targetType: 'COLLECTION',
              contentTitle: collection.title ?? undefined,
              message: `threaded ${collectionLabel}`,
            },
            dedupeMs: 2 * 60 * 1000,
          });
        } catch (e) {
          console.warn('Failed to enqueue thread fanout', e);
        }
      } else if (recipientIds.length > 0) {
        for (const recipientId of recipientIds) {
          try {
            await this.notifications.create(
              recipientId,
              NotificationType.THREAD,
              {
                actorId: userId,
                payload: {
                  collectionId,
                  targetUrl: `/collections/${collectionId}`,
                  targetType: 'COLLECTION',
                  contentTitle: collection.title ?? undefined,
                  message: `threaded ${collectionLabel}`,
                },
                dedupeMs: 2 * 60 * 1000,
              },
            );
          } catch (e) {
            console.warn('Failed to notify patcher of thread', e);
          }
        }
      }
    }

    return {
      threads: updated.threadsCount,
      dislikes: updated.dislikesCount,
      threaded: nowThreaded,
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
      include: { owner: { select: this.selectCollectionOwnerDisplay() } },
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
      } catch { }
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
      } catch { }
    }

    return { status, message: `Contribution request ${status.toLowerCase()}` };
  }

  async getContributionRequests(collectionId: string, ownerId: string) {
    await this.assertOwner(collectionId, ownerId);
    return this.prisma.contributionRequest.findMany({
      where: { collectionId, status: PatchStatus.PENDING },
      include: {
        requester: {
          select: this.selectCollectionOwnerDisplay(),
        },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  // ============================================
  // HELPER METHODS
  // ============================================

  /**
   * COLLECTION COLLABS - Scalable approach
   * Collabs are similar to "reposts" that boost visibility
   */
  async createCollectionCollab(
    collectionId: string,
    collabBrandId: string,
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
      where: { id: collabBrandId },
    });

    if (!brand || brand.type !== UserType.BRAND) {
      throw new ForbiddenException('Only brands can collab collections');
    }

    // Check if brand already collabed this collection
    const existingCollab = await this.prisma.collectionCollab.findFirst({
      where: {
        collectionId,
        patchingBrandId: collabBrandId,
      },
    });

    if (existingCollab) {
      throw new BadRequestException('You have already collabed this collection');
    }

    // Create collab record
    const collab = await this.prisma.collectionCollab.create({
      data: {
        id: uuidv4(),
        collectionId,
        patchingBrandId: collabBrandId,
        weight,
      },
      include: {
        patchingBrand: {
          select: this.selectCollectionOwnerDisplay(),
        },
      },
    });

    // Update denormalized collabs count
    const totalCollabs = await this.prisma.collectionCollab.count({
      where: { collectionId },
    });

    await this.prisma.collection.update({
      where: { id: collectionId },
      data: { collectionCollabsCount: totalCollabs },
    });

    // Optional: Create notification for collection owner
    if (collection.ownerId !== collabBrandId && this.notifications) {
      try {
        await this.notifications.create(
          collection.ownerId,
          NotificationType.PATCH,
          {
            actorId: collabBrandId,
            payload: {
              action: 'COLLECTION_COLLAB',
              target: { type: 'COLLECTION', id: collectionId },
              collectionId,
              collectionTitle: collection.title,
              collabWeight: weight,
            },
          },
        );
      } catch { }
    }

    return collab;
  }

  /**
   * Get collabs for a collection (who collabed)
   */
  async getCollectionCollabs(
    collectionId: string,
    { cursor, limit = 20 }: { cursor?: string; limit?: number },
  ) {
    const collabs = await this.prisma.collectionCollab.findMany({
      where: { collectionId },
      include: {
        patchingBrand: {
          select: this.selectCollectionOwnerDisplay(),
        },
      },
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    });

    const hasNext = collabs.length > limit;
    const data = hasNext ? collabs.slice(0, -1) : collabs;

    return {
      collabs: data,
      hasNextPage: hasNext,
      endCursor: data.length ? data[data.length - 1].id : null,
    };
  }

  /**
   * Get collections collabed by a specific brand
   */
  async getBrandCollectionCollabs(
    brandId: string,
    { cursor, limit = 20 }: { cursor?: string; limit?: number },
  ) {
    const collabs = await this.prisma.collectionCollab.findMany({
      where: { patchingBrandId: brandId },
      include: {
        collection: {
          include: {
            owner: {
              select: this.selectCollectionOwnerDisplay(),
            },
            medias: {
              select: {
                id: true,
                orderIndex: true,
                file: {
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
              orderBy: { orderIndex: 'asc' },
            },
            _count: {
              select: {
                reactions: true,
                comments: true,
                collectionCollabs: true,
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

    const hasNext = collabs.length > limit;
    const data = hasNext ? collabs.slice(0, -1) : collabs;
    const mappedCollabs = data.map((row: any) => {
      if (!row?.collection) return row;
      const coverMedias = this.toCoverOnlyMediaList(
        row.collection.medias,
        row.collection.coverMediaId ?? null,
      );
      return {
        ...row,
        collection: {
          ...row.collection,
          coverMediaId: row.collection.coverMediaId ?? coverMedias[0]?.id ?? null,
          medias: coverMedias,
        },
      };
    });

    return {
      collabs: mappedCollabs,
      hasNextPage: hasNext,
      endCursor: mappedCollabs.length
        ? mappedCollabs[mappedCollabs.length - 1].id
        : null,
    };
  }

  /**
   * Remove collab
   */
  async removeCollectionCollab(collectionId: string, collabBrandId: string) {
    const collab = await this.prisma.collectionCollab.findFirst({
      where: {
        collectionId,
        patchingBrandId: collabBrandId,
      },
    });

    if (!collab) {
      throw new NotFoundException('Collab not found');
    }

    await this.prisma.collectionCollab.delete({ where: { id: collab.id } });

    // Update denormalized count
    const totalCollabs = await this.prisma.collectionCollab.count({
      where: { collectionId },
    });

    await this.prisma.collection.update({
      where: { id: collectionId },
      data: { collectionCollabsCount: totalCollabs },
    });

    return { success: true };
  }

  /**
   * Get reactions for a collection
   */
  async getReactions(collectionId: string, limit = 20) {
    const ok = await this.canViewCollection(collectionId);
    if (!ok) throw new NotFoundException('Collection not found');

    const [reactions, totalThreads, totalDislikes] = await Promise.all([
      this.prisma.collectionReaction.findMany({
        where: { collectionId, type: ReactionType.THREAD },
        include: {
          user: {
            select: this.selectCollectionOwnerDisplay(),
          },
        },
        orderBy: { createdAt: 'desc' },
        take: limit,
      }),
      this.prisma.collectionReaction.count({
        where: { collectionId, type: ReactionType.THREAD },
      }),
      this.prisma.collectionReaction.count({
        where: { collectionId, type: ReactionType.DISLIKE },
      }),
    ]);

    return {
      users: reactions.map((r) => r.user),
      totalThreads,
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
  // Media-level threads (per upload)
  // =============================
  async toggleMediaThread(mediaId: string, userId: string) {
    const can = await this.canViewMedia(mediaId, userId);
    if (!can) throw new NotFoundException('Media not found');

    const existing = await this.prisma.collectionMediaReaction.findUnique({
      where: {
        collectionMediaId_userId: { collectionMediaId: mediaId, userId },
      },
    });

    let delta = 0;
    let nowThreaded = false;
    if (existing) {
      await this.prisma.collectionMediaReaction.delete({
        where: { id: existing.id },
      });
      delta = -1;
      nowThreaded = false;
    } else {
      await this.prisma.collectionMediaReaction.create({
        data: {
          id: uuidv4(),
          collectionMediaId: mediaId,
          userId,
          type: ReactionType.THREAD,
        },
      });
      delta = +1;
      nowThreaded = true;
    }

    const updated = await this.prisma.collectionMedia.update({
      where: { id: mediaId },
      data: { threadsCount: { increment: delta } },
    });

    if (nowThreaded && this.notifications) {
      const media = await this.prisma.collectionMedia.findUnique({
        where: { id: mediaId },
        select: {
          collectionId: true,
          collection: {
            select: {
              ownerId: true,
              title: true,
              owner: {
                select: this.selectCollectionOwnerDisplay(),
              },
            },
          },
        },
      });

      if (media?.collection?.ownerId && userId !== media.collection.ownerId) {
        try {
          await this.notifications.create(
            media.collection.ownerId,
            NotificationType.THREAD,
            {
              actorId: userId,
              payload: {
                collectionId: media.collectionId,
                targetUrl: `/collections/${media.collectionId}`,
                targetType: 'COLLECTION',
                contentTitle: media.collection.title ?? undefined,
              },
              dedupeMs: 5 * 60 * 1000,
            },
          );
        } catch (e) {
          console.warn('Failed to notify owner of media thread', e);
        }
      }

      if (media?.collection?.owner?.type === UserType.BRAND) {
        const collectionLabel = media.collection.title
          ? `"${media.collection.title}"`
          : 'a collection';
        const patchers = await this.prisma.patchConnection.findMany({
          where: {
            targetId: media.collection.ownerId,
            status: PatchStatus.ACCEPTED,
            mode: PatchMode.USER_TO_BRAND,
          },
          select: { requesterId: true },
        });

        const recipientIds = patchers
          .map((p) => p.requesterId)
          .filter((id) => id && id !== userId);

        if (recipientIds.length > 0 && this.notificationsQueue) {
          try {
            await this.notificationsQueue.enqueueFanout({
              recipientIds,
              notificationType: NotificationType.THREAD,
              actorId: userId,
              payload: {
                collectionId: media.collectionId,
                targetUrl: `/collections/${media.collectionId}`,
                targetType: 'COLLECTION',
                contentTitle: media.collection.title ?? undefined,
                message: `threaded ${collectionLabel}`,
              },
              dedupeMs: 2 * 60 * 1000,
            });
          } catch (e) {
            console.warn('Failed to enqueue media thread fanout', e);
          }
        } else if (recipientIds.length > 0) {
          for (const recipientId of recipientIds) {
            try {
              await this.notifications.create(
                recipientId,
                NotificationType.THREAD,
                {
                  actorId: userId,
                  payload: {
                    collectionId: media.collectionId,
                    targetUrl: `/collections/${media.collectionId}`,
                    targetType: 'COLLECTION',
                    contentTitle: media.collection.title ?? undefined,
                    message: `threaded ${collectionLabel}`,
                  },
                  dedupeMs: 2 * 60 * 1000,
                },
              );
            } catch (e) {
              console.warn('Failed to notify patcher of media thread', e);
            }
          }
        }
      }
    }

    return { threads: updated.threadsCount, threaded: nowThreaded };
  }

  async getMediaReactions(mediaId: string, limit = 20) {
    const can = await this.canViewMedia(mediaId);
    if (!can) throw new NotFoundException('Media not found');
    const rows = await this.prisma.collectionMediaReaction.findMany({
      where: { collectionMediaId: mediaId, type: ReactionType.THREAD },
      include: {
        user: {
          select: this.selectCollectionOwnerDisplay(),
        },
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    const total = await this.prisma.collectionMediaReaction.count({
      where: { collectionMediaId: mediaId, type: ReactionType.THREAD },
    });
    return { users: rows.map((r) => r.user), totalThreads: total };
  }

  async isMediaThreadedByUser(mediaId: string, userId: string | undefined) {
    if (!userId) {
      return { threaded: false };
    }
    const can = await this.canViewMedia(mediaId, userId);
    if (!can) throw new NotFoundException('Media not found');
    const r = await this.prisma.collectionMediaReaction.findUnique({
      where: {
        collectionMediaId_userId: { collectionMediaId: mediaId, userId },
      },
    });
    return { threaded: !!r };
  }

  async isCollectionThreadedByUser(
    collectionId: string,
    userId: string | undefined,
  ) {
    if (!userId) {
      return { threaded: false };
    }
    const r = await this.prisma.collectionReaction.findUnique({
      where: { collectionId_userId: { collectionId, userId } },
    });
    return { threaded: !!r };
  }

  async getThreadsSummary(collectionId: string) {
    const collection = await this.prisma.collection.findUnique({
      where: { id: collectionId },
    });
    if (!collection) {
      throw new NotFoundException('Collection not found');
    }
    const mediaAgg = await this.prisma.collectionMedia.aggregate({
      where: { collectionId },
      _sum: { threadsCount: true },
    });
    const collectionThreads = collection.threadsCount;
    const mediaThreads = mediaAgg._sum.threadsCount ?? 0;
    const totalThreads = collectionThreads + mediaThreads;
    return { collectionThreads, mediaThreads, totalThreads };
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
          const publishedAt = new Date();
          await tx.collection.update({
            where: { id: collection.id },
            data: {
              categoryId: approvedCategoryId,
              categoryTypeId: null,
              pendingCategorySuggestionId: null,
              draftReason: null,
              status: 'PUBLISHED',
              updatedAt: publishedAt,
            },
          });
          await this.cleanupSupersededDraftCollections(
            tx,
            collection.ownerId,
            collection.id,
            collection.title,
            publishedAt,
            (collection as any).domain ?? null,
            Boolean((collection as any).isAvailableInStore),
          );
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
  async getAccessMetrics(
    collectionId: string,
    ownerId: string,
    from?: string,
    to?: string,
  ) {
    await this.assertOwner(collectionId, ownerId, 'DESIGN');
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
    ownerId: string,
    from?: string,
    to?: string,
  ) {
    await this.assertOwner(collectionId, ownerId, 'DESIGN');
    const c = await this.prisma.collection.findUnique({
        where: { id: collectionId, deletedAt: null },
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
        types: {
          where: { isActive: true },
          orderBy: [{ order: 'asc' }, { createdAt: 'asc' }],
          select: {
            id: true,
            slug: true,
            name: true,
            description: true,
            order: true,
          },
        },
      },
    });
    return rows.map((r) => ({
      id: r.id,
      slug: r.slug,
      name: r.name,
      description: r.description,
      order: r.order,
      types: (r.types ?? []).map((t) => ({
        id: t.id,
        slug: t.slug,
        name: t.name,
        description: t.description,
        order: t.order,
      })),
    }));
  }

  async listCategoryTypes(categoryId?: string) {
    const rows = await this.prisma.collectionCategoryType.findMany({
      where: {
        isActive: true,
        ...(categoryId ? { categoryId } : {}),
      },
      orderBy: [{ order: 'asc' }, { createdAt: 'asc' }],
      select: {
        id: true,
        categoryId: true,
        slug: true,
        name: true,
        description: true,
        order: true,
      },
    });

    return rows.map((row) => ({
      id: row.id,
      categoryId: row.categoryId,
      slug: row.slug,
      name: row.name,
      description: row.description,
      order: row.order,
    }));
  }

  // ===================== Update collection (owner only) =====================
  async updateCollection(
    collectionId: string,
    ownerId: string,
    body: UpdateCollectionDto,
    scope?: CollectionScope,
  ) {
    const resolvedScope = this.normalizeCollectionScope(scope);
    const expectedDomain = this.scopeToDomain(resolvedScope);
    if (expectedDomain === 'STORE') {
      await this.assertOwner(collectionId, ownerId, 'STORE');
      const existing = await this.prisma.storeCollection.findUnique({
        where: { id: collectionId },
        select: {
          status: true,
          visibility: true,
          deletedAt: true,
          draftVersion: true,
          tags: true,
          title: true,
          description: true,
          metadataEditedAt: true,
          categoryId: true,
          categoryTypeId: true,
        },
      });
      if (!existing) throw new NotFoundException('Collection not found');
      if (existing.deletedAt) throw new GoneException('Collection has been deleted');

      const titleRequested = typeof body.title === 'string';
      const descriptionRequested = typeof body.description === 'string';
      const titleChanged =
        titleRequested &&
        body.title!.trim() !== String(existing.title ?? '').trim();
      const descriptionChanged =
        descriptionRequested &&
        body.description!.trim() !== String(existing.description ?? '').trim();

      if (titleChanged || descriptionChanged) {
        const cooldownMs = 30 * 24 * 60 * 60 * 1000;
        const lastEdit = existing.metadataEditedAt
          ? new Date(existing.metadataEditedAt).getTime()
          : null;
        if (lastEdit && Date.now() < lastEdit + cooldownMs) {
          const nextEditDate = new Date(lastEdit + cooldownMs);
          throw new BadRequestException(
            `Title and description can only be updated once every 30 days. Next edit available on ${nextEditDate.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}.`,
          );
        }
      }

      const now = new Date();
      const data: any = {};
      const previousTags = Array.isArray(existing.tags) ? existing.tags : [];
      let nextTags: string[] | undefined;
      const targetCategoryId =
        body.categoryId !== undefined
          ? body.categoryId || null
          : (existing.categoryId ?? null);
      const targetCategoryTypeId =
        body.categoryTypeId !== undefined
          ? body.categoryTypeId || null
          : (existing.categoryTypeId ?? null);

      if (typeof body.title === 'string' || body.title === null) data.title = body.title || null;
      if (typeof body.description === 'string' || body.description === null) {
        data.description = body.description || null;
      }
      if (titleChanged || descriptionChanged) {
        data.metadataEditedAt = new Date();
      }
      if (typeof body.visibility === 'string') data.visibility = body.visibility;
      if (typeof body.type === 'string') data.type = body.type;
      if (typeof body.minPrice === 'number' || body.minPrice === null) data.minPrice = body.minPrice as any;
      if (typeof body.maxPrice === 'number' || body.maxPrice === null) data.maxPrice = body.maxPrice as any;
      if (typeof body.saleMinPrice === 'number' || body.saleMinPrice === null) data.saleMinPrice = body.saleMinPrice as any;
      if (typeof body.saleMaxPrice === 'number' || body.saleMaxPrice === null) data.saleMaxPrice = body.saleMaxPrice as any;
      if (typeof body.saleStartAt === 'string' || body.saleStartAt === null) {
        data.saleStartAt = body.saleStartAt ? new Date(body.saleStartAt) : null;
      }
      if (typeof body.saleEndAt === 'string' || body.saleEndAt === null) {
        data.saleEndAt = body.saleEndAt ? new Date(body.saleEndAt) : null;
      }
      if (Array.isArray(body.tags)) {
        nextTags = sanitizeTags(body.tags, 30);
        data.tags = nextTags;
      }
      if (targetCategoryId) {
        await this.assertActiveCategory(targetCategoryId);
      }
      if (targetCategoryTypeId) {
        await this.assertCategoryTypeMatchesCategory(
          targetCategoryId,
          targetCategoryTypeId,
        );
      }
      if (typeof body.categoryId === 'string' || body.categoryId === null) {
        data.categoryId = body.categoryId || null;
      }
      if (
        typeof body.categoryTypeId === 'string' ||
        body.categoryTypeId === null ||
        (body.categoryId !== undefined && body.categoryTypeId === undefined)
      ) {
        data.categoryTypeId =
          body.categoryTypeId !== undefined
            ? body.categoryTypeId || null
            : targetCategoryTypeId;
      }
      if (existing.status === 'DRAFT') {
        data.lastActivityAt = now;
        data.draftVersion = { increment: 1 };
      }

      const updated = await this.prisma.storeCollection.update({
        where: { id: collectionId },
        data,
        include: {
          owner: {
            select: this.selectCollectionOwnerDisplay(),
          },
        },
      });

      const previousIndexedTags = this.getIndexedCollectionTags(
        {
          status: existing.status,
          visibility: existing.visibility,
          deletedAt: existing.deletedAt,
          tags: previousTags,
        },
        previousTags,
      );
      const resolvedNextTags = nextTags ?? (Array.isArray(updated.tags) ? updated.tags : previousTags);
      const nextIndexedTags = this.getIndexedCollectionTags(
        {
          status: updated.status,
          visibility: updated.visibility,
          deletedAt: updated.deletedAt,
          tags: resolvedNextTags,
        },
        resolvedNextTags,
      );
      const shouldSyncCollectionTags =
        nextTags !== undefined ||
        !this.areTagsEqual(previousIndexedTags, nextIndexedTags);
      if (shouldSyncCollectionTags) {
        if (this.systemTags) {
          await this.systemTags.syncTags(previousIndexedTags, nextIndexedTags);
        }
        if (this.tagIndex) {
          await this.tagIndex.syncEntityTags(
            TAG_ENTITY_TYPE.COLLECTION,
            collectionId,
            previousIndexedTags,
            nextIndexedTags,
            { maxCount: 30 },
          );
        }
      }
      return { ...updated, domain: 'STORE', isAvailableInStore: true };
    }

    await this.assertOwner(collectionId, ownerId, expectedDomain ?? undefined);
    const existing = (await this.prisma.collection.findUnique({
      where: { id: collectionId },
      select: {
        domain: true,
        status: true,
        visibility: true,
        deletedAt: true,
        draftVersion: true,
        tags: true,
        title: true,
        description: true,
        metadataEditedAt: true,
        categoryId: true,
        categoryTypeId: true,
        customOrderEnabled: true,
      } as any,
    } as any)) as any;
    if (!existing) throw new NotFoundException('Collection not found');
    if (existing.deletedAt) throw new GoneException('Collection has been deleted');

    const titleRequested = typeof body.title === 'string';
    const descriptionRequested = typeof body.description === 'string';
    const titleChanged =
      titleRequested &&
      body.title!.trim() !== String(existing.title ?? '').trim();
    const descriptionChanged =
      descriptionRequested &&
      body.description!.trim() !== String(existing.description ?? '').trim();

    if (titleChanged || descriptionChanged) {
      const cooldownMs = 30 * 24 * 60 * 60 * 1000; // 30 days
      const lastEdit = existing.metadataEditedAt
        ? new Date(existing.metadataEditedAt).getTime()
        : null;

      if (lastEdit && Date.now() < lastEdit + cooldownMs) {
        const nextEditDate = new Date(lastEdit + cooldownMs);
        throw new BadRequestException(
          `Title and description can only be updated once every 30 days. Next edit available on ${nextEditDate.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}.`,
        );
      }
    }

    const now = new Date();
    if (existing.status === 'DRAFT') {
      if (typeof body.draftVersion === 'number' && body.draftVersion !== existing.draftVersion) {
        throw new ConflictException({
          code: 'DRAFT_VERSION_CONFLICT',
          message: 'Draft was modified by another session.',
          serverVersion: existing.draftVersion,
        } as any);
      }
      await this.enforceDraftSessionLock(
        collectionId,
        ownerId,
        body.draftSessionToken,
      );
    }

    const data: any = {};
    const previousTags = Array.isArray(existing.tags) ? existing.tags : [];
    let nextTags: string[] | undefined;
    const targetCategoryId =
      body.categoryId !== undefined
        ? body.categoryId || null
        : (existing.categoryId ?? null);
    const targetCategoryTypeId =
      body.categoryTypeId !== undefined
        ? body.categoryTypeId || null
        : (existing.categoryTypeId ?? null);
    if (typeof body.title === 'string' || body.title === null)
      data.title = body.title || null;
    if (typeof body.description === 'string' || body.description === null)
      data.description = body.description || null;
    // Stamp metadataEditedAt when title or description actually changes
    if (titleChanged || descriptionChanged) {
      data.metadataEditedAt = new Date();
    }
    if (typeof body.visibility === 'string') data.visibility = body.visibility;
    if (typeof body.type === 'string') data.type = body.type;
    if (typeof body.isAvailableInStore === 'boolean') {
      data.isAvailableInStore = existing.domain === 'STORE';
    }
    data.domain = existing.domain === 'STORE' ? 'STORE' : 'DESIGN';
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
    if (typeof body.sizingMode === 'string') data.sizingMode = body.sizingMode;
    if (Array.isArray(body.rtwSizes)) data.rtwSizes = body.rtwSizes;
    if (typeof body.rtwSizeSystem === 'string' || body.rtwSizeSystem === null)
      data.rtwSizeSystem = body.rtwSizeSystem;
    if (typeof body.rtwSizeType === 'string' || body.rtwSizeType === null)
      data.rtwSizeType = body.rtwSizeType;
    if (typeof body.customGender === 'string' || body.customGender === null)
      data.customGender = body.customGender;
    if (Array.isArray(body.customMeasurementKeys))
      data.customMeasurementKeys = this.normalizeMeasurementKeys(
        body.customMeasurementKeys,
      );
    if (typeof body.customOrderEnabled === 'boolean') {
      data.customOrderEnabled = body.customOrderEnabled;
    }
    if (Array.isArray(body.customFreeformPointIds))
      data.customFreeformPointIds = body.customFreeformPointIds;
    if (typeof body.fitPreference === 'string' || body.fitPreference === null)
      data.fitPreference = body.fitPreference;
    if (typeof body.targetAgeGroup === 'string') {
      data.targetAgeGroup = body.targetAgeGroup;
    } else if (body.targetAgeGroup === null) {
      data.targetAgeGroup = 'ADULT';
    }
    if (Array.isArray(body.tags)) {
      nextTags = sanitizeTags(body.tags, 30);
      data.tags = nextTags;
    }
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

    if (targetCategoryId) {
      await this.assertActiveCategory(targetCategoryId);
    }
    if (targetCategoryTypeId) {
      await this.assertCategoryTypeMatchesCategory(
        targetCategoryId,
        targetCategoryTypeId,
      );
    }

    if (typeof body.categoryId === 'string' || body.categoryId === null) {
      data.categoryId = body.categoryId || null;
    }
    if (
      typeof body.categoryTypeId === 'string' ||
      body.categoryTypeId === null ||
      (body.categoryId !== undefined && body.categoryTypeId === undefined)
    ) {
      data.categoryTypeId =
        body.categoryTypeId !== undefined
          ? body.categoryTypeId || null
          : targetCategoryTypeId;
    }

    if (existing.status === 'DRAFT') {
      data.lastActivityAt = now;
      data.draftVersion = { increment: 1 };
    }

    const nextCustomOrderEnabled =
      typeof body.customOrderEnabled === 'boolean'
        ? body.customOrderEnabled
        : Boolean(existing.customOrderEnabled);
    if (existing.status === 'PUBLISHED') {
      await this.assertDesignCustomOrderPublishReady(
        collectionId,
        ownerId,
        nextCustomOrderEnabled,
      );
    }

    const updated = await this.prisma.collection.update({
      where: { id: collectionId },
      data,
      include: {
        owner: {
          select: this.selectCollectionOwnerDisplay(),
        },
        // coverMedia relation may not be generated yet until migration applied; comment out include safely
        // coverMedia: { include: { file: true } },
        _count: { select: { medias: true, views: true, comments: true } },
      },
    });

    if (body.customOrderEnabled === false) {
      await this.prisma.customOrderConfiguration.updateMany({
        where: {
          sourceType: CustomOrderSourceType.DESIGN,
          sourceId: collectionId,
          isActive: true,
        },
        data: { isActive: false },
      });
    }

    if (
      typeof body.visibility === 'string' &&
      body.visibility !== existing.visibility &&
      body.visibility === CollectionVisibility.PRIVATE
    ) {
      await this.handleVisibilityChange(collectionId, 'PRIVATE', ownerId);
    }
    const previousIndexedTags = this.getIndexedCollectionTags(
      {
        status: existing.status,
        visibility: existing.visibility,
        deletedAt: existing.deletedAt,
        tags: previousTags,
      },
      previousTags,
    );
    const resolvedNextTags = nextTags ?? (Array.isArray(updated.tags) ? updated.tags : previousTags);
    const nextIndexedTags = this.getIndexedCollectionTags(
      {
        status: updated.status,
        visibility: updated.visibility,
        deletedAt: updated.deletedAt,
        tags: resolvedNextTags,
      },
      resolvedNextTags,
    );
    const shouldSyncCollectionTags =
      nextTags !== undefined ||
      !this.areTagsEqual(previousIndexedTags, nextIndexedTags);

    if (shouldSyncCollectionTags) {
      if (this.systemTags) {
        await this.systemTags.syncTags(previousIndexedTags, nextIndexedTags);
      }
      if (this.tagIndex) {
        await this.tagIndex.syncEntityTags(
          TAG_ENTITY_TYPE.COLLECTION,
          collectionId,
          previousIndexedTags,
          nextIndexedTags,
          { maxCount: 30 },
        );
      }
    }

    if (Array.isArray(body.filterValueIds) && this.categoriesService) {
      await this.categoriesService.setEntityFilters(
        'COLLECTION',
        collectionId,
        this.normalizeFilterValueIds(body.filterValueIds),
      );
    }

    return updated;
  }

  // ===================== Cart Preview for Collections =====================
  /**
   * Get cart preview showing available and unavailable products in a collection
   * Used before "Add Entire Collection to Cart"
   */
  async getCollectionCartPreview(collectionId: string, requesterId?: string) {
    const canView = await this.canViewStoreCollection(collectionId, requesterId);
    if (!canView) throw new NotFoundException('Collection not found');

    const collection = await this.prisma.storeCollection.findUnique({
      where: { id: collectionId },
      select: { id: true, title: true },
    });

    const links = await this.prisma.storeCollectionProduct.findMany({
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

      // Deleted/archived/inactive products should no longer participate in
      // customer-facing collection cart previews.
      if (p.deletedAt || p.archivedAt || !p.isActive) {
        continue;
      }

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
        sizes: Array.isArray(p.sizes) ? p.sizes : [],
        colors: Array.isArray(p.colors) ? p.colors : [],
        defaultSize: p.sizes?.[0],
        defaultColor: p.colors?.[0],
        allowBackorders: canBackorder,
      };

      // Determine availability
      if (p.publishAt && p.publishAt > now) {
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
        totalCount: available.length + unavailable.length,
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
    await this.assertActorCanManageLegacyOwnerCatalog(ownerId, product.brand.ownerId);

    const memberships = await this.prisma.storeCollectionProduct.findMany({
      where: { productId },
      include: {
        collection: {
          select: { id: true, title: true, minPrice: true, maxPrice: true },
        },
      },
    });

    const affectedCollections: any[] = [];

    const collectionIds = memberships.map((m) => m.collectionId);
    const linksByCollection = new Map<string, Array<{
      productId: string;
      product: { id: string; price: any } | null;
    }>>();

    if (collectionIds.length > 0) {
      const links = await this.prisma.storeCollectionProduct.findMany({
        where: { collectionId: { in: collectionIds } },
        include: { product: { select: { id: true, price: true } } },
      });

      for (const link of links) {
        const bucket = linksByCollection.get(link.collectionId);
        if (bucket) {
          bucket.push(link);
        } else {
          linksByCollection.set(link.collectionId, [link]);
        }
      }
    }

    for (const m of memberships) {
      const links = linksByCollection.get(m.collectionId) ?? [];

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
   * Processed asynchronously via BullMQ worker
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
    const maxFileSize = this.systemConfigService
      ? await this.systemConfigService.getMaxFileSize('upload.maxSize.collectionBulk')
      : 2 * 1024 * 1024;
    if (file.size > maxFileSize) {
      const limitMB = (maxFileSize / (1024 * 1024)).toFixed(1);
      throw new BadRequestException(`Bulk upload file exceeds the ${limitMB}MB limit`);
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
        status: 'PENDING',
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

    if (this.bulkUploadQueue) {
      try {
        await this.bulkUploadQueue.add(
          BULK_UPLOAD_PROCESS_JOB,
          { jobId },
          { jobId: `bulk-upload:${jobId}` },
        );
      } catch (error) {
        if (process.env.NODE_ENV === 'production') {
          await this.prisma.collectionBulkUploadJob.update({
            where: { id: jobId },
            data: { status: 'FAILED', errorSummary: [{ message: 'Queue unavailable in production' }] as any },
          });
          throw new InternalServerErrorException('Bulk upload queue is not configured');
        }

        this.logger.warn(
          `Failed to enqueue bulk upload job ${jobId}; running dev inline fallback: ${String(error)}`,
        );
        void setImmediate(() => {
          this.processBulkUploadJob(jobId).catch((err) =>
            this.logger.error(`Inline bulk upload failed for ${jobId}: ${String(err)}`),
          );
        });
      }
    } else {
      if (process.env.NODE_ENV === 'production') {
        await this.prisma.collectionBulkUploadJob.update({
          where: { id: jobId },
          data: { status: 'FAILED', errorSummary: [{ message: 'Queue unavailable in production' }] as any },
        });
        throw new InternalServerErrorException('Bulk upload queue is not configured');
      }

      this.logger.warn(
        `Bulk upload queue not configured; running dev inline fallback for job ${jobId}`,
      );
      void setImmediate(() => {
        this.processBulkUploadJob(jobId).catch((err) =>
          this.logger.error(`Inline bulk upload failed for ${jobId}: ${String(err)}`),
        );
      });
    }

    return {
      jobId,
      status: 'pending',
      totalRows: rows.length,
      processedRows: 0,
      successRows: 0,
      failedRows: 0,
      errors: [],
    };
  }

  async processBulkUploadJob(jobId: string) {
    const job = await this.prisma.collectionBulkUploadJob.findFirst({
      where: { id: jobId },
      include: { rows: true },
    });
    if (!job) throw new NotFoundException('Bulk upload job not found');

    const claim = await this.prisma.collectionBulkUploadJob.updateMany({
      where: { id: jobId, status: { in: ['PENDING', 'FAILED', 'PARTIAL'] } },
      data: {
        status: 'PROCESSING',
        processedRows: 0,
        successRows: 0,
        failedRows: 0,
        errorSummary: null,
        completedAt: null,
      },
    });

    if (claim.count === 0) {
      const existing = await this.prisma.collectionBulkUploadJob.findUnique({
        where: { id: jobId },
        select: {
          status: true,
          processedRows: true,
          successRows: true,
          failedRows: true,
          errorSummary: true,
        },
      });
      if (!existing) throw new NotFoundException('Bulk upload job not found');
      this.logger.warn(
        `Skipped bulk upload processing claim for ${jobId}; current status=${existing.status}`,
      );
      return {
        jobId,
        status: String(existing.status).toLowerCase(),
        processedRows: existing.processedRows,
        successRows: existing.successRows,
        failedRows: existing.failedRows,
        errors: Array.isArray(existing.errorSummary) ? existing.errorSummary : [],
      };
    }

    let processedRows = 0;
    let successRows = 0;
    let failedRows = 0;
    const errors: Array<{ row: number; field: string; message: string }> = [];

    for (const rowRecord of job.rows) {
      if (rowRecord.status === 'SUCCESS') continue;
      processedRows += 1;
      try {
        await this.prisma.collectionBulkUploadRow.update({
          where: { id: rowRecord.id },
          data: { status: 'PROCESSING' },
        });

        const payload = rowRecord.payload as Record<string, string>;
        const dto = this.buildBulkProductDto(payload, job.collectionId);
        const created = await this.storeService.createProduct(job.ownerId, dto);

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

    const refreshedRows = await this.prisma.collectionBulkUploadRow.findMany({
      where: { jobId },
      select: { status: true },
    });
    successRows = refreshedRows.filter((row) => row.status === 'SUCCESS').length;
    failedRows = refreshedRows.filter((row) => row.status === 'FAILED').length;
    processedRows = refreshedRows.length;
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
      totalRows: job.totalRows,
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
    const retriedCount = targetRows.filter((row) => row.status !== 'SUCCESS').length;

    await this.prisma.collectionBulkUploadJob.update({
      where: { id: jobId },
      data: { status: 'PROCESSING', completedAt: null },
    });

    if (this.bulkUploadQueue) {
      try {
        await this.bulkUploadQueue.add(
          BULK_UPLOAD_RETRY_JOB,
          { jobId, ownerId, rowIndices },
          { jobId: `bulk-upload-retry:${jobId}:${Date.now()}` },
        );
      } catch (error) {
        console.warn('Failed to enqueue bulk upload retry; running inline', error);
        void setImmediate(() => {
          this.processBulkUploadRetry(jobId, ownerId, rowIndices).catch((err) =>
            console.warn(`Inline bulk upload retry failed for ${jobId}: ${String(err)}`),
          );
        });
      }
    } else {
      void setImmediate(() => {
        this.processBulkUploadRetry(jobId, ownerId, rowIndices).catch((err) =>
          console.warn(`Inline bulk upload retry failed for ${jobId}: ${String(err)}`),
        );
      });
    }

    return {
      jobId,
      retriedCount,
      status: 'queued',
    };
  }

  async processBulkUploadRetry(
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
      select: {
        ownerId: true,
        title: true,
        owner: {
          select: {
            brand: {
              select: { id: true },
            },
          },
        },
      },
    });

    if (!collection) throw new NotFoundException('Collection not found');

    const inquiryId = uuidv4();

    const now = new Date();
    const trimmedMessage = dto.message.trim();
    const brandId = collection.owner?.brand?.id ?? null;
    const pairKey = brandId ? `BUYER_BRAND:${requesterId}:${brandId}` : null;
    const metadata: Record<string, unknown> = {
      inquiryId,
      collectionId,
      productId: dto.productId ?? null,
      preferredSize: dto.preferredSize ?? null,
      measurements: dto.measurements ?? null,
      source: 'CUSTOM_FIT_INQUIRY',
    };

    const createdThread = await this.prisma.$transaction(async (tx) => {
      const existing = pairKey
        ? await tx.messageThread.findFirst({ where: { pairKey } })
        : await tx.messageThread.findFirst({
            where: {
              pairKey: null,
              brandId,
              buyerId: requesterId,
            },
            orderBy: [{ lastMessageAt: 'desc' }, { createdAt: 'desc' }],
          });

      const thread = existing
        ? await tx.messageThread.update({
            where: { id: existing.id },
            data: {
              contextType: MessageContextType.INQUIRY,
              conversationType: MessageConversationType.BUYER_BRAND,
              brandId,
              buyerId: requesterId,
              buyerUserId: requesterId,
              brandOwnerUserId: collection.ownerId,
              pairKey,
              status: 'OPEN',
            },
          })
        : await tx.messageThread.create({
            data: {
              contextType: MessageContextType.INQUIRY,
              conversationType: MessageConversationType.BUYER_BRAND,
              brandId,
              buyerId: requesterId,
              buyerUserId: requesterId,
              brandOwnerUserId: collection.ownerId,
              pairKey,
              subjectSnapshotJson: {
                type: 'CUSTOM_FIT_INQUIRY',
                collectionId,
                collectionTitle: collection.title ?? null,
                inquiryId,
              } as Prisma.InputJsonValue,
              status: 'OPEN',
            },
          });

      await tx.messageThreadParticipant.createMany({
        data: [
          {
            id: uuidv4(),
            threadId: thread.id,
            userId: requesterId,
            role: MessageParticipantRole.BUYER,
          },
          {
            id: uuidv4(),
            threadId: thread.id,
            userId: collection.ownerId,
            role: MessageParticipantRole.BRAND_OWNER,
          },
        ],
        skipDuplicates: true,
      });

      const message = await tx.message.create({
        data: {
          id: uuidv4(),
          threadId: thread.id,
          contextType: MessageContextType.INQUIRY,
          senderUserId: requesterId,
          senderRole: MessageParticipantRole.BUYER,
          kind: MessageKind.USER,
          bodyText: trimmedMessage,
          metadataJson: metadata as Prisma.InputJsonValue,
        },
      });

      await tx.messageThread.update({
        where: { id: thread.id },
        data: {
          lastMessageId: message.id,
          lastMessageAt: now,
          lastVisibleMessageAt: now,
          lastMessagePreview: trimmedMessage.slice(0, 240),
          lastSenderUserId: requesterId,
        },
      });

      return thread;
    });

    if (this.notifications) {
      await this.notifications
        .create(collection.ownerId, NotificationType.MESSAGE_RECEIVED, {
          actorId: requesterId,
          payload: {
            threadId: createdThread.id,
            inquiryId,
            collectionId,
            collectionTitle: collection.title ?? 'Design',
            productId: dto.productId ?? null,
            targetUrl: `/messages?threadId=${createdThread.id}`,
            type: 'CUSTOM_FIT_INQUIRY',
          },
        })
        .catch(() => undefined);
    }

    return {
      success: true,
      inquiryId,
      threadId: createdThread.id,
      message: 'Your inquiry has been sent to the brand. They will respond soon.',
      estimatedResponseTime: '24-48 hours',
    };
  }

  @Cron(CronExpression.EVERY_5_MINUTES)
  async recoverStaleBulkUploadJobs() {
    const staleThreshold = new Date(Date.now() - 15 * 60 * 1000);
    const result = await this.prisma.collectionBulkUploadJob.updateMany({
      where: {
        status: 'PROCESSING',
        updatedAt: { lt: staleThreshold },
      },
      data: {
        status: 'FAILED',
        errorSummary: [{ message: 'Job timed out' }] as any,
      },
    });

    if (result.count > 0) {
      this.logger.warn(`Recovered ${result.count} stale bulk upload job(s)`);
    }
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
    await this.assertOwner(
      collectionId,
      ownerId,
      undefined,
      BRAND_PERMISSIONS.CATALOG_DELETE,
    );

    const collection = await this.prisma.collection.findUnique({
      where: { id: collectionId },
      select: {
        coverMediaId: true,
        status: true,
        visibility: true,
        deletedAt: true,
        tags: true,
      },
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
    const previousIndexedTags = this.getIndexedCollectionTags(
      {
        status: collection?.status,
        visibility: collection?.visibility as CollectionVisibility | undefined,
        deletedAt: collection?.deletedAt,
        tags: collection?.tags ?? [],
      },
      collection?.tags ?? [],
    );
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
      const remainingProducts = await tx.storeCollectionProduct.count({
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

    const deletedInfo = await this.prisma.collection.findUnique({
      where: { id: collectionId },
      select: { deletedAt: true },
    });
    if (deletedInfo?.deletedAt) {
      if (previousIndexedTags.length > 0 && this.systemTags) {
        await this.systemTags.syncTags(previousIndexedTags, []);
      }
      if (previousIndexedTags.length > 0 && this.tagIndex) {
        await this.tagIndex.syncEntityTags(
          TAG_ENTITY_TYPE.COLLECTION,
          collectionId,
          previousIndexedTags,
          [],
          { maxCount: 30 },
        );
      }
    }

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
    const productLinks = await this.prisma.storeCollectionProduct.findMany({
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

    return { cleaned: deleted.count };
  }
}

export { CreateCollectionDto, FinalizeCollectionDto };
