import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  ConflictException,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { CreateProductDto, UpdateProductDto } from './dto/create-product.dto';
import { AddToCartDto, UpdateCartItemDto } from './dto/cart.dto';
import { AddToWishlistDto } from './dto/wishlist.dto';
import { CheckoutDto } from './dto/checkout.dto';
import { v4 as uuidv4 } from 'uuid';
import {
  CollectionType,
  Prisma,
  NotificationType,
  PatchMode,
  PatchStatus,
  UserType,
} from '@prisma/client';
import { UpdateStoreNameDto } from './dto/update-store-name.dto';
import { UpdateStoreProfileDto } from './dto/update-store-profile.dto';
import { UpdateStorePoliciesDto } from './dto/update-store-policies.dto';
import { PasswordService } from 'src/auth/helper/password.service';
import { UploadService } from 'src/upload/upload.service';
import { FileType } from 'src/upload/upload.enums';
import { ProductViewCounterService } from './product-view-counter.service';
import { NotificationsService } from 'src/notifications/notifications.service';
import { SystemTagsService } from 'src/tags/system-tags.service';
import { TagIndexService } from 'src/tags/tag-index.service';
import { NotificationsQueueService } from 'src/queue/notifications.queue.service';
import {
  normalizeTag as normalizeTagValue,
  sanitizeTags,
} from 'src/common/utils/tag-validator';
import { TAG_ENTITY_TYPE } from 'src/tags/tag-entity-type';

@Injectable()
export class StoreService {
  private readonly logger = new Logger(StoreService.name);
  private readonly systemTagsTtlMs = 5 * 60 * 1000;
  private systemTagsCache: { tags: string[]; expiresAt: number } | null = null;
  private systemTagsRefresh: Promise<string[]> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly passwordService: PasswordService,
    private readonly uploadService: UploadService,
    private readonly viewCounter: ProductViewCounterService,
    private readonly notifications?: NotificationsService,
    private readonly systemTags?: SystemTagsService,
    private readonly tagIndex?: TagIndexService,
    private readonly notificationsQueue?: NotificationsQueueService,
  ) {}

  private readonly maxProductsPerCollection = 5;

  private async lockCollectionForUpdate(
    tx: Prisma.TransactionClient,
    collectionId: string,
  ) {
    await tx.$executeRaw(
      Prisma.sql`SELECT "_id" FROM "StoreCollection" WHERE "_id" = ${collectionId} FOR UPDATE`,
    );
  }

  private async assertCategoryTypeForCollection(
    tx: Prisma.TransactionClient,
    collectionId: string | null | undefined,
    categoryTypeId: string | null | undefined,
  ) {
    if (!categoryTypeId) return;

    const categoryType = await tx.collectionCategoryType.findUnique({
      where: { id: categoryTypeId },
      select: { id: true, categoryId: true, isActive: true },
    });
    if (!categoryType) {
      throw new NotFoundException('Sub-category not found');
    }
    if (!categoryType.isActive) {
      throw new BadRequestException('Sub-category is not active');
    }

    if (!collectionId) {
      return;
    }

    const collection = await tx.storeCollection.findUnique({
      where: { id: collectionId },
      select: { id: true, categoryId: true, deletedAt: true },
    });
    if (!collection || collection.deletedAt) {
      throw new NotFoundException('Collection not found');
    }
    if (!collection.categoryId) {
      // Collection taxonomy is optional; product taxonomy can still be set independently.
      return;
    }

    if (categoryType.categoryId !== collection.categoryId) {
      throw new BadRequestException(
        'Selected sub-category does not belong to the selected collection category',
      );
    }
  }

  private async attachProductMedia(product: any) {
    const base = this.transformProduct(product);
    const images: string[] = Array.isArray(product?.images)
      ? product.images.filter(Boolean)
      : [];

    if (images.length === 0) {
      return { ...base, media: [], mediaIds: [] };
    }

    const uploads = await this.prisma.fileUpload.findMany({
      where: { s3Url: { in: images } },
      select: { id: true, s3Url: true, mimeType: true },
    });

    const idByUrl = new Map<string, string>();
    for (const u of uploads) idByUrl.set(u.s3Url, u.id);

    const media = images.map((url) => ({
      id: idByUrl.get(url) ?? url,
      url,
      type: 'image',
      isPrimary: !!product?.thumbnail && url === product.thumbnail,
    }));

    return {
      ...base,
      media,
      mediaIds: media.map((m) => m.id),
    };
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

  async getProductCategories() {
    return this.prisma.collectionCategory.findMany({
      where: { isActive: true },
      orderBy: [{ order: 'asc' }, { createdAt: 'asc' }],
      select: { id: true, slug: true, name: true, description: true },
    });
  }

  private async assertBrandOwnsProduct(brandOwnerId: string, productId: string) {
    const product = await this.prisma.product.findFirst({
      where: { id: productId },
      include: { brand: true },
    });

    if (!product) throw new NotFoundException('Product not found');
    if (product.brand.ownerId !== brandOwnerId) {
      throw new ForbiddenException('You can only modify your own products');
    }

    return product;
  }

  private async resolveBrandByIdOrOwner(brandIdOrOwnerId: string) {
    let brand = await this.prisma.brand.findUnique({
      where: { id: brandIdOrOwnerId },
      select: { id: true, isStoreOpen: true, ownerId: true },
    });

    if (!brand) {
      brand = await this.prisma.brand.findUnique({
        where: { ownerId: brandIdOrOwnerId },
        select: { id: true, isStoreOpen: true, ownerId: true },
      });
    }

    if (!brand) {
      const owner = await this.prisma.user.findUnique({
        where: { id: brandIdOrOwnerId },
        select: {
          id: true,
          type: true,
          brandFullName: true,
          firstName: true,
          lastName: true,
          username: true,
        },
      });

      if (owner && owner.type === UserType.BRAND) {
        const fullName = `${owner.firstName ?? ''} ${owner.lastName ?? ''}`.trim();
        const name = (owner.brandFullName ?? '').trim() || fullName || owner.username || 'Brand';

        try {
          brand = await this.prisma.brand.create({
            data: {
              id: uuidv4(),
              name,
              storeNameLastChangedAt: new Date(),
              currency: 'NGN',
              ownerId: owner.id,
            },
            select: { id: true, isStoreOpen: true, ownerId: true },
          });
        } catch (dbError: any) {
          if (dbError?.code === 'P2002') {
            brand = await this.prisma.brand.findUnique({
              where: { ownerId: owner.id },
              select: { id: true, isStoreOpen: true, ownerId: true },
            });
          } else {
            throw dbError;
          }
        }
      }
    }

    return brand;
  }

  async uploadProductMedia(
    brandOwnerId: string,
    productId: string,
    file: Express.Multer.File,
    isPrimary: boolean,
  ) {
    if (!file) throw new BadRequestException('No file uploaded');

    const product = await this.assertBrandOwnsProduct(brandOwnerId, productId);

    // Re-use existing POST_IMAGE validation rules for product images.
    const uploaded = await this.uploadService.uploadFile(
      file,
      brandOwnerId,
      FileType.POST_IMAGE,
    );

    const nextImages = Array.isArray(product.images) ? [...product.images] : [];
    if (nextImages.length >= 4) {
      throw new BadRequestException('You can upload up to 4 images');
    }
    nextImages.push(uploaded.url);

    const nextThumbnail =
      isPrimary || !product.thumbnail ? uploaded.url : product.thumbnail;

    await this.prisma.product.update({
      where: { id: productId },
      data: {
        images: nextImages,
        thumbnail: nextThumbnail,
      },
    });

    return { id: uploaded.id, url: uploaded.url };
  }

  async deleteProductMedia(
    brandOwnerId: string,
    productId: string,
    mediaId: string,
  ) {
    const product = await this.assertBrandOwnsProduct(brandOwnerId, productId);

    const upload = await this.prisma.fileUpload.findFirst({
      where: { id: mediaId, userId: brandOwnerId },
      select: { id: true, s3Url: true },
    });

    if (!upload) throw new NotFoundException('Media not found');

    const existingImages = Array.isArray(product.images) ? product.images : [];
    const nextImages = existingImages.filter((u) => u !== upload.s3Url);

    let nextThumbnail = product.thumbnail ?? null;
    if (nextThumbnail === upload.s3Url) {
      nextThumbnail = nextImages[0] ?? null;
    }

    await this.prisma.product.update({
      where: { id: productId },
      data: { images: nextImages, thumbnail: nextThumbnail },
    });

    await this.uploadService.deleteFile(mediaId, brandOwnerId);

    return { success: true };
  }

  async reorderProductMedia(
    brandOwnerId: string,
    productId: string,
    mediaIds: string[],
  ) {
    const product = await this.assertBrandOwnsProduct(brandOwnerId, productId);

    const ids = Array.isArray(mediaIds) ? mediaIds.filter(Boolean) : [];
    if (ids.length > 4) {
      throw new BadRequestException('You can upload up to 4 images');
    }
    if (ids.length === 0) {
      await this.prisma.product.update({
        where: { id: productId },
        data: { images: [], thumbnail: null },
      });
      return { success: true };
    }

    const uploads = await this.prisma.fileUpload.findMany({
      where: { id: { in: ids }, userId: brandOwnerId },
      select: { id: true, s3Url: true },
    });

    if (uploads.length !== ids.length) {
      throw new BadRequestException('One or more mediaIds are invalid');
    }

    const urlById = new Map<string, string>();
    for (const u of uploads) urlById.set(u.id, u.s3Url);

    const nextImages = ids.map((id) => urlById.get(id)!).filter(Boolean);

    const thumbUrl = product.thumbnail ?? null;
    const nextThumbnail =
      thumbUrl && nextImages.includes(thumbUrl) ? thumbUrl : nextImages[0] ?? null;

    await this.prisma.product.update({
      where: { id: productId },
      data: { images: nextImages, thumbnail: nextThumbnail },
    });

    return { success: true };
  }

  async setPrimaryProductMedia(
    brandOwnerId: string,
    productId: string,
    mediaId: string,
  ) {
    const product = await this.assertBrandOwnsProduct(brandOwnerId, productId);

    const upload = await this.prisma.fileUpload.findFirst({
      where: { id: mediaId, userId: brandOwnerId },
      select: { id: true, s3Url: true },
    });

    if (!upload) throw new NotFoundException('Media not found');

    const existingImages = Array.isArray(product.images) ? product.images : [];
    if (!existingImages.includes(upload.s3Url) && existingImages.length >= 4) {
      throw new BadRequestException('You can upload up to 4 images');
    }
    const nextImages = existingImages.includes(upload.s3Url)
      ? existingImages
      : [...existingImages, upload.s3Url];

    await this.prisma.product.update({
      where: { id: productId },
      data: { images: nextImages, thumbnail: upload.s3Url },
    });

    return { success: true };
  }

  private normalizeTag(tag: string): string {
    return normalizeTagValue(tag);
  }

  private normalizeVariantDimension(value: string | null | undefined): string | null {
    const normalized = (value || '').trim().replace(/\s+/g, ' ');
    return normalized ? normalized.slice(0, 40) : null;
  }

  private computeVariantDerived(
    variants: Array<
      | null
      | undefined
      | {
          size?: string;
          color?: string;
          sku?: string;
          price?: number;
          stock?: number;
          colorHex?: string;
        }
    >,
  ) {
    const normalized: Array<{
      size: string | null;
      color: string | null;
      sku: string | null;
      price: Prisma.Decimal | null;
      stock: number;
      colorHex: string | null;
    }> = [];

    const seen = new Set<string>();
    const sizesSet = new Set<string>();
    const colorsSet = new Set<string>();
    const sizeStock: Record<string, number> = {};
    const colorHexCodes: Record<string, string> = {};
    let totalStock = 0;

    for (const v of variants) {
      if (!v) continue;
      const size = this.normalizeVariantDimension(v.size);
      const color = this.normalizeVariantDimension(v.color);
      const key = `${size ?? ''}::${color ?? ''}`;
      if (seen.has(key)) {
        throw new BadRequestException(
          `Duplicate variant detected for size="${size ?? ''}" color="${color ?? ''}"`,
        );
      }
      seen.add(key);

      const stock = Math.max(0, Number(v.stock ?? 0) || 0);
      totalStock += stock;

      if (size) {
        sizesSet.add(size);
        sizeStock[size] = (sizeStock[size] ?? 0) + stock;
      }
      if (color) {
        colorsSet.add(color);
        if (v.colorHex && typeof v.colorHex === 'string') {
          const hex = v.colorHex.trim().slice(0, 16);
          if (hex) colorHexCodes[color] = hex;
        }
      }

      const sku = (v.sku || '').trim().slice(0, 100) || null;
      const price =
        v.price === undefined || v.price === null
          ? null
          : new Prisma.Decimal(Number(v.price));

      normalized.push({
        size,
        color,
        sku,
        price,
        stock,
        colorHex: (v.colorHex || '').trim().slice(0, 16) || null,
      });
    }

    const sizes = Array.from(sizesSet);
    const colors = Array.from(colorsSet);

    return {
      variants: normalized,
      sizes,
      colors,
      sizeStock: Object.keys(sizeStock).length > 0 ? sizeStock : null,
      colorHexCodes: Object.keys(colorHexCodes).length > 0 ? colorHexCodes : null,
      totalStock,
    };
  }

  private generateSlug(name: string): string {
    const base = (name || '')
      .toLowerCase()
      .trim()
      .replace(/[^\w\s-]/g, '') // Remove special chars
      .replace(/\s+/g, '-') // Replace spaces with hyphens
      .replace(/-+/g, '-') // Collapse multiple hyphens
      .slice(0, 80);
    // Add random suffix for uniqueness
    const suffix = Math.random().toString(36).slice(2, 8);
    return `${base}-${suffix}`;
  }

  private buildTagSet(tags: Array<string | null | undefined>): string[] {
    return sanitizeTags(
      tags.map((tag) => String(tag ?? '')),
      30,
    );
  }

  private async getSystemTags(): Promise<string[]> {
    const now = Date.now();
    if (this.systemTagsCache && this.systemTagsCache.expiresAt > now) {
      return this.systemTagsCache.tags;
    }

    if (this.systemTagsCache && this.systemTagsCache.expiresAt <= now) {
      // Serve stale tags while refreshing in the background.
      void this.refreshSystemTags();
      return this.systemTagsCache.tags;
    }

    return this.refreshSystemTags();
  }

  private async refreshSystemTags(): Promise<string[]> {
    if (this.systemTagsRefresh) return this.systemTagsRefresh;
    this.systemTagsRefresh = (async () => {
      const rows = await this.prisma.systemTag.findMany({
        select: { tag: true },
        orderBy: { tag: 'asc' },
      });
      const normalized = rows.map((row) => row.tag);
      this.systemTagsCache = {
        tags: normalized,
        expiresAt: Date.now() + this.systemTagsTtlMs,
      };
      return normalized;
    })().finally(() => {
      this.systemTagsRefresh = null;
    });
    return this.systemTagsRefresh;
  }

  private async getActiveCategories() {
    return this.prisma.collectionCategory.findMany({
      where: { isActive: true },
      orderBy: [{ order: 'asc' }, { createdAt: 'asc' }],
      select: { id: true, slug: true, name: true },
    });
  }

  private async ensureDefaultStoreCollection(
    tx: Prisma.TransactionClient,
    ownerId: string,
  ) {
    const existingDefault = await tx.storeCollection.findFirst({
      where: {
        ownerId,
        isSystemGenerated: true,
        deletedAt: null,
      },
      orderBy: { updatedAt: 'desc' },
      select: { id: true },
    });

    if (existingDefault?.id) return existingDefault.id;

    let createdDefault: { id: string };
    try {
      createdDefault = await tx.storeCollection.create({
        data: {
          id: uuidv4(),
          ownerId,
          title: 'Store Products',
          description: 'System bucket for standalone products.',
          status: 'PUBLISHED',
          visibility: 'PRIVATE',
          type: 'EVERYBODY',
          isAvailableInStore: true,
          isSystemGenerated: true,
        },
        select: { id: true },
      });
    } catch {
      // Handle concurrent create race by re-reading existing system bucket.
      const retry = await tx.storeCollection.findFirst({
        where: {
          ownerId,
          isSystemGenerated: true,
          deletedAt: null,
        },
        orderBy: { updatedAt: 'desc' },
        select: { id: true },
      });
      if (!retry?.id) throw new InternalServerErrorException('Failed to ensure default store collection');
      return retry.id;
    }

    return createdDefault.id;
  }

  private async assertCollectionCapacity(
    tx: Prisma.TransactionClient,
    collectionId: string,
    maxProducts?: number,
  ) {
    const limit = typeof maxProducts === 'number' ? maxProducts : this.maxProductsPerCollection;
    const count = await tx.storeCollectionProduct.count({
      where: { collectionId },
    });
    if (count >= limit) {
      throw new BadRequestException(
        `Collections can contain maximum ${limit} products.`,
      );
    }
  }

  private canonicalStoreName(
    user: { brandFullName: string | null },
    brand?: { name: string } | null,
  ) {
    return (user.brandFullName || brand?.name || '').trim();
  }

  private canonicalStoreSlug(user: { username: string }) {
    return (user.username || '').trim();
  }

  private isProductPublished(product: {
    isActive?: boolean | null;
    publishAt?: Date | null;
    archivedAt?: Date | null;
    deletedAt?: Date | null;
  }) {
    if (!product?.isActive) return false;
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
    if (!this.isProductPublished(product)) return [];
    const source = fallbackTags ?? (Array.isArray(product.tags) ? product.tags : []);
    return this.buildTagSet(source);
  }

  private areTagsEqual(a: string[], b: string[]): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  }

  private getIndexedBrandTags(
    brand: {
      isStoreOpen?: boolean | null;
      tags?: Array<string | null | undefined> | null;
    },
    fallbackTags?: Array<string | null | undefined>,
  ): string[] {
    if (!brand.isStoreOpen) return [];
    const source = fallbackTags ?? (Array.isArray(brand.tags) ? brand.tags : []);
    return this.buildTagSet(source);
  }

  private async notifyPatchersOfProduct(
    brandOwnerId: string,
    product: { id: string; name: string },
  ) {
    if (!this.notifications) return;

    const [patchers, owner] = await Promise.all([
      this.prisma.patchConnection.findMany({
        where: {
          targetId: brandOwnerId,
          status: PatchStatus.ACCEPTED,
          mode: PatchMode.USER_TO_BRAND,
        },
        select: { requesterId: true },
      }),
      this.prisma.user.findUnique({
        where: { id: brandOwnerId },
        select: { username: true, brandFullName: true },
      }),
    ]);

    if (patchers.length === 0) return;

    const brandName =
      owner?.brandFullName || owner?.username || 'A brand';
    const message = `${brandName} added a new product: ${product.name}`;

    const recipientIds = patchers
      .map((p) => p.requesterId)
      .filter((id) => id && id !== brandOwnerId);

    if (recipientIds.length === 0) return;

    if (this.notificationsQueue) {
      try {
        await this.notificationsQueue.enqueueFanout({
          recipientIds,
          notificationType: NotificationType.PRODUCT_UPLOAD,
          actorId: brandOwnerId,
          payload: {
            productId: product.id,
            productName: product.name,
            targetUrl: `/products/${product.id}`,
            message,
          },
          target: { type: 'PRODUCT', id: product.id, preview: product.name },
        });
        return;
      } catch (e) {
        console.warn('Failed to enqueue product notification fanout', e);
      }
    }

    if (!this.notifications) return;

    const chunkSize = 25;
    for (let i = 0; i < recipientIds.length; i += chunkSize) {
      const chunk = recipientIds.slice(i, i + chunkSize);
      await Promise.all(
        chunk.map(async (recipientId) => {
          try {
            await this.notifications.create(
              recipientId,
              NotificationType.PRODUCT_UPLOAD,
              {
                actorId: brandOwnerId,
                payload: {
                  productId: product.id,
                  productName: product.name,
                  targetUrl: `/products/${product.id}`,
                  message,
                },
                target: { type: 'PRODUCT', id: product.id, preview: product.name },
              },
            );
          } catch (e) {
            console.warn('Failed to notify patcher of product', e);
          }
        }),
      );
    }

    try {
      await this.prisma.product.update({
        where: { id: product.id },
        data: { publishNotifiedAt: new Date() },
      });
    } catch (e) {
      console.warn('Failed to mark product publish notification', e);
    }
  }

  // ==================== PRODUCTS ====================

  @Cron(CronExpression.EVERY_5_MINUTES)
  async handleScheduledProductPublishNotifications() {
    if (!this.notifications) return;

    const now = new Date();
    const candidates = await this.prisma.product.findMany({
      where: {
        isActive: true,
        deletedAt: null,
        archivedAt: null,
        publishAt: { lte: now },
        publishNotifiedAt: null,
      },
      select: {
        id: true,
        name: true,
        brand: { select: { ownerId: true } },
      },
      orderBy: { publishAt: 'asc' },
      take: 200,
    });

    if (candidates.length === 0) return;

    this.logger.log(
      `Notifying patchers of ${candidates.length} scheduled product publishes`,
    );

    for (const product of candidates) {
      const ownerId = product.brand?.ownerId;
      if (!ownerId) continue;
      try {
        await this.notifyPatchersOfProduct(ownerId, product);
      } catch (e) {
        this.logger.warn(
          `Failed scheduled product notification for ${product.id}`,
          e as any,
        );
      }
    }
  }

  async createProduct(brandOwnerId: string, dto: CreateProductDto) {
    // Verify brand ownership
    const brand = await this.prisma.brand.findFirst({
      where: { ownerId: brandOwnerId },
      select: { id: true, currency: true },
    });

    if (!brand) {
      throw new ForbiddenException(
        'You must be a brand owner to create products',
      );
    }

    const requestedCollectionId = (dto.collectionId || '').trim() || null;

    // If a collectionId is provided, verify it belongs to this brand.
    if (requestedCollectionId) {
      const collection = await this.prisma.storeCollection.findFirst({
        where: { id: requestedCollectionId, ownerId: brandOwnerId },
        select: { id: true, deletedAt: true },
      });

      if (!collection) {
        throw new NotFoundException(
          'Collection not found or does not belong to you',
        );
      }
      if (collection.deletedAt) {
        throw new BadRequestException('Collection has been deleted');
      }
    }

    // Validate sale price
    const resolvedPrice = dto.price ?? 0;
    if (dto.salePrice !== undefined && dto.salePrice !== null) {
      if (dto.salePrice > resolvedPrice) {
        throw new BadRequestException('salePrice cannot be greater than price');
      }
    }
    if (dto.costPerItem !== undefined && dto.costPerItem !== null) {
      if (dto.costPerItem > resolvedPrice) {
        throw new BadRequestException(
          'costPerItem cannot be greater than price (negative margin)',
        );
      }
    }

    const derivedFromVariants = Array.isArray((dto as any).variants)
      ? this.computeVariantDerived((dto as any).variants)
      : null;

    const currency = (dto.currency || brand.currency || 'NGN').trim();

    const normalizedImages = Array.isArray(dto.images)
      ? dto.images.filter(Boolean)
      : [];
    if (normalizedImages.length > 4) {
      throw new BadRequestException('You can upload up to 4 images');
    }
    let resolvedThumbnail: string | null = dto.thumbnail ?? null;
    if (normalizedImages.length > 0) {
      resolvedThumbnail = resolvedThumbnail || normalizedImages[0];
    } else {
      resolvedThumbnail = null;
    }

    // Resolve product name and slug
    const resolvedName = (dto.name || 'Untitled Product').trim();
    const slug = resolvedName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
    const resolvedTags = this.buildTagSet(dto.tags || []);

    const product = await this.prisma.$transaction(async (tx) => {
      let collectionId = requestedCollectionId;

      if (!collectionId) {
        collectionId = await this.ensureDefaultStoreCollection(tx, brandOwnerId);
      }

      await this.assertCategoryTypeForCollection(
        tx,
        collectionId,
        dto.categoryTypeId,
      );

      await this.lockCollectionForUpdate(tx, collectionId);
      await this.assertCollectionCapacity(tx, collectionId);
      const orderIndex = await tx.storeCollectionProduct.count({
        where: { collectionId },
      });

      const created = await tx.product.create({
        data: {
          id: uuidv4(),
          collectionId,
          categoryTypeId: dto.categoryTypeId || null,
          brandId: brand.id,
          name: resolvedName,
          slug,
          description: dto.description,
          currency,
          price: new Prisma.Decimal(resolvedPrice),
          salePrice: dto.salePrice ? new Prisma.Decimal(dto.salePrice) : null,
          saleStartAt: dto.saleStartAt ? new Date(dto.saleStartAt) : null,
          saleEndAt: dto.saleEndAt ? new Date(dto.saleEndAt) : null,
          // Product details
          sku: dto.sku || null,
          weight: dto.weight ? new Prisma.Decimal(dto.weight) : null,
          weightUnit: dto.weightUnit || 'kg',
          materials: dto.materials || null,
          careInstructions: dto.careInstructions || null,
          costPerItem: dto.costPerItem
            ? new Prisma.Decimal(dto.costPerItem)
            : null,
          // Variants (legacy + derived)
          sizes: derivedFromVariants?.sizes ?? dto.sizes ?? [],
          sizeStock: derivedFromVariants?.sizeStock ?? dto.sizeStock ?? null,
          colors: derivedFromVariants?.colors ?? dto.colors ?? [],
          colorImages: dto.colorImages || null,
          colorHexCodes:
            derivedFromVariants?.colorHexCodes ?? dto.colorHexCodes ?? null,
          // Media
          images: normalizedImages,
          thumbnail: resolvedThumbnail,
          // Inventory
          totalStock:
            derivedFromVariants?.totalStock ?? (dto.totalStock || 0),
          lowStockThreshold: dto.lowStockThreshold || 5,
          trackInventory: dto.trackInventory ?? true,
          allowBackorders: dto.allowBackorders ?? false,
          // Metadata
          tags: resolvedTags,
          gender: dto.gender || 'EVERYBODY',
          isActive: dto.isActive ?? true,
          isFeatured: dto.isFeatured ?? false,
          isPhysicalProduct: dto.isPhysicalProduct ?? true,
          customsRegion: dto.customsRegion || null,
          // Policies
          returnsEligible: dto.returnsEligible ?? true,
          // SEO
          metaTitle: dto.metaTitle || null,
          metaDescription: dto.metaDescription || null,
          // Scheduling
          publishAt: dto.publishAt ? new Date(dto.publishAt) : null,
        },
      });

      await tx.storeCollectionProduct.create({
        data: {
          id: uuidv4(),
          collectionId,
          productId: created.id,
          orderIndex,
          isPrimary: true,
        },
      });

      if (derivedFromVariants && derivedFromVariants.variants.length > 0) {
        await tx.productVariant.createMany({
          data: derivedFromVariants.variants.map((v) => ({
            id: uuidv4(),
            productId: created.id,
            size: v.size,
            color: v.color,
            sku: v.sku,
            price: v.price,
            stock: v.stock,
            colorHex: v.colorHex,
          })),
        });
      }

      return tx.product.findUnique({
        where: { id: created.id },
        include: {
          collections: { select: { collectionId: true, orderIndex: true } },
          brand: { select: { id: true, name: true, logo: true, currency: true } },
          variants: true,
        },
      });
    });

    if (!product) {
      throw new NotFoundException('Product not found');
    }

    const indexedTags = this.getIndexedProductTags(product, resolvedTags);
    if (this.systemTags && indexedTags.length > 0) {
      await this.systemTags.upsertTags(indexedTags);
      this.systemTagsCache = null;
    }
    if (this.tagIndex && indexedTags.length > 0) {
      await this.tagIndex.syncEntityTags(
        TAG_ENTITY_TYPE.PRODUCT,
        product.id,
        [],
        indexedTags,
        { maxCount: 30 },
      );
    }

    const collectionIds = Array.isArray(product.collections)
      ? product.collections.map((c: any) => c.collectionId)
      : [];
    for (const id of collectionIds) {
      await this.recalculateCollectionPriceRange(id);
    }

    if (this.isProductPublished(product)) {
      await this.notifyPatchersOfProduct(brandOwnerId, product);
    }

    return this.attachProductMedia(product);
  }

  async updateProduct(
    brandOwnerId: string,
    productId: string,
    dto: UpdateProductDto,
  ) {
    const product = await this.prisma.product.findFirst({
      where: { id: productId, deletedAt: null },
      include: { brand: true },
    });

    if (!product) {
      throw new NotFoundException('Product not found');
    }

    if (product.brand.ownerId !== brandOwnerId) {
      throw new ForbiddenException('You can only update your own products');
    }

    const wasPublished = this.isProductPublished(product);
    const previousTags = Array.isArray(product.tags) ? product.tags : [];

    let resolvedCollectionId: string | null | undefined = undefined;
    if (dto.collectionId !== undefined) {
      const requestedCollectionId = (dto.collectionId || '').trim();
      if (requestedCollectionId) {
        const collection = await this.prisma.storeCollection.findFirst({
          where: { id: requestedCollectionId, ownerId: brandOwnerId },
          select: { id: true },
        });

        if (!collection) {
          throw new NotFoundException('Collection not found or does not belong to you');
        }

        resolvedCollectionId = requestedCollectionId;
      } else {
        resolvedCollectionId = null;
      }
    }

    let resolvedCategoryTypeId: string | null | undefined = undefined;
    if (dto.categoryTypeId !== undefined) {
      const requestedCategoryTypeId = (dto.categoryTypeId || '').trim();
      resolvedCategoryTypeId = requestedCategoryTypeId || null;
    }

    if (dto.salePrice !== undefined && dto.salePrice !== null && dto.price !== undefined) {
      if (dto.salePrice > dto.price) {
        throw new BadRequestException('salePrice cannot be greater than price');
      }
    }

    if (dto.costPerItem !== undefined && dto.costPerItem !== null && dto.price !== undefined) {
      if (dto.costPerItem > dto.price) {
        throw new BadRequestException(
          'costPerItem cannot be greater than price (negative margin)',
        );
      }
    }

    const derivedFromVariants = Array.isArray((dto as any).variants)
      ? this.computeVariantDerived((dto as any).variants)
      : null;

    const updateData: Prisma.ProductUpdateInput = {};

    // Basic info
    if (dto.name !== undefined) updateData.name = dto.name;
    
    // ===================== Item #14: Slug Immutability After Publish =====================
    // Once a product has been published (isActive=true and publishAt is in the past or null),
    // the slug cannot be changed to maintain URL stability and SEO preservation.
    if (dto.slug !== undefined) {
      const now = new Date();
      const isPublished = product.isActive && (!product.publishAt || product.publishAt <= now);
      const hasExistingSlug = !!product.slug;
      
      if (isPublished && hasExistingSlug && dto.slug !== product.slug) {
        throw new BadRequestException(
          'Slug cannot be changed after product has been published. This ensures URL stability and SEO preservation.',
        );
      }
      updateData.slug = dto.slug;
    }
    
    if (dto.description !== undefined) updateData.description = dto.description;
    if (dto.currency !== undefined) {
      updateData.currency = (dto.currency || product.currency || 'NGN').trim();
    }
    
    // Pricing
    if (dto.price !== undefined) updateData.price = new Prisma.Decimal(dto.price);
    if (dto.salePrice !== undefined)
      updateData.salePrice = dto.salePrice ? new Prisma.Decimal(dto.salePrice) : null;
    if (dto.saleStartAt !== undefined)
      updateData.saleStartAt = dto.saleStartAt ? new Date(dto.saleStartAt) : null;
    if (dto.saleEndAt !== undefined)
      updateData.saleEndAt = dto.saleEndAt ? new Date(dto.saleEndAt) : null;
    
    // Product details
    if (dto.sku !== undefined) updateData.sku = dto.sku || null;
    if (dto.weight !== undefined)
      updateData.weight = dto.weight ? new Prisma.Decimal(dto.weight) : null;
    if (dto.weightUnit !== undefined) updateData.weightUnit = dto.weightUnit;
    if (dto.materials !== undefined) updateData.materials = dto.materials || null;
    if (dto.careInstructions !== undefined) updateData.careInstructions = dto.careInstructions || null;
    if (dto.costPerItem !== undefined)
      updateData.costPerItem = dto.costPerItem ? new Prisma.Decimal(dto.costPerItem) : null;
    
    // Variants
    if (derivedFromVariants) {
      updateData.sizes = derivedFromVariants.sizes;
      updateData.colors = derivedFromVariants.colors;
      updateData.sizeStock = derivedFromVariants.sizeStock;
      updateData.colorHexCodes = derivedFromVariants.colorHexCodes;
      updateData.totalStock = derivedFromVariants.totalStock;
    } else {
      if (dto.sizes !== undefined) updateData.sizes = dto.sizes;
      if (dto.sizeStock !== undefined) updateData.sizeStock = dto.sizeStock;
      if (dto.colors !== undefined) updateData.colors = dto.colors;
      if (dto.colorImages !== undefined) updateData.colorImages = dto.colorImages;
      if (dto.colorHexCodes !== undefined) updateData.colorHexCodes = dto.colorHexCodes;
    }
    
    // Media
    if (dto.images !== undefined) {
      const normalizedImages = Array.isArray(dto.images)
        ? dto.images.filter(Boolean)
        : [];
      if (normalizedImages.length > 4) {
        throw new BadRequestException('You can upload up to 4 images');
      }

      let resolvedThumbnail: string | null = dto.thumbnail ?? null;
      if (normalizedImages.length === 0) {
        resolvedThumbnail = null;
      } else if (!resolvedThumbnail || !normalizedImages.includes(resolvedThumbnail)) {
        resolvedThumbnail = normalizedImages[0];
      }

      updateData.images = normalizedImages;
      updateData.thumbnail = resolvedThumbnail;
    } else if (dto.thumbnail !== undefined) {
      updateData.thumbnail = dto.thumbnail;
    }
    
    // Inventory
    if (dto.totalStock !== undefined) updateData.totalStock = dto.totalStock;
    if (dto.lowStockThreshold !== undefined) updateData.lowStockThreshold = dto.lowStockThreshold;
    if (dto.trackInventory !== undefined) updateData.trackInventory = dto.trackInventory;
    if (dto.allowBackorders !== undefined) updateData.allowBackorders = dto.allowBackorders;
    
    // Metadata
    const nextTags =
      dto.tags !== undefined ? this.buildTagSet(dto.tags || []) : undefined;
    if (nextTags !== undefined) updateData.tags = nextTags;
    if (dto.gender !== undefined) updateData.gender = dto.gender;
    if (resolvedCategoryTypeId !== undefined) {
      updateData.categoryType = resolvedCategoryTypeId
        ? { connect: { id: resolvedCategoryTypeId } }
        : { disconnect: true };
    }
    if (dto.isActive !== undefined) updateData.isActive = dto.isActive;
    if (dto.isFeatured !== undefined) updateData.isFeatured = dto.isFeatured;
    if (dto.isPhysicalProduct !== undefined) updateData.isPhysicalProduct = dto.isPhysicalProduct;
    if (dto.customsRegion !== undefined) updateData.customsRegion = dto.customsRegion || null;
    
    // Policies
    if (dto.returnsEligible !== undefined) updateData.returnsEligible = dto.returnsEligible;
    
    // SEO
    if (dto.metaTitle !== undefined) updateData.metaTitle = dto.metaTitle || null;
    if (dto.metaDescription !== undefined) updateData.metaDescription = dto.metaDescription || null;
    
    // Scheduling
    if (dto.publishAt !== undefined) updateData.publishAt = dto.publishAt ? new Date(dto.publishAt) : null;

    let membershipChanged = false;
    const updated = await this.prisma.$transaction(async (tx) => {
      if (resolvedCollectionId !== undefined) {
        let finalCollectionId = resolvedCollectionId;
        if (finalCollectionId === null) {
          finalCollectionId = await this.ensureDefaultStoreCollection(
            tx,
            brandOwnerId,
          );
        }

        if (finalCollectionId) {
          const existingLinks = await tx.storeCollectionProduct.findMany({
            where: { productId },
            select: { collectionId: true },
          });
          const hasLink = existingLinks.some(
            (l) => l.collectionId === finalCollectionId,
          );

          if (!hasLink) {
            if (existingLinks.length >= 3) {
              throw new ConflictException({
                code: 'COLLECTION_MAX_MEMBERSHIP',
                message: 'Product already belongs to maximum 3 collections.',
                conflictingCollectionIds: existingLinks.map(
                  (l) => l.collectionId,
                ),
              } as any);
            }

            await this.lockCollectionForUpdate(tx, finalCollectionId);
            await this.assertCollectionCapacity(tx, finalCollectionId);
            const orderIndex = await tx.storeCollectionProduct.count({
              where: { collectionId: finalCollectionId },
            });

            await tx.storeCollectionProduct.create({
              data: {
                id: uuidv4(),
                collectionId: finalCollectionId,
                productId,
                orderIndex,
              },
            });
            membershipChanged = true;
          }

          // Update the product's primary collection reference via relation
          updateData.collection = { connect: { id: finalCollectionId } };

          // Keep primary membership aligned with the explicit collectionId selection.
          await tx.storeCollectionProduct.updateMany({
            where: { productId },
            data: { isPrimary: false },
          });
          await tx.storeCollectionProduct.updateMany({
            where: { productId, collectionId: finalCollectionId },
            data: { isPrimary: true },
          });

          if (resolvedCategoryTypeId !== undefined) {
            await this.assertCategoryTypeForCollection(
              tx,
              finalCollectionId,
              resolvedCategoryTypeId,
            );
          } else if (
            dto.collectionId !== undefined &&
            finalCollectionId !== product.collectionId
          ) {
            // Reset when switching collection to avoid stale mismatched category type.
            updateData.categoryType = { disconnect: true };
          }
        }
      } else if (resolvedCategoryTypeId !== undefined) {
        await this.assertCategoryTypeForCollection(
          tx,
          product.collectionId,
          resolvedCategoryTypeId,
        );
      }

      await tx.product.update({
        where: { id: productId },
        data: updateData,
      });

      if (derivedFromVariants) {
        await tx.productVariant.deleteMany({ where: { productId } });
        if (derivedFromVariants.variants.length > 0) {
          await tx.productVariant.createMany({
            data: derivedFromVariants.variants.map((v) => ({
              id: uuidv4(),
              productId,
              size: v.size,
              color: v.color,
              sku: v.sku,
              price: v.price,
              stock: v.stock,
              colorHex: v.colorHex,
            })),
          });
        }
      }

      return tx.product.findUnique({
        where: { id: productId },
        include: {
          collections: { select: { collectionId: true, orderIndex: true } },
          brand: { select: { id: true, name: true, logo: true } },
          variants: true,
        },
      });
    });

    const shouldRecalc =
      membershipChanged ||
      dto.price !== undefined ||
      dto.salePrice !== undefined ||
      dto.saleStartAt !== undefined ||
      dto.saleEndAt !== undefined ||
      dto.isActive !== undefined ||
      dto.publishAt !== undefined ||
      (dto as any).variants !== undefined ||
      derivedFromVariants !== null;

    if (shouldRecalc) {
      const ids = Array.isArray(updated?.collections)
        ? updated.collections.map((c) => c.collectionId)
        : [];
      for (const id of ids) {
        await this.recalculateCollectionPriceRange(id);
      }
    }

    if (updated && !wasPublished && this.isProductPublished(updated)) {
      await this.notifyPatchersOfProduct(brandOwnerId, updated);
    }

    const resolvedUpdatedTags =
      nextTags ??
      this.buildTagSet(Array.isArray(updated?.tags) ? (updated?.tags as string[]) : previousTags);
    const previousIndexedTags = this.getIndexedProductTags(product, previousTags);
    const nextIndexedTags = updated
      ? this.getIndexedProductTags(
          {
            isActive: updated.isActive,
            publishAt: updated.publishAt,
            archivedAt: updated.archivedAt,
            deletedAt: updated.deletedAt,
            tags: resolvedUpdatedTags,
          },
          resolvedUpdatedTags,
        )
      : [];
    const shouldSyncIndex =
      nextTags !== undefined ||
      !this.areTagsEqual(previousIndexedTags, nextIndexedTags);

    if (this.systemTags && shouldSyncIndex) {
      await this.systemTags.syncTags(previousIndexedTags, nextIndexedTags);
      this.systemTagsCache = null;
    }
    if (this.tagIndex && shouldSyncIndex) {
      await this.tagIndex.syncEntityTags(
        TAG_ENTITY_TYPE.PRODUCT,
        productId,
        previousIndexedTags,
        nextIndexedTags,
        { maxCount: 30 },
      );
    }

    return this.attachProductMedia(updated);
  }

  async duplicateProduct(brandOwnerId: string, productId: string) {
    const product = await this.prisma.product.findFirst({
      where: { id: productId },
      include: {
        brand: true,
        variants: true,
        collections: { select: { collectionId: true, orderIndex: true } },
      },
    });

    if (!product) throw new NotFoundException('Product not found');
    if (product.brand.ownerId !== brandOwnerId) {
      throw new ForbiddenException('You can only modify your own products');
    }

    const copyName = `${product.name} (Copy)`;
    const derivedFromVariants = Array.isArray(product.variants)
      ? this.computeVariantDerived(
          product.variants.map((v: any) => ({
            size: v.size ?? undefined,
            color: v.color ?? undefined,
            sku: v.sku ?? undefined,
            price: v.price ? Number(v.price) : undefined,
            stock: v.stock ?? 0,
            colorHex: v.colorHex ?? undefined,
          })),
        )
      : null;

    const duplicated = await this.prisma.$transaction(async (tx) => {
      const sourceCollections = Array.isArray(product.collections)
        ? product.collections
        : [];
      const primaryCollectionId = sourceCollections[0]?.collectionId ?? null;

      const created = await tx.product.create({
        data: {
          id: uuidv4(),
          collectionId: primaryCollectionId,
          categoryTypeId: product.categoryTypeId ?? null,
          brandId: product.brandId,
          name: copyName,
          slug: this.generateSlug(copyName),
          description: product.description,
          currency: product.currency || product.brand.currency || 'NGN',
          price: product.price,
          salePrice: product.salePrice,
          saleStartAt: product.saleStartAt,
          saleEndAt: product.saleEndAt,
          // Product details
          sku: null, // Reset SKU for duplicate
          weight: product.weight,
          weightUnit: product.weightUnit,
          materials: product.materials,
          careInstructions: product.careInstructions,
          costPerItem: product.costPerItem,
          // Variants (legacy + derived)
          sizes: derivedFromVariants?.sizes ?? (Array.isArray(product.sizes) ? product.sizes : []),
          sizeStock: derivedFromVariants?.sizeStock ?? (product.sizeStock ?? null),
          colors: derivedFromVariants?.colors ?? (Array.isArray(product.colors) ? product.colors : []),
          colorImages: product.colorImages ?? null,
          colorHexCodes: derivedFromVariants?.colorHexCodes ?? (product.colorHexCodes ?? null),
          // Media
          images: Array.isArray(product.images) ? product.images : [],
          thumbnail: product.thumbnail,
          // Inventory
          totalStock: derivedFromVariants?.totalStock ?? product.totalStock,
          lowStockThreshold: product.lowStockThreshold,
          trackInventory: product.trackInventory,
          allowBackorders: product.allowBackorders,
          // Metadata
          tags: Array.isArray(product.tags) ? product.tags : [],
          gender: product.gender,
          isActive: false, // Start as draft
          isFeatured: false,
          isPhysicalProduct: product.isPhysicalProduct,
          customsRegion: product.customsRegion,
          // Policies
          returnsEligible: product.returnsEligible,
          // SEO - reset for duplicate
          metaTitle: null,
          metaDescription: null,
          // Reset engagement
          viewsCount: 0,
          threadsCount: 0,
        },
      });

      if (sourceCollections.length === 0) {
        const fallbackCollectionId = await this.ensureDefaultStoreCollection(
          tx,
          brandOwnerId,
        );
        await this.lockCollectionForUpdate(tx, fallbackCollectionId);
        await this.assertCollectionCapacity(tx, fallbackCollectionId);
        const orderIndex = await tx.storeCollectionProduct.count({
          where: { collectionId: fallbackCollectionId },
        });
        await tx.storeCollectionProduct.create({
          data: {
            id: uuidv4(),
            collectionId: fallbackCollectionId,
            productId: created.id,
            orderIndex,
            isPrimary: true,
          },
        });

        await tx.product.update({
          where: { id: created.id },
          data: { collectionId: fallbackCollectionId },
        });
      } else {
        for (const link of sourceCollections) {
          await this.lockCollectionForUpdate(tx, link.collectionId);
          await this.assertCollectionCapacity(tx, link.collectionId);
          const orderIndex = await tx.storeCollectionProduct.count({
            where: { collectionId: link.collectionId },
          });
          await tx.storeCollectionProduct.create({
            data: {
              id: uuidv4(),
              collectionId: link.collectionId,
              productId: created.id,
              orderIndex,
              isPrimary: link.collectionId === primaryCollectionId,
            },
          });
        }
      }

      if (derivedFromVariants && derivedFromVariants.variants.length > 0) {
        await tx.productVariant.createMany({
          data: derivedFromVariants.variants.map((v) => ({
            id: uuidv4(),
            productId: created.id,
            size: v.size,
            color: v.color,
            sku: v.sku,
            price: v.price,
            stock: v.stock,
            colorHex: v.colorHex,
          })),
        });
      }

      return tx.product.findUnique({
        where: { id: created.id },
        include: {
          collections: { select: { collectionId: true, orderIndex: true } },
          brand: { select: { id: true, name: true, logo: true, currency: true } },
          variants: true,
        },
      });
    });

    if (!duplicated) {
      throw new NotFoundException('Failed to duplicate product');
    }

    const duplicatedTags = this.getIndexedProductTags(
      {
        isActive: duplicated?.isActive,
        publishAt: duplicated?.publishAt,
        archivedAt: duplicated?.archivedAt,
        deletedAt: duplicated?.deletedAt,
        tags: duplicated?.tags as string[] | undefined,
      },
      Array.isArray(duplicated?.tags) ? (duplicated.tags as string[]) : [],
    );

    if (duplicatedTags.length > 0 && this.systemTags) {
      await this.systemTags.upsertTags(duplicatedTags);
      this.systemTagsCache = null;
    }
    if (duplicatedTags.length > 0 && this.tagIndex) {
      await this.tagIndex.syncEntityTags(
        TAG_ENTITY_TYPE.PRODUCT,
        duplicated.id,
        [],
        duplicatedTags,
        { maxCount: 30 },
      );
    }

    return this.attachProductMedia(duplicated);
  }

  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  // DELETE IMPACT CHECK
  // Returns info about what will be affected if a product is deleted
  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

  async getDeleteImpact(brandOwnerId: string, productId: string) {
    const product = await this.prisma.product.findFirst({
      where: { id: productId },
      include: { brand: true },
    });

    if (!product) {
      throw new NotFoundException('Product not found');
    }

    if (product.brand.ownerId !== brandOwnerId) {
      throw new ForbiddenException('You can only check your own products');
    }

    // Count active orders containing this product (items stored as JSON)
    // We need to query orders and check the JSON items array
    const activeOrders = await this.prisma.order.findMany({
      where: {
        brandId: product.brandId,
        status: { in: ['PENDING', 'PROCESSING', 'SHIPPED'] },
      },
      select: { items: true },
    });
    
    // Count orders that contain this product in their JSON items
    let activeOrdersCount = 0;
    for (const order of activeOrders) {
      const items = order.items as { productId: string }[] | null;
      if (Array.isArray(items) && items.some(item => item.productId === productId)) {
        activeOrdersCount++;
      }
    }

    // Count carts and wishlists
    const [inCarts, inWishlists] = await Promise.all([
      this.prisma.cartItem.count({ where: { productId } }),
      this.prisma.wishlistItem.count({ where: { productId } }),
    ]);

    const hasActiveOrders = activeOrdersCount > 0;

    return {
      productName: product.name,
      hasActiveOrders,
      activeOrdersCount,
      inCarts,
      inWishlists,
      totalViews: product.viewsCount ?? 0,
      totalThreads: product.threadsCount ?? 0,
      canDelete: !hasActiveOrders,
      mustArchiveReason: hasActiveOrders
        ? 'This product has active orders and can only be archived.'
        : undefined,
    };
  }

  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  // ARCHIVE PRODUCT
  // Sets archivedAt with 60-day auto-delete schedule
  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

  async archiveProduct(brandOwnerId: string, productId: string) {
    const product = await this.prisma.product.findFirst({
      where: { id: productId, deletedAt: null },
      include: { brand: true },
    });

    if (!product) {
      throw new NotFoundException('Product not found');
    }

    if (product.brand.ownerId !== brandOwnerId) {
      throw new ForbiddenException('You can only archive your own products');
    }

    if (product.archivedAt) {
      throw new BadRequestException('Product is already archived');
    }

    const now = new Date();
    const expiresAt = new Date(now.getTime() + 60 * 24 * 60 * 60 * 1000); // 60 days from now

    const previousIndexedTags = this.getIndexedProductTags(product, product.tags ?? []);

    const archived = await this.prisma.product.update({
      where: { id: productId },
      data: {
        archivedAt: now,
        archiveExpiresAt: expiresAt,
        archiveLastReminder: null,
        isActive: false,
      },
      include: {
        collections: { select: { collectionId: true, orderIndex: true } },
        brand: { select: { id: true, name: true, logo: true, currency: true } },
        variants: true,
      },
    });

    const archivedCollectionIds = Array.isArray(archived.collections)
      ? archived.collections.map((c) => c.collectionId)
      : [];
    for (const id of archivedCollectionIds) {
      await this.recalculateCollectionPriceRange(id);
    }

    if (previousIndexedTags.length > 0 && this.systemTags) {
      await this.systemTags.syncTags(previousIndexedTags, []);
      this.systemTagsCache = null;
    }
    if (previousIndexedTags.length > 0 && this.tagIndex) {
      await this.tagIndex.syncEntityTags(
        TAG_ENTITY_TYPE.PRODUCT,
        productId,
        previousIndexedTags,
        [],
        { maxCount: 30 },
      );
    }

    return this.attachProductMedia(archived);
  }

  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  // UNARCHIVE PRODUCT
  // Restores product and clears archive schedule
  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

  async unarchiveProduct(brandOwnerId: string, productId: string) {
    const product = await this.prisma.product.findFirst({
      where: { id: productId, deletedAt: null },
      include: { brand: true },
    });

    if (!product) {
      throw new NotFoundException('Product not found');
    }

    if (product.brand.ownerId !== brandOwnerId) {
      throw new ForbiddenException('You can only unarchive your own products');
    }

    if (!product.archivedAt) {
      throw new BadRequestException('Product is not archived');
    }

    const previousIndexedTags = this.getIndexedProductTags(product, product.tags ?? []);

    const restored = await this.prisma.product.update({
      where: { id: productId },
      data: {
        archivedAt: null,
        archiveExpiresAt: null,
        archiveLastReminder: null,
        // Keep isActive as false - user should manually publish
      },
      include: {
        collections: { select: { collectionId: true, orderIndex: true } },
        brand: { select: { id: true, name: true, logo: true, currency: true } },
        variants: true,
      },
    });

    const restoredCollectionIds = Array.isArray(restored.collections)
      ? restored.collections.map((c) => c.collectionId)
      : [];
    for (const id of restoredCollectionIds) {
      await this.recalculateCollectionPriceRange(id);
    }

    const nextIndexedTags = this.getIndexedProductTags(restored, restored.tags ?? []);
    if (this.systemTags && !this.areTagsEqual(previousIndexedTags, nextIndexedTags)) {
      await this.systemTags.syncTags(previousIndexedTags, nextIndexedTags);
      this.systemTagsCache = null;
    }
    if (this.tagIndex && !this.areTagsEqual(previousIndexedTags, nextIndexedTags)) {
      await this.tagIndex.syncEntityTags(
        TAG_ENTITY_TYPE.PRODUCT,
        productId,
        previousIndexedTags,
        nextIndexedTags,
        { maxCount: 30 },
      );
    }

    return this.attachProductMedia(restored);
  }

  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  // TOGGLE FEATURED
  // Toggles the isFeatured flag on a product
  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

  async toggleFeatured(brandOwnerId: string, productId: string) {
    const product = await this.prisma.product.findFirst({
      where: { id: productId, deletedAt: null },
      include: { brand: true },
    });

    if (!product) {
      throw new NotFoundException('Product not found');
    }

    if (product.brand.ownerId !== brandOwnerId) {
      throw new ForbiddenException('You can only modify your own products');
    }

    const updated = await this.prisma.product.update({
      where: { id: productId },
      data: { isFeatured: !product.isFeatured },
      include: {
        collections: { select: { collectionId: true, orderIndex: true } },
        brand: { select: { id: true, name: true, logo: true, currency: true } },
        variants: true,
      },
    });

    return this.attachProductMedia(updated);
  }

  async deleteProduct(
    brandOwnerId: string,
    productId: string,
    cancelPendingOrders = false,
  ) {
    const product = await this.prisma.product.findFirst({
      where: { id: productId },
      include: { 
        brand: true,
        collections: {
          include: {
            collection: { select: { id: true, title: true } },
          },
        },
      },
    });

    if (!product) {
      throw new NotFoundException('Product not found');
    }

    if (product.brand.ownerId !== brandOwnerId) {
      throw new ForbiddenException('You can only delete your own products');
    }

    const previousIndexedTags = this.getIndexedProductTags(product, product.tags ?? []);

    // Check for active orders containing this product (items stored as JSON)
    const activeOrders = await this.prisma.order.findMany({
      where: {
        brandId: product.brandId,
        status: { in: ['PENDING', 'PROCESSING', 'SHIPPED'] },
      },
      select: { items: true },
    });
    
    let activeOrdersCount = 0;
    for (const order of activeOrders) {
      const items = order.items as { productId: string }[] | null;
      if (Array.isArray(items) && items.some(item => item.productId === productId)) {
        activeOrdersCount++;
      }
    }

    if (activeOrdersCount > 0 && !cancelPendingOrders) {
      throw new BadRequestException(
        'Cannot delete product with active orders. Pass cancelPendingOrders=true to cancel pending orders and refund.',
      );
    }

    const memberships = await this.prisma.storeCollectionProduct.findMany({
      where: { productId },
      select: { collectionId: true },
    });

    // Get affected collection titles for notification
    const affectedCollections = (product.collections || [])
      .map((c) => c.collection?.title || 'Untitled')
      .filter(Boolean);

    const cancelledOrders: { id: string; buyerId?: string | null }[] = [];

    await this.prisma.$transaction(async (tx) => {
      if (activeOrdersCount > 0 && cancelPendingOrders) {
        const orders = await tx.order.findMany({
          where: {
            brandId: product.brandId,
            status: { in: ['PENDING', 'PROCESSING', 'SHIPPED'] as any },
          },
          select: { id: true, buyerId: true, items: true },
        });

        for (const order of orders) {
          const items = order.items as { productId?: string }[] | null;
          if (!Array.isArray(items)) continue;
          if (items.some((item) => item.productId === productId)) {
            await tx.order.update({
              where: { id: order.id },
              data: { status: 'CANCELLED', paymentStatus: 'REFUNDED' },
            });
            cancelledOrders.push({ id: order.id, buyerId: order.buyerId });
          }
        }
      }

      await tx.storeCollectionProduct.deleteMany({ where: { productId } });
      await tx.product.update({
        where: { id: productId },
        data: { deletedAt: new Date(), isActive: false, collectionId: null },
      });
      await tx.cartItem.deleteMany({ where: { productId } });
      await tx.wishlistItem.deleteMany({ where: { productId } });
    });

    if (cancelledOrders.length > 0) {
      for (const order of cancelledOrders) {
        if (!order.buyerId) continue;
        try {
          await this.notifications?.create(
            order.buyerId,
            NotificationType.ORDER_STATUS_UPDATED,
            {
              payload: {
                orderId: order.id,
                status: 'CANCELLED',
                reason: 'Product deleted by brand',
                refundStatus: 'REFUNDED',
              },
            },
          );
        } catch (error) {
          console.warn('Failed to notify buyer about cancellation', error);
        }
      }

      console.warn('[AdminNotice] Cancelled orders due to product deletion', {
        productId,
        orderIds: cancelledOrders.map((o) => o.id),
      });
    }

    for (const link of memberships) {
      await this.recalculateCollectionPriceRange(link.collectionId);
    }

    if (previousIndexedTags.length > 0 && this.systemTags) {
      await this.systemTags.syncTags(previousIndexedTags, []);
      this.systemTagsCache = null;
    }
    if (previousIndexedTags.length > 0 && this.tagIndex) {
      await this.tagIndex.syncEntityTags(
        TAG_ENTITY_TYPE.PRODUCT,
        productId,
        previousIndexedTags,
        [],
        { maxCount: 30 },
      );
    }

    // Send notification if product was in collections
    if (affectedCollections.length > 0) {
      try {
        await this.prisma.$queryRaw`SELECT 1`; // Verify DB connection
        // Note: Notification service would be injected in production
        // For now, log the notification that should be sent
        console.log('[ProductDeletion] Notification would be sent:', {
          recipientId: brandOwnerId,
          type: 'PRODUCT_DELETED_FROM_COLLECTION',
          payload: {
            productName: product.name,
            affectedCollections,
            targetUrl: '/studio/products?view=deleted',
          },
        });
      } catch (e) {
        // Non-blocking notification error
        console.error('[ProductDeletion] Failed to send notification:', e);
      }
    }

    return { 
      success: true, 
      message: 'Product deleted',
      affectedCollections,
    };
  }

  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  // PRICE CHANGE PREVIEW
  // Preview how a product price change will affect collection price ranges
  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

  async getProductPriceChangePreview(
    brandOwnerId: string,
    productId: string,
    newPrice: number,
    newSalePrice?: number,
  ) {
    const product = await this.prisma.product.findFirst({
      where: { id: productId, deletedAt: null },
      include: { brand: true },
    });

    if (!product) {
      throw new NotFoundException('Product not found');
    }

    if (product.brand.ownerId !== brandOwnerId) {
      throw new ForbiddenException('You can only preview your own products');
    }

    // Get all collections this product belongs to
    const memberships = await this.prisma.storeCollectionProduct.findMany({
      where: { productId },
      include: {
        collection: {
          select: { 
            id: true, 
            title: true, 
            minPrice: true, 
            maxPrice: true,
            saleMinPrice: true,
            saleMaxPrice: true,
          },
        },
      },
    });

    const affectedCollections: any[] = [];

    const collectionIds = memberships.map((m) => m.collectionId);
    const linksByCollection = new Map<string, Array<{
      productId: string;
      product: {
        id: string;
        price: any;
        salePrice: any;
        isActive: boolean;
        deletedAt: Date | null;
        archivedAt: Date | null;
      } | null;
    }>>();

    if (collectionIds.length > 0) {
      const links = await this.prisma.storeCollectionProduct.findMany({
        where: { collectionId: { in: collectionIds } },
        include: {
          product: {
            select: {
              id: true,
              price: true,
              salePrice: true,
              isActive: true,
              deletedAt: true,
              archivedAt: true,
            },
          },
        },
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
      // Get all products in this collection
      const links = linksByCollection.get(m.collectionId) ?? [];

      // Calculate new price range
      const activePrices = links
        .filter(l => l.product && l.product.isActive && !l.product.deletedAt && !l.product.archivedAt)
        .map((l) => l.productId === productId ? newPrice : Number(l.product?.price || 0))
        .filter((p) => p > 0);

      const activeSalePrices = links
        .filter(l => l.product && l.product.isActive && !l.product.deletedAt && !l.product.archivedAt)
        .map((l) => {
          if (l.productId === productId) return newSalePrice || null;
          return l.product?.salePrice ? Number(l.product.salePrice) : null;
        })
        .filter((p): p is number => p !== null && p > 0);

      const newMinPrice = activePrices.length > 0 ? Math.min(...activePrices) : null;
      const newMaxPrice = activePrices.length > 0 ? Math.max(...activePrices) : null;
      const newSaleMinPrice = activeSalePrices.length > 0 ? Math.min(...activeSalePrices) : null;
      const newSaleMaxPrice = activeSalePrices.length > 0 ? Math.max(...activeSalePrices) : null;

      affectedCollections.push({
        collectionId: m.collection.id,
        collectionTitle: m.collection.title || 'Untitled',
        currentMinPrice: m.collection.minPrice,
        currentMaxPrice: m.collection.maxPrice,
        currentSaleMinPrice: m.collection.saleMinPrice,
        currentSaleMaxPrice: m.collection.saleMaxPrice,
        newMinPrice,
        newMaxPrice,
        newSaleMinPrice,
        newSaleMaxPrice,
        priceRangeChanged:
          m.collection.minPrice !== newMinPrice ||
          m.collection.maxPrice !== newMaxPrice,
        saleRangeChanged:
          m.collection.saleMinPrice !== newSaleMinPrice ||
          m.collection.saleMaxPrice !== newSaleMaxPrice,
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
      currentSalePrice: product.salePrice ? Number(product.salePrice) : null,
      newSalePrice: newSalePrice || null,
      affectedCollections,
      collectionsAffectedCount: affectedCollections.filter(c => c.priceRangeChanged || c.saleRangeChanged).length,
    };
  }

  async permanentlyDeleteProduct(brandOwnerId: string, productId: string) {
    const product = await this.prisma.product.findFirst({
      where: { id: productId },
      include: { brand: true },
    });

    if (!product) {
      throw new NotFoundException('Product not found');
    }

    if (product.brand.ownerId !== brandOwnerId) {
      throw new ForbiddenException('You can only delete your own products');
    }

    if (!product.deletedAt) {
      throw new BadRequestException('Product must be deleted before permanent removal');
    }

    const previousIndexedTags = this.getIndexedProductTags(product, product.tags ?? []);

    await this.prisma.$transaction(async (tx) => {
      await tx.cartItem.deleteMany({ where: { productId } });
      await tx.wishlistItem.deleteMany({ where: { productId } });
      await tx.productVariant.deleteMany({ where: { productId } });
      await tx.product.delete({ where: { id: productId } });
    });

    if (previousIndexedTags.length > 0 && this.systemTags) {
      await this.systemTags.syncTags(previousIndexedTags, []);
      this.systemTagsCache = null;
    }
    if (previousIndexedTags.length > 0 && this.tagIndex) {
      await this.tagIndex.syncEntityTags(
        TAG_ENTITY_TYPE.PRODUCT,
        productId,
        previousIndexedTags,
        [],
        { maxCount: 30 },
      );
    }

    return { success: true, message: 'Product permanently deleted' };
  }

  async getProduct(productId: string, userId?: string, includeDeleted = false) {
    // Optimized: Include wishlist check in same query when user is authenticated
    const product = await this.prisma.product.findFirst({
      where: includeDeleted ? { id: productId } : { id: productId, deletedAt: null },
      include: {
        collection: {
          select: {
            id: true,
            title: true,
            description: true,
            status: true,
            isAvailableInStore: true,
          },
        },
        collections: {
          select: {
            collectionId: true,
            orderIndex: true,
            collection: {
              select: {
                id: true,
                title: true,
                description: true,
                status: true,
                isAvailableInStore: true,
              },
            },
          },
        },
        brand: {
          select: {
            id: true,
            name: true,
            logo: true,
            currency: true,
            ownerId: true,
            isStoreOpen: true,
          },
        },
        // Inline wishlist check - avoids separate query
        wishlistItems: userId
          ? { where: { userId }, take: 1, select: { id: true } }
          : false,
        variants: true,
      },
    });

    if (!product) {
      throw new NotFoundException('Product not found');
    }

    const isOwner = userId && product.brand.ownerId === userId;

    if (product.deletedAt && includeDeleted && !isOwner) {
      throw new ForbiddenException('You can only view your own deleted products');
    }

    // Store gating: brand must be open, collection must be store-enabled and published for non-owners
    if (!isOwner) {
      if (!product.brand.isStoreOpen) {
        throw new NotFoundException('Store is closed');
      }
      const hasStoreCollection = Array.isArray(product.collections)
        ? product.collections.some(
            (link: any) =>
              link.collection?.isAvailableInStore &&
              link.collection?.status === 'PUBLISHED',
          )
        : false;
      if (!hasStoreCollection) {
        throw new NotFoundException('Product not available');
      }
    }

    // Check if user has wishlisted (from inline query)
    const isWishlisted = Array.isArray(product.wishlistItems) && product.wishlistItems.length > 0;

    // Buffered view counting (process-local).
    this.viewCounter.increment(productId);

    // Remove wishlistItems from response (internal use only)
    const { wishlistItems, ...productData } = product;
    const withMedia = await this.attachProductMedia(productData);
    return { ...withMedia, isWishlisted };
  }

  async getBrandProducts(
    brandId: string,
    options: {
      page?: number;
      limit?: number;
      cursor?: string;
      collectionId?: string;
      isActive?: boolean;
      category?: string;
      gender?: string;
      minPrice?: number;
      maxPrice?: number;
      sizes?: string[];
      colors?: string[];
      tags?: string[];
      onSale?: boolean;
      isFeatured?: boolean;
      sortBy?: 'newest' | 'price_asc' | 'price_desc' | 'popular';
      search?: string;
      requesterId?: string;
      includeDeleted?: boolean;
      onlyDeleted?: boolean;
    } = {},
  ) {
    const {
      page = 1,
      limit = 20,
      cursor,
      collectionId,
      isActive,
      category,
      gender,
      minPrice,
      maxPrice,
      sizes,
      colors,
      tags,
      onSale,
      isFeatured,
      sortBy = 'newest',
      search,
      requesterId,
      includeDeleted,
      onlyDeleted,
    } = options;

    const safePage = Math.max(1, Number(page) || 1);
    const safeLimit = Math.min(100, Math.max(1, Number(limit) || 20));

    const brand = await this.resolveBrandByIdOrOwner(brandId);
    if (!brand) {
      throw new NotFoundException('Store not found');
    }

    const isOwner = requesterId && brand.ownerId === requesterId;

    // Gate by brand store state for non-owners
    if (!isOwner && !brand.isStoreOpen) {
      throw new NotFoundException('Store is closed');
    }

    if (isOwner) {
      const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
      await this.prisma.product.deleteMany({
        where: {
          brandId: brand.id,
          isActive: false,
          archivedAt: null,
          deletedAt: null,
          createdAt: { lt: ninetyDaysAgo },
        },
      });
    }

    // Build where clause - owners see all products, public sees only active/published
    const where: Prisma.ProductWhereInput = {
      brandId: brand.id,
    };

    const andFilters: Prisma.ProductWhereInput[] = [];

    if (isOwner) {
      // Owner preview: show all products including inactive
      // Optionally filter by collection status if needed
      if (collectionId) {
        andFilters.push({
          collections: { some: { collectionId } },
        });
      }
      if (typeof isActive === 'boolean') {
        where.isActive = isActive;
      }
      if (onlyDeleted) {
        where.deletedAt = { not: null };
      } else if (!includeDeleted) {
        where.deletedAt = null;
      }
    } else {
      // Public: only active products in published, store-enabled collections
      where.isActive = true;
      where.deletedAt = null;
      andFilters.push({
        collections: {
          some: {
            collection: {
              status: 'PUBLISHED',
              isAvailableInStore: true,
            },
          },
        },
      });
    }

    // Gender filter
    if (
      gender &&
      ['MALE', 'FEMALE', 'EVERYBODY'].includes(gender.toUpperCase())
    ) {
      where.gender = gender.toUpperCase() as CollectionType;
    }

    // Price range filter
    if (minPrice !== undefined || maxPrice !== undefined) {
      where.price = {};
      if (minPrice !== undefined) where.price.gte = minPrice;
      if (maxPrice !== undefined) where.price.lte = maxPrice;
    }

    // Size filter (any matching)
    if (sizes && sizes.length > 0) {
      where.sizes = { hasSome: sizes };
    }

    // Color filter (any matching)
    if (colors && colors.length > 0) {
      where.colors = { hasSome: colors };
    }

    // Tags filter (any matching)
    if (tags && tags.length > 0) {
      const normalized = this.buildTagSet(tags);
      if (normalized.length > 0) {
        where.tags = { hasSome: normalized };
      }
    }

    // Featured filter
    if (typeof isFeatured === 'boolean') {
      where.isFeatured = isFeatured;
    }

    // On sale filter
    if (onSale) {
      const now = new Date();
      andFilters.push({
        salePrice: { not: null },
        OR: [
          { saleStartAt: null, saleEndAt: null },
          { saleStartAt: { lte: now }, saleEndAt: { gte: now } },
          { saleStartAt: { lte: now }, saleEndAt: null },
          { saleStartAt: null, saleEndAt: { gte: now } },
        ],
      });
    }

    // Search filter
    if (search) {
      const normalizedSearch = this.normalizeTag(search).toLowerCase();
      andFilters.push({
        OR: [
          { name: { contains: search, mode: 'insensitive' } },
          { description: { contains: search, mode: 'insensitive' } },
          ...(normalizedSearch
            ? [{ tags: { hasSome: [normalizedSearch] } }]
            : []),
        ],
      });
    }

    if (andFilters.length > 0) {
      const existingAnd = Array.isArray(where.AND)
        ? where.AND
        : where.AND
          ? [where.AND]
          : [];
      where.AND = [...existingAnd, ...andFilters];
    }

    // Category filter via collection memberships
    if (category) {
      andFilters.push({
        collections: {
          some: {
            collection: { category: { slug: category } },
          },
        },
      });
    }

    // Sorting (stable; include id tie-breaker for cursor pagination)
    let orderBy: any = [{ createdAt: 'desc' }, { id: 'desc' }];
    switch (sortBy) {
      case 'price_asc':
        orderBy = [{ price: 'asc' }, { id: 'asc' }];
        break;
      case 'price_desc':
        orderBy = [{ price: 'desc' }, { id: 'desc' }];
        break;
      case 'popular':
        orderBy = [{ viewsCount: 'desc' }, { id: 'desc' }];
        break;
      default:
        orderBy = [{ createdAt: 'desc' }, { id: 'desc' }];
    }

    const useCursor = typeof cursor === 'string' && cursor.trim().length > 0;
    const skipValue = useCursor ? 1 : (safePage - 1) * safeLimit;

    const [products, total] = await Promise.all([
      this.prisma.product.findMany({
        where,
        orderBy,
        ...(useCursor ? { cursor: { id: cursor.trim() } } : {}),
        skip: skipValue,
        take: safeLimit,
        include: {
          collection: {
            select: {
              id: true,
              title: true,
              status: true,
              isAvailableInStore: true,
            },
          },
          collections: { select: { collectionId: true, orderIndex: true } },
          brand: {
            select: { id: true, name: true, logo: true, currency: true },
          },
        },
      }),
      this.prisma.product.count({ where }),
    ]);

    const nextCursor = products.length > 0 ? products[products.length - 1].id : null;

    const baseItems = products.map((p) => this.transformProduct(p));
    const urls = Array.from(
      new Set(
        baseItems
          .flatMap((p) => (Array.isArray((p as any).images) ? (p as any).images : []))
          .filter((u) => typeof u === 'string' && u.length > 0),
      ),
    );

    let idByUrl = new Map<string, string>();
    if (urls.length > 0) {
      const uploads = await this.prisma.fileUpload.findMany({
        where: { s3Url: { in: urls } },
        select: { id: true, s3Url: true },
      });
      idByUrl = new Map(uploads.map((u) => [u.s3Url, u.id]));
    }

    const itemsWithMedia = baseItems.map((base: any) => {
      const images: string[] = Array.isArray(base.images) ? base.images.filter(Boolean) : [];
      if (images.length === 0) {
        return { ...base, media: [], mediaIds: [] };
      }
      const media = images.map((url: string) => ({
        id: idByUrl.get(url) ?? url,
        url,
        type: 'image',
        isPrimary: !!base.thumbnail && url === base.thumbnail,
      }));
      return {
        ...base,
        media,
        mediaIds: media.map((m) => m.id),
      };
    });

    return {
      items: itemsWithMedia,
      total,
      page: safePage,
      limit: safeLimit,
      totalPages: Math.ceil(total / safeLimit),
      hasNextPage: safePage * safeLimit < total,
      nextCursor,
    };
  }

  async restoreProduct(brandOwnerId: string, productId: string) {
    const product = await this.prisma.product.findFirst({
      where: { id: productId },
      include: { brand: true },
    });

    if (!product) {
      throw new NotFoundException('Product not found');
    }

    if (product.brand.ownerId !== brandOwnerId) {
      throw new ForbiddenException('You can only restore your own products');
    }

    if (!product.deletedAt) {
      throw new BadRequestException('Product is not deleted');
    }

    const previousIndexedTags = this.getIndexedProductTags(product, product.tags ?? []);

    const restored = await this.prisma.product.update({
      where: { id: productId },
      data: { deletedAt: null, isActive: false },
      include: {
        collections: { select: { collectionId: true, orderIndex: true } },
        brand: { select: { id: true, name: true, logo: true, currency: true } },
        variants: true,
      },
    });

    const nextIndexedTags = this.getIndexedProductTags(restored, restored.tags ?? []);
    if (this.systemTags && !this.areTagsEqual(previousIndexedTags, nextIndexedTags)) {
      await this.systemTags.syncTags(previousIndexedTags, nextIndexedTags);
      this.systemTagsCache = null;
    }
    if (this.tagIndex && !this.areTagsEqual(previousIndexedTags, nextIndexedTags)) {
      await this.tagIndex.syncEntityTags(
        TAG_ENTITY_TYPE.PRODUCT,
        productId,
        previousIndexedTags,
        nextIndexedTags,
        { maxCount: 30 },
      );
    }

    return this.attachProductMedia(restored);
  }

  // ==================== CART ====================

  async addToCart(userId: string, dto: AddToCartDto) {
    const product = await this.prisma.product.findFirst({
      where: {
        id: dto.productId,
        deletedAt: null,
        isActive: true,
        brand: { isStoreOpen: true },
        collections: {
          some: {
            collection: { isAvailableInStore: true, status: 'PUBLISHED' },
          },
        },
      },
      include: {
        variants: true,
        brand: { select: { ownerId: true } },
      },
    });

    if (!product) {
      throw new NotFoundException('Product not found or unavailable');
    }
    const resolvedBrandOwnerId =
      product.brand?.ownerId ??
      (
        await this.prisma.brand.findUnique({
          where: { id: product.brandId },
          select: { ownerId: true },
        })
      )?.ownerId;

    if (resolvedBrandOwnerId === userId || product.brandId === userId) {
      throw new ForbiddenException(
        'You cannot add your own product to cart',
      );
    }

    const variants = Array.isArray((product as any).variants)
      ? ((product as any).variants as any[])
      : [];
    const hasVariantSizes = variants.some((v) => v.size);
    const hasVariantColors = variants.some((v) => v.color);

    // Validate size
    if ((hasVariantSizes || product.sizes.length > 0) && !dto.selectedSize) {
      throw new BadRequestException('Please select a size');
    }
    if (dto.selectedSize && !product.sizes.includes(dto.selectedSize)) {
      throw new BadRequestException('Invalid size selected');
    }

    // Validate color
    if ((hasVariantColors || product.colors.length > 0) && !dto.selectedColor) {
      throw new BadRequestException('Please select a color');
    }
    if (dto.selectedColor && !product.colors.includes(dto.selectedColor)) {
      throw new BadRequestException('Invalid color selected');
    }

    const existingItem = await this.prisma.cartItem.findFirst({
      where: {
        userId,
        productId: dto.productId,
        selectedSize: dto.selectedSize || null,
        selectedColor: dto.selectedColor || null,
      },
    });

    const quantityToAdd = dto.quantity || 1;
    const resultingQuantity = existingItem
      ? existingItem.quantity + quantityToAdd
      : quantityToAdd;

    if (resultingQuantity > 99) {
      throw new BadRequestException(
        'Cart quantity limit exceeded for this item (max 99)',
      );
    }

    // Check stock (variant-aware)
    if (product.trackInventory && !product.allowBackorders) {
      if (variants.length > 0) {
        const match = variants.find(
          (v) =>
            (v.size || null) === (dto.selectedSize || null) &&
            (v.color || null) === (dto.selectedColor || null),
        );
        if (!match) {
          throw new BadRequestException('Selected variant is not available');
        }
        const available = Number(match.stock || 0);
        if (available < resultingQuantity) {
          throw new BadRequestException(
            `Only ${available} items available for the selected variant`,
          );
        }
      } else if (dto.selectedSize && product.sizeStock) {
        const sizeStock = product.sizeStock as Record<string, number>;
        const available = sizeStock[dto.selectedSize] || 0;
        if (available < resultingQuantity) {
          throw new BadRequestException(
            `Only ${available} items available in size ${dto.selectedSize}`,
          );
        }
      } else if (product.totalStock < resultingQuantity) {
        throw new BadRequestException(`Only ${product.totalStock} items available`);
      }
    }

    if (existingItem) {
      await this.prisma.cartItem.update({
        where: { id: existingItem.id },
        data: { quantity: resultingQuantity },
      });
    } else {
      await this.prisma.cartItem.create({
        data: {
          id: uuidv4(),
          userId,
          productId: dto.productId,
          quantity: quantityToAdd,
          selectedSize: dto.selectedSize || null,
          selectedColor: dto.selectedColor || null,
        },
      });
    }

    return this.getCart(userId);
  }

  async getCart(userId: string) {
    const items = await this.prisma.cartItem.findMany({
      where: { userId },
      include: {
        product: {
          include: {
            brand: {
              select: {
                id: true,
                name: true,
                currency: true,
                isStoreOpen: true,
                ownerId: true,
              },
            },
            collections: {
              select: {
                collectionId: true,
                collection: { select: { id: true, status: true, isAvailableInStore: true } },
              },
            },
            variants: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    const unavailableItemIds: string[] = [];
    const availableItems = items.filter((item) => {
      const product = item.product;
      if (!product) {
        unavailableItemIds.push(item.id);
        return false;
      }

      const hasStoreCollection = Array.isArray(product.collections)
        ? product.collections.some(
            (link: any) =>
              link.collection?.isAvailableInStore &&
              link.collection?.status === 'PUBLISHED',
          )
        : false;

      const isProductAvailable =
        !product.deletedAt &&
        product.isActive &&
        Boolean(product.brand?.isStoreOpen) &&
        product.brand?.ownerId !== userId &&
        hasStoreCollection;

      if (!isProductAvailable) {
        unavailableItemIds.push(item.id);
        return false;
      }

      if (product.trackInventory && !product.allowBackorders) {
        const variants = Array.isArray((product as any).variants)
          ? ((product as any).variants as any[])
          : [];
        if (variants.length > 0) {
          const match = variants.find(
            (v) =>
              (v.size || null) === (item.selectedSize || null) &&
              (v.color || null) === (item.selectedColor || null),
          );
          const available = Number(match?.stock || 0);
          if (!match || available <= 0) {
            unavailableItemIds.push(item.id);
            return false;
          }
        } else if (item.selectedSize && product.sizeStock) {
          const sizeStock = product.sizeStock as Record<string, number>;
          const available = sizeStock[item.selectedSize] || 0;
          if (available <= 0) {
            unavailableItemIds.push(item.id);
            return false;
          }
        } else if (product.totalStock <= 0) {
          unavailableItemIds.push(item.id);
          return false;
        }
      }

      return true;
    });

    if (unavailableItemIds.length > 0) {
      await this.prisma.cartItem.deleteMany({ where: { id: { in: unavailableItemIds } } });
    }

    const cartItems = availableItems.map((item) => {
      const product = item.product;
      const isOnSale = this.isProductOnSale(product);

      const variants = Array.isArray((product as any).variants)
        ? ((product as any).variants as any[])
        : [];
      const selectedVariant =
        variants.length > 0
          ? variants.find(
              (v) =>
                (v.size || null) === (item.selectedSize || null) &&
                (v.color || null) === (item.selectedColor || null),
            )
          : null;

      const basePrice = selectedVariant?.price
        ? Number(selectedVariant.price)
        : Number(product.price);

      const effectivePrice =
        selectedVariant?.price
          ? basePrice
          : isOnSale && product.salePrice
            ? Number(product.salePrice)
            : basePrice;

      return {
        id: item.id,
        productId: item.productId,
        quantity: item.quantity,
        selectedSize: item.selectedSize,
        selectedColor: item.selectedColor,
        product: {
          id: product.id,
          name: product.name,
          thumbnail: product.thumbnail,
          price: Number(product.price),
          salePrice: product.salePrice ? Number(product.salePrice) : null,
          isOnSale,
          effectivePrice,
          sizes: product.sizes,
          colors: product.colors,
          totalStock: product.totalStock,
          sizeStock: product.sizeStock,
          currency: product.currency || item.product.brand.currency || 'NGN',
          variants: variants.map((v) => ({
            id: v.id,
            size: v.size,
            color: v.color,
            sku: v.sku,
            price: v.price ? Number(v.price) : null,
            stock: v.stock,
            colorHex: v.colorHex,
          })),
        },
        brand: item.product.brand,
        itemTotal: effectivePrice * item.quantity,
      };
    });

    const subtotal = cartItems.reduce((sum, item) => sum + item.itemTotal, 0);

    return {
      items: cartItems,
      itemCount: cartItems.length,
      totalQuantity: cartItems.reduce((sum, item) => sum + item.quantity, 0),
      subtotal,
      currency: cartItems[0]?.brand?.currency || 'NGN',
    };
  }

  async updateCartItem(
    userId: string,
    cartItemId: string,
    dto: UpdateCartItemDto,
  ) {
    const item = await this.prisma.cartItem.findFirst({
      where: { id: cartItemId, userId },
      include: { product: { include: { variants: true } } },
    });

    if (!item) {
      throw new NotFoundException('Cart item not found');
    }

    // Check stock (variant-aware)
    if (item.product.trackInventory && !item.product.allowBackorders) {
      const variants = Array.isArray((item.product as any).variants)
        ? ((item.product as any).variants as any[])
        : [];

      if (variants.length > 0) {
        const match = variants.find(
          (v) =>
            (v.size || null) === (item.selectedSize || null) &&
            (v.color || null) === (item.selectedColor || null),
        );
        if (!match) {
          throw new BadRequestException('Selected variant is not available');
        }
        const available = Number(match.stock || 0);
        if (available < dto.quantity) {
          throw new BadRequestException(`Only ${available} items available`);
        }
      } else if (item.selectedSize && item.product.sizeStock) {
        const sizeStock = item.product.sizeStock as Record<string, number>;
        const available = sizeStock[item.selectedSize] || 0;
        if (available < dto.quantity) {
          throw new BadRequestException(`Only ${available} items available`);
        }
      } else if (item.product.totalStock < dto.quantity) {
        throw new BadRequestException(
          `Only ${item.product.totalStock} items available`,
        );
      }
    }

    await this.prisma.cartItem.update({
      where: { id: cartItemId },
      data: { quantity: dto.quantity },
    });

    return this.getCart(userId);
  }

  async removeFromCart(userId: string, cartItemId: string) {
    const item = await this.prisma.cartItem.findFirst({
      where: { id: cartItemId, userId },
    });

    if (!item) {
      throw new NotFoundException('Cart item not found');
    }

    await this.prisma.cartItem.delete({ where: { id: cartItemId } });
    return this.getCart(userId);
  }

  async clearCart(userId: string) {
    await this.prisma.cartItem.deleteMany({ where: { userId } });
    return { success: true, message: 'Cart cleared' };
  }

  // ==================== WISHLIST ====================

  async addToWishlist(userId: string, dto: AddToWishlistDto) {
    const product = await this.prisma.product.findFirst({
      where: {
        id: dto.productId,
        deletedAt: null,
        isActive: true,
        brand: { isStoreOpen: true },
        collections: {
          some: {
            collection: { isAvailableInStore: true, status: 'PUBLISHED' },
          },
        },
      },
      include: {
        brand: {
          select: {
            ownerId: true,
          },
        },
      },
    });

    if (!product) {
      throw new NotFoundException('Product not found');
    }
    if (product.brand?.ownerId === userId) {
      throw new ForbiddenException(
        'You cannot add your own product to wishlist',
      );
    }

    // Check if already in wishlist
    const existing = await this.prisma.wishlistItem.findUnique({
      where: { userId_productId: { userId, productId: dto.productId } },
    });

    if (existing) {
      return {
        success: true,
        message: 'Already in wishlist',
        isWishlisted: true,
      };
    }

    await this.prisma.wishlistItem.create({
      data: {
        id: uuidv4(),
        userId,
        productId: dto.productId,
      },
    });

    return { success: true, message: 'Added to wishlist', isWishlisted: true };
  }

  async removeFromWishlist(userId: string, productId: string) {
    const item = await this.prisma.wishlistItem.findUnique({
      where: { userId_productId: { userId, productId } },
    });

    if (!item) {
      throw new NotFoundException('Item not in wishlist');
    }

    await this.prisma.wishlistItem.delete({
      where: { userId_productId: { userId, productId } },
    });

    return {
      success: true,
      message: 'Removed from wishlist',
      isWishlisted: false,
    };
  }

  async getWishlist(userId: string, page = 1, limit = 20) {
    const [items, total] = await Promise.all([
      this.prisma.wishlistItem.findMany({
        where: { userId },
        include: {
          product: {
            include: {
              brand: {
                select: {
                  id: true,
                  name: true,
                  logo: true,
                  currency: true,
                  isStoreOpen: true,
                  ownerId: true,
                },
              },
              collections: {
                select: {
                  collectionId: true,
                  collection: { select: { id: true, status: true, isAvailableInStore: true } },
                },
              },
              variants: true,
            },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.wishlistItem.count({ where: { userId } }),
    ]);

    const unavailableWishlistIds: string[] = [];
    const availableWishlistItems = items.filter((item) => {
      const product = item.product;
      if (!product) {
        unavailableWishlistIds.push(item.id);
        return false;
      }

      const hasStoreCollection = Array.isArray(product.collections)
        ? product.collections.some(
            (link: any) =>
              link.collection?.isAvailableInStore &&
              link.collection?.status === 'PUBLISHED',
          )
        : false;

      const isProductAvailable =
        !product.deletedAt &&
        product.isActive &&
        Boolean(product.brand?.isStoreOpen) &&
        product.brand?.ownerId !== userId &&
        hasStoreCollection;

      if (!isProductAvailable) {
        unavailableWishlistIds.push(item.id);
        return false;
      }

      if (product.trackInventory && !product.allowBackorders && product.totalStock <= 0) {
        unavailableWishlistIds.push(item.id);
        return false;
      }

      return true;
    });

    if (unavailableWishlistIds.length > 0) {
      await this.prisma.wishlistItem.deleteMany({ where: { id: { in: unavailableWishlistIds } } });
    }

    const wishlistItems = availableWishlistItems.map((item) => ({
      id: item.id,
      addedAt: item.createdAt,
      product: this.transformProduct(item.product),
    }));

    const totalAvailable = Math.max(0, total - unavailableWishlistIds.length);

    return {
      items: wishlistItems,
      total: totalAvailable,
      page,
      limit,
      totalPages: Math.ceil(totalAvailable / limit),
    };
  }

  async isInWishlist(userId: string, productId: string) {
    const item = await this.prisma.wishlistItem.findFirst({
      where: {
        userId,
        productId,
        product: {
          deletedAt: null,
          isActive: true,
          brand: { ownerId: { not: userId } },
        },
      },
      select: { id: true },
    });
    return { isWishlisted: Boolean(item) };
  }

  // ==================== HELPERS ====================

  private isProductOnSale(product: any): boolean {
    if (!product.salePrice) return false;
    const now = new Date();
    if (product.saleStartAt && product.saleStartAt > now) return false;
    if (product.saleEndAt && product.saleEndAt < now) return false;
    return true;
  }

  private transformProduct(product: any) {
    const collectionLinks = Array.isArray(product?.collections)
      ? product.collections
      : [];
    const sortedCollections = [...collectionLinks].sort(
      (a, b) => (a.orderIndex ?? 0) - (b.orderIndex ?? 0),
    );
    const primaryCollectionId = sortedCollections[0]?.collectionId ?? null;
    const collectionIds = sortedCollections.map((c) => c.collectionId);
    const isOnSale = this.isProductOnSale(product);
    const effectivePrice =
      isOnSale && product.salePrice
        ? Number(product.salePrice)
        : Number(product.price);

    // Calculate discount percentage
    let discountPercent: number | null = null;
    if (isOnSale && product.salePrice) {
      discountPercent = Math.round(
        ((Number(product.price) - Number(product.salePrice)) /
          Number(product.price)) *
          100,
      );
    }

    const variants = Array.isArray(product?.variants) ? product.variants : [];

    // Calculate size availability
    const sizeAvailability = (product.sizes || []).map((size: string) => {
      if (variants.length > 0) {
        const stock = variants
          .filter((v: any) => (v.size || null) === size)
          .reduce((sum: number, v: any) => sum + Number(v.stock || 0), 0);
        return { size, inStock: stock > 0, quantity: stock };
      }

      const stock = product.sizeStock?.[size] ?? product.totalStock;
      return { size, inStock: stock > 0, quantity: stock };
    });

    // Calculate profit margin if cost is available
    let profitMargin: number | null = null;
    if (product.costPerItem && Number(product.price) > 0) {
      const cost = Number(product.costPerItem);
      const price = Number(product.price);
      profitMargin = Math.round(((price - cost) / price) * 100);
    }

    return {
      id: product.id,
      collectionId: primaryCollectionId,
      collectionIds,
      brandId: product.brandId,
      // Basic info
      name: product.name,
      slug: product.slug,
      description: product.description,
      currency: product.currency || product?.brand?.currency || 'NGN',
      // Pricing
      price: Number(product.price),
      salePrice: product.salePrice ? Number(product.salePrice) : null,
      effectivePrice,
      isOnSale,
      discountPercent,
      saleStartAt: product.saleStartAt,
      saleEndAt: product.saleEndAt,
      // Product details
      sku: product.sku,
      weight: product.weight ? Number(product.weight) : null,
      weightUnit: product.weightUnit,
      materials: product.materials,
      careInstructions: product.careInstructions,
      costPerItem: product.costPerItem ? Number(product.costPerItem) : null,
      profitMargin,
      // Variants
      sizes: product.sizes || [],
      sizeStock: product.sizeStock,
      sizeAvailability,
      colors: product.colors || [],
      colorImages: product.colorImages,
      colorHexCodes: product.colorHexCodes,
      variants: variants.map((v: any) => ({
        id: v.id,
        size: v.size,
        color: v.color,
        sku: v.sku,
        price: v.price ? Number(v.price) : null,
        stock: v.stock,
        colorHex: v.colorHex,
      })),
      // Media
      images: product.images || [],
      thumbnail: product.thumbnail,
      // Inventory
      totalStock: product.totalStock,
      lowStockThreshold: product.lowStockThreshold,
      trackInventory: product.trackInventory,
      allowBackorders: product.allowBackorders,
      isLowStock:
        product.totalStock > 0 &&
        product.totalStock <= product.lowStockThreshold,
      isOutOfStock: product.totalStock === 0,
      // Metadata
      tags: product.tags || [],
      gender: product.gender,
      categoryTypeId: product.categoryTypeId ?? null,
      categoryType: product.categoryType
        ? {
            id: product.categoryType.id,
            categoryId: product.categoryType.categoryId,
            slug: product.categoryType.slug,
            name: product.categoryType.name,
          }
        : null,
      isActive: product.isActive,
      isFeatured: product.isFeatured,
      isPhysicalProduct: product.isPhysicalProduct,
      customsRegion: product.customsRegion,
      archivedAt: product.archivedAt,
      archiveExpiresAt: product.archiveExpiresAt,
      deletedAt: product.deletedAt,
      // Policies
      returnsEligible: product.returnsEligible,
      // SEO
      metaTitle: product.metaTitle,
      metaDescription: product.metaDescription,
      // Scheduling
      publishAt: product.publishAt,
      // Engagement
      viewsCount: product.viewsCount,
      threadsCount: product.threadsCount,
      // Timestamps
      createdAt: product.createdAt,
      updatedAt: product.updatedAt,
      // Relations
      collection: product.collection,
      brand: product.brand,
    };
  }

  // ==================== CHECKOUT ====================

  async checkout(userId: string, dto: CheckoutDto) {
    const cartItems = await this.prisma.cartItem.findMany({
      where: { userId },
      include: {
        product: {
          include: {
            brand: true,
            collection: true,
            collections: { include: { collection: true } },
            variants: true,
          },
        },
      },
      orderBy: { createdAt: 'asc' },
    });

    if (cartItems.length === 0) {
      throw new BadRequestException('Cart is empty');
    }

    const selfOwnedItem = cartItems.find(
      (item) => item.product?.brand?.ownerId === userId,
    );
    if (selfOwnedItem) {
      throw new ForbiddenException(
        'You cannot place orders on your own products',
      );
    }

    const sizeFitProfile = await (this.prisma as any).userSizeFitProfile.findUnique({
      where: { userId },
      select: {
        visibility: true,
        sharePolicy: true,
        measurements: true,
        lastUpdatedAt: true,
      },
    });
    const sizeFitSnapshot = sizeFitProfile
      ? {
          visibility: sizeFitProfile.visibility,
          sharePolicy: sizeFitProfile.sharePolicy,
          measurements:
            sizeFitProfile.measurements &&
            typeof sizeFitProfile.measurements === 'object' &&
            !Array.isArray(sizeFitProfile.measurements)
              ? sizeFitProfile.measurements
              : {},
          lastUpdatedAt: sizeFitProfile.lastUpdatedAt?.toISOString() ?? null,
          attachedAt: new Date().toISOString(),
        }
      : null;

    // Map items by brand to produce brand-scoped orders
    const itemsByBrand = cartItems.reduce<Record<string, typeof cartItems>>(
      (acc, item) => {
        const brandId = item.product.brandId;
        if (!acc[brandId]) acc[brandId] = [];
        acc[brandId].push(item);
        return acc;
      },
      {},
    );

    const orders = await this.prisma.$transaction(async (tx) => {
      const createdOrders = [] as any[];

      for (const [brandId, items] of Object.entries(itemsByBrand)) {
        const brand = await tx.brand.findUnique({
          where: { id: brandId },
          select: {
            id: true,
            name: true,
            currency: true,
            isStoreOpen: true,
            ownerId: true,
          },
        });

        if (!brand || !brand.isStoreOpen) {
          throw new BadRequestException('Store is closed');
        }
        if (brand.ownerId === userId) {
          throw new ForbiddenException(
            'You cannot place orders on your own products',
          );
        }

        const orderItems: any[] = [];
        let totalAmount = 0;

        for (const item of items) {
          const product = await tx.product.findFirst({
            where: { id: item.productId, deletedAt: null },
            include: { collection: true, collections: { include: { collection: true } }, variants: true },
          });

          if (!product || !product.isActive) {
            throw new BadRequestException('Product not available');
          }

          const hasStoreCollection = Array.isArray(product.collections)
            ? product.collections.some(
                (link: any) =>
                  link.collection?.isAvailableInStore &&
                  link.collection?.status === 'PUBLISHED',
              )
            : false;

          if (!hasStoreCollection) {
            throw new BadRequestException(
              `Product not available in store: ${product.name}`,
            );
          }

          const variants = Array.isArray((product as any).variants)
            ? ((product as any).variants as any[])
            : [];
          const hasVariantSizes = variants.some((v) => v.size);
          const hasVariantColors = variants.some((v) => v.color);

          if ((hasVariantSizes || product.sizes.length > 0) && !item.selectedSize) {
            throw new BadRequestException(`Please select a size for ${product.name}`);
          }
          if (item.selectedSize && product.sizes.length > 0 && !product.sizes.includes(item.selectedSize)) {
            throw new BadRequestException(`Invalid size for ${product.name}`);
          }

          if ((hasVariantColors || product.colors.length > 0) && !item.selectedColor) {
            throw new BadRequestException(`Please select a color for ${product.name}`);
          }
          if (item.selectedColor && product.colors.length > 0 && !product.colors.includes(item.selectedColor)) {
            throw new BadRequestException(`Invalid color for ${product.name}`);
          }

          const quantity = item.quantity;

          const selectedVariant =
            variants.length > 0
              ? variants.find(
                  (v) =>
                    (v.size || null) === (item.selectedSize || null) &&
                    (v.color || null) === (item.selectedColor || null),
                )
              : null;

          if (variants.length > 0 && !selectedVariant) {
            throw new BadRequestException(
              `Selected variant not available for ${product.name}`,
            );
          }

          const isOnSale = this.isProductOnSale(product);
          const baseUnitPrice = selectedVariant?.price
            ? Number(selectedVariant.price)
            : Number(product.price);

          const unitPrice =
            selectedVariant?.price
              ? baseUnitPrice
              : isOnSale && product.salePrice
                ? Number(product.salePrice)
                : baseUnitPrice;

          if (product.trackInventory && !product.allowBackorders) {
            if (selectedVariant) {
              const updated = await tx.productVariant.updateMany({
                where: { id: selectedVariant.id, stock: { gte: quantity } },
                data: { stock: { decrement: quantity } },
              });
              if (updated.count === 0) {
                throw new BadRequestException(
                  `Insufficient stock for ${product.name} (${item.selectedSize || ''} ${item.selectedColor || ''})`,
                );
              }
            } else {
              const sizeStock =
                (product.sizeStock as Record<string, number> | null) || null;

              if (item.selectedSize && sizeStock) {
                const available = sizeStock[item.selectedSize] || 0;
                if (available < quantity) {
                  throw new BadRequestException(
                    `Only ${available} left for ${product.name} (${item.selectedSize})`,
                  );
                }
                sizeStock[item.selectedSize] = available - quantity;
              } else if (product.totalStock < quantity) {
                throw new BadRequestException(
                  `Only ${product.totalStock} left for ${product.name}`,
                );
              }

              await tx.product.update({
                where: { id: product.id },
                data: {
                  totalStock: { decrement: quantity },
                  ...(sizeStock ? { sizeStock } : {}),
                },
              });
            }

            // Keep product aggregates roughly consistent when variants are used
            if (selectedVariant) {
              const sizeStock =
                (product.sizeStock as Record<string, number> | null) || null;
              if (item.selectedSize && sizeStock && sizeStock[item.selectedSize] !== undefined) {
                sizeStock[item.selectedSize] = Math.max(
                  0,
                  (sizeStock[item.selectedSize] || 0) - quantity,
                );
              }
              await tx.product.update({
                where: { id: product.id },
                data: {
                  totalStock: { decrement: quantity },
                  ...(sizeStock ? { sizeStock } : {}),
                },
              });
            }
          }

          totalAmount += unitPrice * quantity;

          orderItems.push({
            productId: product.id,
            name: product.name,
            thumbnail: product.thumbnail,
            price: unitPrice,
            quantity,
            selectedSize: item.selectedSize,
            selectedColor: item.selectedColor,
          });
        }

        const order = await tx.order.create({
          data: {
            id: uuidv4(),
            brandId,
            buyerId: userId,
            customerName: dto.customerName || 'Customer',
            shippingAddress: dto.shippingAddress || null,
            contactInfo: {
              ...(dto.contactInfo || {}),
              ...(sizeFitSnapshot ? { sizeFitSnapshot } : {}),
            } as any,
            items: orderItems,
            totalAmount: new Prisma.Decimal(totalAmount.toFixed(2)),
            currency: brand.currency || 'NGN',
            status: 'PENDING',
            paymentStatus: 'PENDING',
          },
        });

        // Notify brand owner a new order has arrived
        if (brand.ownerId) {
          await tx.notification.create({
            data: {
              id: uuidv4(),
              recipientId: brand.ownerId,
              actorId: userId,
              type: NotificationType.ORDER_PLACED,
              payload: { orderId: order.id, totalAmount: totalAmount, brandId },
            },
          });
        }

        createdOrders.push(order);
      }

      await tx.cartItem.deleteMany({ where: { userId } });
      return createdOrders;
    });

    return { orders };
  }

  // ==================== BUYER ORDERS ====================

  async getMyOrders(userId: string, page = 1, limit = 20) {
    const [orders, total] = await Promise.all([
      this.prisma.order.findMany({
        where: { buyerId: userId },
        include: {
          brand: {
            select: { id: true, name: true, logo: true, currency: true },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.order.count({ where: { buyerId: userId } }),
    ]);

    return {
      items: orders,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
      hasNextPage: page * limit < total,
    };
  }

  async getMyOrder(userId: string, orderId: string) {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, buyerId: userId },
      include: {
        brand: { select: { id: true, name: true, logo: true, currency: true } },
      },
    });

    if (!order) {
      throw new NotFoundException('Order not found');
    }

    return order;
  }

  // ==================== STORE WIZARD PREFILL & SETTINGS ====================

  async getStoreWizardPrefill(ownerId: string) {
    const [user, brand, policy, categories, tags] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: ownerId },
        select: {
          id: true,
          username: true,
          email: true,
          isEmailVerified: true,
          brandFullName: true,
          brandDescription: true,
          brandTags: true,
          socialInstagram: true,
          socialTwitter: true,
          socialWebsite: true,
        },
      }),
      this.prisma.brand.findUnique({
        where: { ownerId },
        select: {
          id: true,
          name: true,
          description: true,
          tagline: true,
          tags: true,
          contactEmail: true,
          socialInstagram: true,
          socialTwitter: true,
          socialTiktok: true,
          socialWebsite: true,
          responseTimeSla: true,
          isStoreOpen: true,
        },
      }),
      this.prisma.storePolicy.findFirst({
        where: { brand: { ownerId } },
        select: { responseTimeSla: true },
      }),
      this.getActiveCategories(),
      this.getSystemTags(),
    ]);

    if (!user) throw new NotFoundException('User not found');

    const storeName = this.canonicalStoreName(user, brand);
    const slug = this.canonicalStoreSlug(user);

    const rawTags =
      (brand?.tags && brand.tags.length > 0 ? brand.tags : user.brandTags) || [];
    const normalizedTags = rawTags
      .map((t) => this.normalizeTag(t))
      .filter(Boolean);

    const description = (brand?.description || user.brandDescription || '').trim();
    const contactEmail = brand?.contactEmail || user.email || '';
    const instagram = brand?.socialInstagram || user.socialInstagram || '';
    const twitter = brand?.socialTwitter || user.socialTwitter || '';
    const website = brand?.socialWebsite || user.socialWebsite || '';
    const tiktok = brand?.socialTiktok || '';
    const tagline = (brand?.tagline || '').trim();
    const responseTimeSla = policy?.responseTimeSla || brand?.responseTimeSla || '24h';

    const taglineFromDescription =
      description.split(/(?<=[.!?])\s+/)[0]?.trim() || '';
    const suggestedTagline = (
      tagline || taglineFromDescription || normalizedTags.slice(0, 3).join(' â€¢ ')
    ).slice(0, 60);

    return {
      brand: {
        storeName,
        slug,
        contactEmail,
        description,
        instagram,
        twitter,
        tiktok,
        website,
        tags: normalizedTags,
        tagline: suggestedTagline,
        responseTimeSla,
      },
      system: {
        categories,
        tags,
      },
      flags: {
        isEmailVerified: user.isEmailVerified,
        hasLiveStore: Boolean(brand?.isStoreOpen),
      },
    };
  }

  async getStoreGeneralSettings(ownerId: string) {
    const [user, brand, policy] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: ownerId },
        select: {
          id: true,
          username: true,
          email: true,
          isEmailVerified: true,
          brandFullName: true,
          brandDescription: true,
        },
      }),
      this.prisma.brand.findUnique({
        where: { ownerId },
        select: {
          id: true,
          name: true,
          description: true,
          contactEmail: true,
          tagline: true,
          logo: true,
          banner: true,
          tags: true,
          storeNameLastChangedAt: true,
          isStoreOpen: true,
          responseTimeSla: true,
        },
      }),
      this.prisma.storePolicy.findFirst({
        where: { brand: { ownerId } },
        select: { responseTimeSla: true },
      }),
    ]);

    if (!user) throw new NotFoundException('User not found');

    const storeName = this.canonicalStoreName(user, brand);
    const slug = this.canonicalStoreSlug(user);

    const lastChangedAt = brand?.storeNameLastChangedAt ?? null;
    const nextAllowedAt = lastChangedAt
      ? new Date(lastChangedAt.getTime() + 90 * 24 * 60 * 60 * 1000)
      : null;

    // Compute setup completeness
    const completeness = brand
      ? this.computeStoreCompleteness(brand)
      : { isComplete: false, missingFields: ['name', 'description', 'tags', 'logo', 'banner'] };

    return {
      brandId: brand?.id,
      storeName,
      slug,
      description: brand?.description || user.brandDescription || '',
      tagline: brand?.tagline || '',
      logo: brand?.logo || '',
      banner: brand?.banner || '',
      tags: brand?.tags || [],
      contactEmail: brand?.contactEmail || user.email,
      isEmailVerified: user.isEmailVerified,
      isStoreOpen: Boolean(brand?.isStoreOpen),
      isSetupComplete: completeness.isComplete,
      missingFields: completeness.missingFields,
      storeNameLastChangedAt: lastChangedAt,
      storeNameNextAllowedAt: nextAllowedAt,
      responseTimeSla: policy?.responseTimeSla || brand?.responseTimeSla || '24h',
    };
  }

  async updateStoreName(ownerId: string, dto: UpdateStoreNameDto) {
    const [user, brand] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: ownerId },
        select: {
          id: true,
          password: true,
          isEmailVerified: true,
        },
      }),
      this.prisma.brand.findUnique({
        where: { ownerId },
        select: { id: true, storeNameLastChangedAt: true },
      }),
    ]);

    if (!user) throw new NotFoundException('User not found');
    if (!brand) throw new NotFoundException('Brand not found');

    if (!user.isEmailVerified) {
      throw new ForbiddenException(
        'Verify your email before changing your store name.',
      );
    }

    const ok = await this.passwordService.verifyPassword(
      user.password,
      dto.currentPassword,
    );
    if (!ok) {
      throw new ForbiddenException('Password verification failed.');
    }

    const now = new Date();
    const last = brand.storeNameLastChangedAt;
    if (last) {
      const nextAllowedAt = new Date(last.getTime() + 90 * 24 * 60 * 60 * 1000);
      if (now < nextAllowedAt) {
        const daysRemaining = Math.ceil(
          (nextAllowedAt.getTime() - now.getTime()) / (24 * 60 * 60 * 1000),
        );
        throw new BadRequestException(
          `Store name can only be changed once every 3 months. Try again in ~${daysRemaining} day(s).`,
        );
      }
    }

    const newName = dto.newName.trim();
    if (!newName) throw new BadRequestException('Store name cannot be empty');

    await this.prisma.$transaction(async (tx) => {
      await tx.brand.update({
        where: { id: brand.id },
        data: {
          name: newName,
          storeNameLastChangedAt: now,
        },
      });

      await tx.user.update({
        where: { id: ownerId },
        data: { brandFullName: newName },
      });
    });

    return this.getStoreGeneralSettings(ownerId);
  }

  // ==================== STORE STATUS & COMPLETENESS ====================

  /**
   * Compute store setup completeness based on Tier 1 requirements:
   * - name (required)
   * - description (required)
   * - tags (required, at least 1)
   * NOTE: Store logo/banner are derived from the Brand's profile images (synced from User)
   * and should not block store opening.
   */
  private computeStoreCompleteness(brand: {
    name: string;
    description?: string | null;
    tags?: string[];
    logo?: string | null;
    banner?: string | null;
  }): { isComplete: boolean; missingFields: string[] } {
    const missingFields: string[] = [];

    if (!brand.name?.trim()) missingFields.push('name');
    if (!brand.description?.trim()) missingFields.push('description');
    if (!brand.tags || brand.tags.length === 0) missingFields.push('tags');

    return {
      isComplete: missingFields.length === 0,
      missingFields,
    };
  }

  async getStoreStatus(ownerId: string) {
    let brand = await this.prisma.brand.findUnique({
      where: { ownerId },
      select: {
        id: true,
        name: true,
        description: true,
        tagline: true,
        logo: true,
        banner: true,
          tags: true,
          contactEmail: true,
          socialInstagram: true,
          socialTwitter: true,
          socialTiktok: true,
          socialWebsite: true,
          responseTimeSla: true,
          isStoreOpen: true,
        },
      });

    if (!brand) {
      const resolved = await this.resolveBrandByIdOrOwner(ownerId);
      if (resolved) {
        brand = await this.prisma.brand.findUnique({
          where: { id: resolved.id },
          select: {
            id: true,
            name: true,
            description: true,
            tagline: true,
            logo: true,
            banner: true,
            tags: true,
            contactEmail: true,
            socialInstagram: true,
            socialTwitter: true,
            socialTiktok: true,
            socialWebsite: true,
            responseTimeSla: true,
            isStoreOpen: true,
          },
        });
      }
    }

    if (!brand) {
      throw new NotFoundException('Brand not found');
    }

    const { isComplete, missingFields } = this.computeStoreCompleteness(brand);
    const policy = await this.prisma.storePolicy.findUnique({
      where: { brandId: brand.id },
      select: { responseTimeSla: true },
    });

    return {
      brandId: brand.id,
      isStoreOpen: brand.isStoreOpen,
      isSetupComplete: isComplete,
      missingFields,
      profile: {
        name: brand.name,
        description: brand.description,
        tagline: brand.tagline,
        logo: brand.logo,
        banner: brand.banner,
        tags: brand.tags,
        contactEmail: brand.contactEmail,
        socialInstagram: brand.socialInstagram,
        socialTwitter: brand.socialTwitter,
        socialTiktok: brand.socialTiktok,
        socialWebsite: brand.socialWebsite,
        responseTimeSla: policy?.responseTimeSla || brand.responseTimeSla,
      },
    };
  }

  async openStore(ownerId: string) {
    const brand = await this.prisma.brand.findUnique({
      where: { ownerId },
      select: {
        id: true,
        name: true,
        description: true,
        tags: true,
        logo: true,
        banner: true,
        isStoreOpen: true,
      },
    });

    if (!brand) {
      throw new NotFoundException('Brand not found');
    }

    if (brand.isStoreOpen) {
      return { success: true, message: 'Store is already open', brandId: brand.id };
    }

    const { isComplete, missingFields } = this.computeStoreCompleteness(brand);

    if (!isComplete) {
      throw new BadRequestException({
        message: 'Store setup is incomplete. Please complete all required fields before opening.',
        missingFields,
      });
    }

    await this.prisma.brand.update({
      where: { id: brand.id },
      data: { isStoreOpen: true },
    });

    const nextIndexedTags = this.getIndexedBrandTags(
      { isStoreOpen: true, tags: brand.tags ?? [] },
      brand.tags ?? [],
    );
    if (nextIndexedTags.length > 0 && this.systemTags) {
      await this.systemTags.syncTags([], nextIndexedTags);
      this.systemTagsCache = null;
    }
    if (nextIndexedTags.length > 0 && this.tagIndex) {
      await this.tagIndex.syncEntityTags(
        TAG_ENTITY_TYPE.BRAND,
        brand.id,
        [],
        nextIndexedTags,
        { maxCount: 30 },
      );
    }

    return { success: true, message: 'Store is now open!', brandId: brand.id };
  }

  async closeStore(ownerId: string) {
    const brand = await this.prisma.brand.findUnique({
      where: { ownerId },
      select: {
        id: true,
        isStoreOpen: true,
        tags: true,
      },
    });

    if (!brand) {
      throw new NotFoundException('Brand not found');
    }

    if (!brand.isStoreOpen) {
      return { success: true, message: 'Store is already closed', brandId: brand.id };
    }

    const previousIndexedTags = this.getIndexedBrandTags(
      { isStoreOpen: true, tags: brand.tags ?? [] },
      brand.tags ?? [],
    );

    await this.prisma.brand.update({
      where: { id: brand.id },
      data: { isStoreOpen: false },
    });

    if (previousIndexedTags.length > 0 && this.systemTags) {
      await this.systemTags.syncTags(previousIndexedTags, []);
      this.systemTagsCache = null;
    }
    if (previousIndexedTags.length > 0 && this.tagIndex) {
      await this.tagIndex.syncEntityTags(
        TAG_ENTITY_TYPE.BRAND,
        brand.id,
        previousIndexedTags,
        [],
        { maxCount: 30 },
      );
    }

    return { success: true, message: 'Store is now closed', brandId: brand.id };
  }

  async updateStoreProfile(ownerId: string, dto: UpdateStoreProfileDto) {
    let brand = await this.prisma.brand.findUnique({
      where: { ownerId },
      select: { id: true, tags: true, isStoreOpen: true },
    });

    if (!brand) {
      const resolved = await this.resolveBrandByIdOrOwner(ownerId);
      if (resolved) {
        brand = await this.prisma.brand.findUnique({
          where: { id: resolved.id },
          select: { id: true, tags: true, isStoreOpen: true },
        });
      }
    }

    if (!brand) {
      throw new NotFoundException('Brand not found');
    }

    const previousStoreTags = Array.isArray(brand.tags) ? brand.tags : [];
    const previousIndexedTags = this.getIndexedBrandTags(
      { isStoreOpen: brand.isStoreOpen, tags: previousStoreTags },
      previousStoreTags,
    );
    let nextStoreTags: string[] | undefined;
    const updateData: any = {};

    if (dto.description !== undefined) updateData.description = dto.description;
    if (dto.tagline !== undefined) updateData.tagline = dto.tagline;
    if (dto.tags !== undefined) {
      // Normalize and de-duplicate tags.
      // NOTE: Do not hard-filter against "system tags" here.
      // In a fresh environment (or early product lifecycle), system tags may be empty,
      // which would make it impossible for any brand to ever complete store setup.
      nextStoreTags = this.buildTagSet(dto.tags || []);
      updateData.tags = nextStoreTags;
    }
    if (dto.contactEmail !== undefined) updateData.contactEmail = dto.contactEmail;
    if (dto.socialInstagram !== undefined) updateData.socialInstagram = dto.socialInstagram;
    if (dto.socialTwitter !== undefined) updateData.socialTwitter = dto.socialTwitter;
    if (dto.socialTiktok !== undefined) updateData.socialTiktok = dto.socialTiktok;
    if (dto.socialWebsite !== undefined) updateData.socialWebsite = dto.socialWebsite;

    if (Object.keys(updateData).length === 0) {
      return this.getStoreStatus(ownerId);
    }

    await this.prisma.brand.update({
      where: { id: brand.id },
      data: updateData,
    });
    if (nextStoreTags !== undefined) {
      const nextIndexedTags = this.getIndexedBrandTags(
        { isStoreOpen: brand.isStoreOpen, tags: nextStoreTags },
        nextStoreTags,
      );
      if (this.systemTags) {
        await this.systemTags.syncTags(previousIndexedTags, nextIndexedTags);
        this.systemTagsCache = null;
      }
      if (this.tagIndex) {
        await this.tagIndex.syncEntityTags(
          TAG_ENTITY_TYPE.BRAND,
          brand.id,
          previousIndexedTags,
          nextIndexedTags,
          { maxCount: 30 },
        );
      }
    }

    return this.getStoreStatus(ownerId);
  }

  async getStorePolicies(ownerId: string) {
    let brand = await this.prisma.brand.findUnique({
      where: { ownerId },
      select: { id: true, responseTimeSla: true },
    });

    if (!brand) {
      const resolved = await this.resolveBrandByIdOrOwner(ownerId);
      if (resolved) {
        brand = await this.prisma.brand.findUnique({
          where: { id: resolved.id },
          select: { id: true, responseTimeSla: true },
        });
      }
    }

    if (!brand) {
      throw new NotFoundException('Brand not found');
    }

    const policy = await this.prisma.storePolicy.findUnique({
      where: { brandId: brand.id },
    });

    return {
      brandId: brand.id,
      shippingRegions: policy?.shippingRegions || [],
      processingTime: policy?.processingTime || '',
      shippingMethods: policy?.shippingMethods || [],
      freeShippingThreshold:
        policy?.freeShippingThreshold !== null && policy?.freeShippingThreshold !== undefined
          ? Number(policy.freeShippingThreshold)
          : null,
      returnsAccepted: policy?.returnsAccepted ?? true,
      returnWindow: policy?.returnWindow || '14',
      returnConditions: policy?.returnConditions || [],
      refundMethod: policy?.refundMethod || 'original',
      responseTimeSla: policy?.responseTimeSla || brand.responseTimeSla || '24h',
      sizeChart: policy?.sizeChart || null,
      shippingRules: policy?.shippingRules || null,
    };
  }

  async updateStorePolicies(ownerId: string, dto: UpdateStorePoliciesDto) {
    let brand = await this.prisma.brand.findUnique({
      where: { ownerId },
      select: { id: true, responseTimeSla: true },
    });

    if (!brand) {
      const resolved = await this.resolveBrandByIdOrOwner(ownerId);
      if (resolved) {
        brand = await this.prisma.brand.findUnique({
          where: { id: resolved.id },
          select: { id: true, responseTimeSla: true },
        });
      }
    }

    if (!brand) {
      throw new NotFoundException('Brand not found');
    }

    const updateData: Prisma.StorePolicyUpdateInput = {};
    const createData: Prisma.StorePolicyCreateInput = {
      id: uuidv4(),
      brand: { connect: { id: brand.id } },
    };

    if (dto.shippingRegions !== undefined) {
      updateData.shippingRegions = { set: dto.shippingRegions };
      createData.shippingRegions = dto.shippingRegions;
    }
    if (dto.processingTime !== undefined) {
      updateData.processingTime = dto.processingTime;
      createData.processingTime = dto.processingTime;
    }
    if (dto.shippingMethods !== undefined) {
      updateData.shippingMethods = { set: dto.shippingMethods };
      createData.shippingMethods = dto.shippingMethods;
    }
    if (dto.freeShippingThreshold !== undefined) {
      updateData.freeShippingThreshold = dto.freeShippingThreshold;
      createData.freeShippingThreshold = dto.freeShippingThreshold;
    }
    if (dto.returnsAccepted !== undefined) {
      updateData.returnsAccepted = dto.returnsAccepted;
      createData.returnsAccepted = dto.returnsAccepted;
    }
    if (dto.returnWindow !== undefined) {
      updateData.returnWindow = dto.returnWindow;
      createData.returnWindow = dto.returnWindow;
    }
    if (dto.returnConditions !== undefined) {
      updateData.returnConditions = { set: dto.returnConditions };
      createData.returnConditions = dto.returnConditions;
    }
    if (dto.refundMethod !== undefined) {
      updateData.refundMethod = dto.refundMethod;
      createData.refundMethod = dto.refundMethod;
    }
    if (dto.responseTimeSla !== undefined) {
      updateData.responseTimeSla = dto.responseTimeSla;
      createData.responseTimeSla = dto.responseTimeSla;
    }
    if (dto.sizeChart !== undefined) {
      updateData.sizeChart = dto.sizeChart;
      createData.sizeChart = dto.sizeChart;
    }
    if (dto.shippingRules !== undefined) {
      updateData.shippingRules = dto.shippingRules;
      createData.shippingRules = dto.shippingRules;
    }

    if (Object.keys(updateData).length === 0) {
      return this.getStorePolicies(ownerId);
    }

    await this.prisma.storePolicy.upsert({
      where: { brandId: brand.id },
      create: createData,
      update: updateData,
    });

    return this.getStorePolicies(ownerId);
  }
}


