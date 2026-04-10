import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  ConflictException,
  InternalServerErrorException,
  Logger,
  Optional,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { CreateProductDto, UpdateProductDto } from './dto/create-product.dto';
import { AddToCartDto, UpdateCartItemDto } from './dto/cart.dto';
import { AddToWishlistDto } from './dto/wishlist.dto';
import { CheckoutDto } from './dto/checkout.dto';
import { calculateShipping } from '../payment/payment.types';
import {
  BulkArchiveProductsDto,
  BulkDeleteProductsDto,
  BulkUnpublishProductsDto,
} from './dto/bulk-product-actions.dto';
import { v4 as uuidv4 } from 'uuid';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'crypto';
import {
  CollectionType,
  CustomOrderSourceType,
  Prisma,
  NotificationType,
  OrderStatus,
  PatchMode,
  PatchStatus,
  PaymentStatus,
  SizingMode,
  UserType,
} from '@prisma/client';
import { UpdateStoreNameDto } from './dto/update-store-name.dto';
import { UpdateStoreProfileDto } from './dto/update-store-profile.dto';
import { UpdateStorePoliciesDto } from './dto/update-store-policies.dto';
import { UpdateStorePaymentAccountDto } from './dto/update-store-payment-account.dto';
import { VerifyStorePaymentAccountDto } from './dto/verify-store-payment-account.dto';
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
import { CategoriesService } from 'src/categories/categories.service';
import { reconcileStandardOrderPaymentStatuses } from 'src/common/payments/order-payment-reconciliation.util';
import { StandardOrderEscrowService } from 'src/finance/standard-order-escrow.service';
import { StandardOrderFinanceSyncService } from 'src/finance/standard-order-finance-sync.service';
import { buildPayoutSourceBreakdown } from 'src/payout/payout-detail.presenter';
import {
  describePaystackSecretEnvKeys,
  resolvePaystackSecret,
} from 'src/common/utils/paystack-secret';

type SupportedPaymentBank = {
  id: number;
  code: string;
  name: string;
  currency: string;
};

const PAYSTACK_TEST_BANK_CODE = '001';
const PAYSTACK_TEST_BANK_FALLBACK_UNTIL_ENV =
  'PAYSTACK_TEST_BANK_001_UNTIL';
const STORE_PAYMENT_TEST_ACCOUNT_DEV_BYPASS_ENV =
  'STORE_PAYMENT_ALLOW_TEST_ACCOUNT_IN_DEV';
const PRODUCT_VARIANT_SIZE_VALUES = [
  'XXS',
  'XS',
  'S',
  'M',
  'L',
  'XL',
  'XXL',
  'XXXL',
  'XXXXL',
] as const;
const PRODUCT_VARIANT_SIZE_LABEL_SET = new Set<string>(PRODUCT_VARIANT_SIZE_VALUES);
const PRODUCT_VARIANT_SIZE_ALIASES: Record<string, string> = {
  XSM: 'XS',
  '2XL': 'XXL',
  '3XL': 'XXXL',
  '4XL': 'XXXXL',
};
const CUSTOM_ORDER_OUT_OF_STOCK_GRACE_MS =
  7 * 24 * 60 * 60 * 1000;
const CUSTOM_ORDER_OUT_OF_STOCK_REMINDER_INTERVAL_MS =
  24 * 60 * 60 * 1000;

@Injectable()
export class StoreService {
  private readonly logger = new Logger(StoreService.name);
  private readonly systemTagsTtlMs = 5 * 60 * 1000;
  private systemTagsCache: { tags: string[]; expiresAt: number } | null = null;
  private systemTagsRefresh: Promise<string[]> | null = null;
  private readonly supportedPaymentBanksTtlMs = 60 * 60 * 1000;
  private supportedPaymentBanksCache: { banks: SupportedPaymentBank[]; expiresAt: number } | null = null;
  private supportedPaymentBanksRefresh: Promise<SupportedPaymentBank[]> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly passwordService: PasswordService,
    private readonly uploadService: UploadService,
    private readonly viewCounter: ProductViewCounterService,
    private readonly notifications?: NotificationsService,
    private readonly systemTags?: SystemTagsService,
    private readonly tagIndex?: TagIndexService,
    @Optional()
    private readonly categoriesService?: CategoriesService,
    private readonly notificationsQueue?: NotificationsQueueService,
    private readonly standardOrderEscrowService?: StandardOrderEscrowService,
    private readonly standardOrderFinanceSyncService?: StandardOrderFinanceSyncService,
  ) {}

  private readonly maxProductsPerCollection = Math.max(
    1,
    parseInt(process.env.MAX_PRODUCTS_PER_COLLECTION || '5', 10),
  );
  private readonly minPublishProductMediaCount = 4;
  private readonly maxProductMediaCount = 6;
  private readonly minPublishVariantCount = 5;

  private normalizeFilterValueIds(raw?: string[] | null): string[] {
    if (!Array.isArray(raw)) return [];
    return Array.from(
      new Set(
        raw
          .map((value) => (typeof value === 'string' ? value.trim() : ''))
          .filter((value) => value.length > 0),
      ),
    );
  }

  private async getProductFilterRows(productIds: string[]) {
    if (!Array.isArray(productIds) || productIds.length === 0) {
      return [] as Array<{
        entityId: string;
        filterValueId: string;
        filterValue: {
          id: string;
          slug: string;
          name: string;
          dimension: { id: string; slug: string; name: string; isMulti: boolean };
        };
      }>;
    }

    return this.prisma.entityFilter.findMany({
      where: {
        entityType: 'PRODUCT',
        entityId: { in: productIds },
      },
      include: {
        filterValue: {
          include: {
            dimension: {
              select: { id: true, slug: true, name: true, isMulti: true },
            },
          },
        },
      },
    });
  }

  private buildProductFilterPayloadByProductId(
    rows: Array<{
      entityId: string;
      filterValueId: string;
      filterValue: {
        id: string;
        slug: string;
        name: string;
        dimension: { id: string; slug: string; name: string; isMulti: boolean };
      };
    }>,
  ) {
    const map = new Map<
      string,
      {
        filters: Array<{
          dimensionId: string;
          dimensionSlug: string;
          dimensionName: string;
          valueId: string;
          valueSlug: string;
          valueName: string;
        }>;
        filterValueIds: string[];
        filterSelection: Record<string, string[]>;
      }
    >();

    for (const row of rows) {
      const entityId = row.entityId;
      const existing =
        map.get(entityId) ??
        {
          filters: [],
          filterValueIds: [],
          filterSelection: {},
        };

      const filterItem = {
        dimensionId: row.filterValue.dimension.id,
        dimensionSlug: row.filterValue.dimension.slug,
        dimensionName: row.filterValue.dimension.name,
        valueId: row.filterValue.id,
        valueSlug: row.filterValue.slug,
        valueName: row.filterValue.name,
      };

      if (!existing.filterValueIds.includes(filterItem.valueId)) {
        existing.filters.push(filterItem);
        existing.filterValueIds.push(filterItem.valueId);
      }

      const currentSelection = existing.filterSelection[filterItem.dimensionId] ?? [];
      if (!currentSelection.includes(filterItem.valueId)) {
        existing.filterSelection[filterItem.dimensionId] = [
          ...currentSelection,
          filterItem.valueId,
        ];
      }

      map.set(entityId, existing);
    }

    return map;
  }

  private async attachProductFiltersToView(productView: any, productId: string) {
    const rows = await this.getProductFilterRows([productId]);
    const filterMap = this.buildProductFilterPayloadByProductId(rows);
    const payload = filterMap.get(productId) ?? {
      filters: [],
      filterValueIds: [],
      filterSelection: {},
    };
    return {
      ...productView,
      filters: payload.filters,
      filterValueIds: payload.filterValueIds,
      filterSelection: payload.filterSelection,
    };
  }

  private async lockCollectionForUpdate(
    tx: Prisma.TransactionClient,
    collectionId: string,
  ) {
    await tx.$executeRaw(
      Prisma.sql`SELECT "_id" FROM "StoreCollection" WHERE "_id" = ${collectionId} FOR UPDATE`,
    );
  }

  private async lockProductForUpdate(
    tx: Prisma.TransactionClient,
    productId: string,
  ) {
    await tx.$executeRaw(
      Prisma.sql`SELECT "_id" FROM "Product" WHERE "_id" = ${productId} FOR UPDATE`,
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

    if (!collectionId) return;

    const collection = await tx.storeCollection.findUnique({
      where: { id: collectionId },
      select: { id: true, deletedAt: true },
    });
    if (!collection || collection.deletedAt) {
      throw new NotFoundException('Collection not found');
    }
  }

  private async assertActiveProductCategory(
    tx: Prisma.TransactionClient,
    categoryId: string | null | undefined,
  ) {
    if (!categoryId) {
      return null;
    }

    const category = await tx.collectionCategory.findUnique({
      where: { id: categoryId },
      select: { id: true, isActive: true },
    });

    if (!category) {
      throw new NotFoundException('Category not found');
    }
    if (!category.isActive) {
      throw new BadRequestException('Category is not active');
    }

    return category;
  }

  private async assertProductTaxonomy(
    tx: Prisma.TransactionClient,
    categoryId: string | null | undefined,
    categoryTypeId: string | null | undefined,
  ) {
    const normalizedCategoryId = (categoryId || '').trim() || null;
    const normalizedCategoryTypeId = (categoryTypeId || '').trim() || null;

    await this.assertActiveProductCategory(tx, normalizedCategoryId);

    if (!normalizedCategoryTypeId) {
      return;
    }

    const categoryType = await tx.collectionCategoryType.findUnique({
      where: { id: normalizedCategoryTypeId },
      select: { id: true, categoryId: true, isActive: true },
    });

    if (!categoryType) {
      throw new NotFoundException('Sub-category not found');
    }
    if (!categoryType.isActive) {
      throw new BadRequestException('Sub-category is not active');
    }
    if (
      normalizedCategoryId &&
      categoryType.categoryId !== normalizedCategoryId
    ) {
      throw new BadRequestException(
        'Sub-category does not belong to the selected category',
      );
    }
  }

  private async assertProductPublishReady(
    tx: Prisma.TransactionClient,
    input: {
      name?: string | null;
      description?: string | null;
      categoryId?: string | null;
      categoryTypeId?: string | null;
      tags?: string[] | null;
      price?: number | Prisma.Decimal | null;
      images?: string[] | null;
      thumbnail?: string | null;
      variants?: Array<
        | null
        | undefined
        | {
            size?: string | null;
            color?: string | null;
            sku?: string | null;
            price?: number | Prisma.Decimal | null;
            stock?: number | null;
            colorHex?: string | null;
          }
      > | null;
      totalStock?: number | null;
      trackInventory?: boolean | null;
      customOrderEnabled?: boolean | null;
    },
  ) {
    const name = String(input.name || '').trim();
    if (!name) {
      throw new BadRequestException('Product title is required to publish');
    }

    const description = String(input.description || '').trim();
    if (!description) {
      throw new BadRequestException(
        'Product description is required to publish',
      );
    }

    const categoryId = String(input.categoryId || '').trim();
    if (!categoryId) {
      throw new BadRequestException('Category is required to publish');
    }

    const categoryTypeId = String(input.categoryTypeId || '').trim();
    if (!categoryTypeId) {
      throw new BadRequestException('Sub-category is required to publish');
    }

    await this.assertProductTaxonomy(tx, categoryId, categoryTypeId);

    const tags = this.buildTagSet(input.tags || []);
    if (tags.length === 0) {
      throw new BadRequestException(
        'At least one tag is required to publish',
      );
    }

    const price = Number(input.price ?? 0);
    if (!Number.isFinite(price) || price <= 0) {
      throw new BadRequestException('Price must be greater than 0 to publish');
    }

    const images = Array.isArray(input.images)
      ? input.images.filter(Boolean)
      : [];
    if (images.length < this.minPublishProductMediaCount) {
      throw new BadRequestException(
        `Upload at least ${this.minPublishProductMediaCount} images to publish: front, left, right, and back`,
      );
    }
    if (images.length > this.maxProductMediaCount) {
      throw new BadRequestException(
        `You can upload up to ${this.maxProductMediaCount} images`,
      );
    }

    const thumbnail = String(input.thumbnail || '').trim();
    if (!thumbnail) {
      throw new BadRequestException('Cover image is required to publish');
    }
    if (!images.includes(thumbnail)) {
      throw new BadRequestException(
        'Cover image must be one of the uploaded product images',
      );
    }

    const variants = Array.isArray(input.variants)
      ? input.variants.filter(Boolean)
      : [];
    if (variants.length < this.minPublishVariantCount) {
      throw new BadRequestException(
        `At least ${this.minPublishVariantCount} size variants are required to publish`,
      );
    }

    if (input.trackInventory !== false) {
      const totalStock = Number(input.totalStock ?? 0);
      if (!Number.isFinite(totalStock) || totalStock < 0) {
        throw new BadRequestException(
          'Inventory stock must be 0 or greater to publish',
        );
      }
      if (totalStock <= 0 && input.customOrderEnabled !== true) {
        throw new BadRequestException(
          'Published products must have stock unless custom order is enabled.',
        );
      }
    }
  }

  private async attachProductMedia(product: any) {
    const base = this.transformProduct(product);
    const baseWithFilters = await this.attachProductFiltersToView(base, product.id);
    const images: string[] = Array.isArray(product?.images)
      ? product.images.filter(Boolean)
      : [];

    if (images.length === 0) {
      return { ...baseWithFilters, media: [], mediaIds: [] };
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
      ...baseWithFilters,
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

    await this.assertBrandOwnsProduct(brandOwnerId, productId);

    // Re-use existing POST_IMAGE validation rules for product images.
    const uploaded = await this.uploadService.uploadFile(
      file,
      brandOwnerId,
      FileType.POST_IMAGE,
    );

    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`
        SELECT 1
        FROM "Product"
        WHERE "_id" = ${productId}::uuid
        FOR UPDATE
      `;

      const product = await tx.product.findUnique({
        where: { id: productId },
        select: {
          id: true,
          images: true,
          thumbnail: true,
        },
      });

      if (!product) {
        throw new NotFoundException('Product not found');
      }

      const nextImages = Array.isArray(product.images) ? [...product.images] : [];
      if (nextImages.length >= this.maxProductMediaCount) {
        throw new BadRequestException(
          `You can upload up to ${this.maxProductMediaCount} images`,
        );
      }

      nextImages.push(uploaded.url);
      const nextThumbnail =
        isPrimary || !product.thumbnail ? uploaded.url : product.thumbnail;

      await tx.product.update({
        where: { id: productId },
        data: {
          images: nextImages,
          thumbnail: nextThumbnail,
        },
      });
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
    if (ids.length > this.maxProductMediaCount) {
      throw new BadRequestException(
        `You can upload up to ${this.maxProductMediaCount} images`,
      );
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
    if (
      !existingImages.includes(upload.s3Url) &&
      existingImages.length >= this.maxProductMediaCount
    ) {
      throw new BadRequestException(
        `You can upload up to ${this.maxProductMediaCount} images`,
      );
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

  private normalizeRequiredVariantSize(
    value: string | null | undefined,
  ): string | null {
    const normalized = this.normalizeVariantDimension(value);
    if (!normalized) {
      return null;
    }

    const compact = normalized.toUpperCase().replace(/[\s-]+/g, '');
    const aliased = PRODUCT_VARIANT_SIZE_ALIASES[compact] ?? compact;
    return PRODUCT_VARIANT_SIZE_LABEL_SET.has(aliased) ? aliased : null;
  }

  private assertProductVariantRequirements(
    variants: Array<{
      size: string | null;
      stock: number;
    }>,
    options: {
      requireInStockVariant: boolean;
      messagePrefix: string;
    },
  ): void {
    if (variants.length === 0) {
      throw new BadRequestException(
        `${options.messagePrefix} must include at least one size variant.`,
      );
    }

    const hasInStockVariant = variants.some((variant) => variant.stock > 0);
    if (options.requireInStockVariant && !hasInStockVariant) {
      throw new BadRequestException(
        `${options.messagePrefix} must include at least one in-stock size variant.`,
      );
    }
  }

  private computeCustomOrderOutOfStockDiscontinueAt(triggeredAt: Date): Date {
    return new Date(triggeredAt.getTime() + CUSTOM_ORDER_OUT_OF_STOCK_GRACE_MS);
  }

  private canBagOutOfStockCustomOrderProduct(product: {
    deletedAt?: Date | null;
    archivedAt?: Date | null;
    isActive?: boolean | null;
    totalStock?: number | null;
    customOrderEnabled?: boolean | null;
    variants?: Array<{ size?: string | null } | null> | null;
  }): boolean {
    if (product.deletedAt || product.archivedAt || product.isActive === false) {
      return false;
    }

    return (
      Number(product.totalStock ?? 0) <= 0 &&
      product.customOrderEnabled === true
    );
  }

  private isProductPubliclyInventoryEligible(product: {
    totalStock?: number | null;
    customOrderEnabled?: boolean | null;
    variants?: Array<{ size?: string | null } | null> | null;
  }): boolean {
    if (Number(product.totalStock ?? 0) > 0) {
      return true;
    }

    return product.customOrderEnabled === true;
  }

  private buildMarketplaceInventoryWhereFilter(): Prisma.ProductWhereInput {
    return {
      OR: [{ totalStock: { gt: 0 } }, { customOrderEnabled: true }],
    };
  }

  private buildCustomOrderStockLifecycleData(args: {
    previousTotalStock: number;
    nextTotalStock: number;
    nextCustomOrderEnabled: boolean;
    currentIsActive: boolean;
    currentTriggeredAt?: Date | null;
    currentDiscontinueAt?: Date | null;
    explicitIsActive?: boolean;
  }): Prisma.ProductUpdateInput {
    const nextData: Prisma.ProductUpdateInput = {};
    const nextHasStock = args.nextTotalStock > 0;
    const wasAutoDiscontinued =
      !args.currentIsActive &&
      Boolean(args.currentDiscontinueAt) &&
      args.previousTotalStock <= 0;

    if (args.explicitIsActive === false || !args.nextCustomOrderEnabled) {
      nextData.customOrderOutOfStockTriggeredAt = null;
      nextData.customOrderOutOfStockReminderSentAt = null;
      nextData.customOrderOutOfStockDiscontinueAt = null;
      return nextData;
    }

    if (nextHasStock) {
      nextData.customOrderOutOfStockTriggeredAt = null;
      nextData.customOrderOutOfStockReminderSentAt = null;
      nextData.customOrderOutOfStockDiscontinueAt = null;
      if (wasAutoDiscontinued && args.explicitIsActive === undefined) {
        nextData.isActive = true;
      }
      return nextData;
    }

    const triggeredAt = args.currentTriggeredAt ?? new Date();
    nextData.customOrderOutOfStockTriggeredAt = triggeredAt;
    nextData.customOrderOutOfStockDiscontinueAt =
      args.currentDiscontinueAt ??
      this.computeCustomOrderOutOfStockDiscontinueAt(triggeredAt);

    if (!args.currentTriggeredAt) {
      nextData.customOrderOutOfStockReminderSentAt = null;
    }

    return nextData;
  }

  private buildOutOfStockCustomOrderReminderMessage(product: {
    id: string;
    name?: string | null;
    customOrderOutOfStockDiscontinueAt?: Date | null;
  }): string {
    const name = String(product.name || 'Your product').trim() || 'Your product';
    const deadline = product.customOrderOutOfStockDiscontinueAt;
    if (!deadline) {
      return `${name} is out of stock and shoppers are still bagging it as a custom-order item. Restock it to keep it strong in the market.`;
    }

    const msRemaining = deadline.getTime() - Date.now();
    const daysRemaining = Math.max(
      0,
      Math.ceil(msRemaining / (24 * 60 * 60 * 1000)),
    );

    if (daysRemaining <= 1) {
      return `${name} is still out of stock. Restock it within 24 hours or it will be discontinued from the market.`;
    }

    return `${name} is still out of stock. Restock it within ${daysRemaining} days or it will be discontinued from the market.`;
  }

  private async notifyBrandOfOutOfStockCustomOrder(
    ownerId: string,
    product: {
      id: string;
      name?: string | null;
      customOrderOutOfStockDiscontinueAt?: Date | null;
    },
    message?: string,
  ): Promise<void> {
    if (!this.notifications) {
      return;
    }

    const resolvedMessage =
      typeof message === 'string' && message.trim().length > 0
        ? message.trim()
        : this.buildOutOfStockCustomOrderReminderMessage(product);

    await this.notifications.create(ownerId, NotificationType.ADMIN_ACTION, {
      payload: {
        action: 'PRODUCT_OUT_OF_STOCK_CUSTOM_ORDER',
        productId: product.id,
        productName: product.name,
        targetUrl: `/studio/products/${product.id}`,
        message: resolvedMessage,
      },
      target: { type: 'PRODUCT', id: product.id, preview: product.name ?? undefined },
      dedupeMs: 6 * 60 * 60 * 1000,
    });
  }

  private async triggerOutOfStockCustomOrderLifecycle(args: {
    tx: Prisma.TransactionClient;
    productId: string;
    ownerId: string;
    productName: string;
    currentTriggeredAt?: Date | null;
    currentDiscontinueAt?: Date | null;
  }): Promise<void> {
    if (args.currentTriggeredAt && args.currentDiscontinueAt) {
      return;
    }

    const triggeredAt = args.currentTriggeredAt ?? new Date();
    const discontinueAt =
      args.currentDiscontinueAt ??
      this.computeCustomOrderOutOfStockDiscontinueAt(triggeredAt);

    await args.tx.product.update({
      where: { id: args.productId },
      data: {
        customOrderOutOfStockTriggeredAt: triggeredAt,
        customOrderOutOfStockReminderSentAt: triggeredAt,
        customOrderOutOfStockDiscontinueAt: discontinueAt,
      },
    });

    await this.notifyBrandOfOutOfStockCustomOrder(
      args.ownerId,
      {
        id: args.productId,
        name: args.productName,
        customOrderOutOfStockDiscontinueAt: discontinueAt,
      },
      `${args.productName} is out of stock, but shoppers can still bag it as a custom-order item. Restock it within 7 days or it will be discontinued from the market.`,
    );
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
      const size = this.normalizeRequiredVariantSize(v.size);
      if (!size) {
        throw new BadRequestException(
          `Each variant must include a supported size: ${PRODUCT_VARIANT_SIZE_VALUES.join(', ')}`,
        );
      }
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
    const base = this.normalizeSlugBase(name);
    // Add random suffix for uniqueness
    const suffix = Math.random().toString(36).slice(2, 8);
    return `${base}-${suffix}`;
  }

  private normalizeSlugBase(name: string): string {
    const base = (name || '')
      .toLowerCase()
      .trim()
      .replace(/[^\w\s-]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 72);
    return base.length > 0 ? base : 'untitled-product';
  }

  private async ensureUniqueProductSlug(
    tx: Prisma.TransactionClient,
    name: string,
  ): Promise<string> {
    const base = this.normalizeSlugBase(name);
    const existing = await tx.product.findMany({
      where: {
        slug: {
          startsWith: base,
        },
      },
      select: { slug: true },
    });

    const existingSlugs = new Set(existing.map((entry) => entry.slug));
    if (!existingSlugs.has(base)) {
      return base;
    }

    let suffix = 2;
    let candidate = `${base}-${suffix}`;
    while (existingSlugs.has(candidate)) {
      suffix += 1;
      candidate = `${base}-${suffix}`;
    }
    return candidate;
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
    const now = new Date();
    await this.prisma.product.updateMany({
      where: {
        isActive: false,
        deletedAt: null,
        archivedAt: null,
        publishAt: { lte: now },
      },
      data: { isActive: true },
    });

    if (!this.notifications) return;

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

  @Cron(CronExpression.EVERY_6_HOURS)
  async handleCustomOrderOutOfStockLifecycle() {
    const now = new Date();
    const reminderCutoff = new Date(
      now.getTime() - CUSTOM_ORDER_OUT_OF_STOCK_REMINDER_INTERVAL_MS,
    );

    const productsToDiscontinue = await this.prisma.product.findMany({
      where: {
        deletedAt: null,
        archivedAt: null,
        isActive: true,
        customOrderEnabled: true,
        totalStock: { lte: 0 },
        customOrderOutOfStockTriggeredAt: { not: null },
        customOrderOutOfStockDiscontinueAt: { lte: now },
      },
      select: {
        id: true,
        name: true,
        brand: { select: { ownerId: true } },
      },
      take: 200,
      orderBy: { customOrderOutOfStockDiscontinueAt: 'asc' },
    });

    for (const product of productsToDiscontinue) {
      const updated = await this.prisma.product.updateMany({
        where: {
          id: product.id,
          deletedAt: null,
          archivedAt: null,
          isActive: true,
          customOrderEnabled: true,
          totalStock: { lte: 0 },
          customOrderOutOfStockTriggeredAt: { not: null },
          customOrderOutOfStockDiscontinueAt: { lte: now },
        },
        data: { isActive: false },
      });

      if (updated.count === 0 || !product.brand?.ownerId) {
        continue;
      }

      await this.notifyBrandOfOutOfStockCustomOrder(
        product.brand.ownerId,
        { id: product.id, name: product.name },
        `${product.name} stayed out of stock for 7 days while custom orders were still allowed, so it has been discontinued from the market.`,
      );
    }

    const productsNeedingReminder = await this.prisma.product.findMany({
      where: {
        deletedAt: null,
        archivedAt: null,
        isActive: true,
        customOrderEnabled: true,
        totalStock: { lte: 0 },
        customOrderOutOfStockTriggeredAt: { not: null },
        customOrderOutOfStockDiscontinueAt: { gt: now },
        OR: [
          { customOrderOutOfStockReminderSentAt: null },
          { customOrderOutOfStockReminderSentAt: { lte: reminderCutoff } },
        ],
      },
      select: {
        id: true,
        name: true,
        customOrderOutOfStockDiscontinueAt: true,
        brand: { select: { ownerId: true } },
      },
      take: 200,
      orderBy: { customOrderOutOfStockReminderSentAt: 'asc' },
    });

    for (const product of productsNeedingReminder) {
      if (!product.brand?.ownerId) {
        continue;
      }

      await this.notifyBrandOfOutOfStockCustomOrder(product.brand.ownerId, {
        id: product.id,
        name: product.name,
        customOrderOutOfStockDiscontinueAt:
          product.customOrderOutOfStockDiscontinueAt,
      });

      await this.prisma.product.update({
        where: { id: product.id },
        data: { customOrderOutOfStockReminderSentAt: now },
      });
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

    if ((dto as any).sizingModeDeprecatedAliasUsed) {
      this.logger.warn(
        `Deprecated sizingMode 'RTW_PLUS_CUSTOM' used by store owner ${brandOwnerId}; auto-mapped to RTW_PLUS_FITTINGS`,
      );
    }

    const requestedCollectionId = (dto.collectionId || '').trim() || null;
    const requestedCategoryId = (dto.categoryId || '').trim() || null;
    const requestedCategoryTypeId = (dto.categoryTypeId || '').trim() || null;

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
    this.assertProductVariantRequirements(derivedFromVariants?.variants ?? [], {
      requireInStockVariant: true,
      messagePrefix: 'A product',
    });

    const currency = (dto.currency || brand.currency || 'NGN').trim();

    const normalizedImages = Array.isArray(dto.images)
      ? dto.images.filter(Boolean)
      : [];
    if (normalizedImages.length > this.maxProductMediaCount) {
      throw new BadRequestException(
        `You can upload up to ${this.maxProductMediaCount} images`,
      );
    }
    let resolvedThumbnail: string | null = dto.thumbnail ?? null;
    if (normalizedImages.length > 0) {
      resolvedThumbnail = resolvedThumbnail || normalizedImages[0];
    } else {
      resolvedThumbnail = null;
    }

    // Resolve product name and slug
    const resolvedName = (dto.name || 'Untitled Product').trim();
    const resolvedTags = this.buildTagSet(dto.tags || []);
    const nextIsActive = dto.isActive ?? true;
    const nextCustomOrderEnabled = dto.customOrderEnabled === true;
    const initialTotalStock =
      derivedFromVariants?.totalStock ?? (dto.totalStock || 0);
    const initialOutOfStockTriggeredAt =
      nextIsActive && nextCustomOrderEnabled && initialTotalStock <= 0
        ? new Date()
        : null;
    const initialOutOfStockDiscontinueAt = initialOutOfStockTriggeredAt
      ? this.computeCustomOrderOutOfStockDiscontinueAt(
          initialOutOfStockTriggeredAt,
        )
      : null;

    const product = await this.prisma.$transaction(async (tx) => {
      let slug = await this.ensureUniqueProductSlug(tx, resolvedName);
      let collectionId = requestedCollectionId;

      if (!collectionId) {
        collectionId = await this.ensureDefaultStoreCollection(tx, brandOwnerId);
      }

      await this.assertCategoryTypeForCollection(
        tx,
        collectionId,
        requestedCategoryTypeId,
      );
      await this.assertProductTaxonomy(
        tx,
        requestedCategoryId,
        requestedCategoryTypeId,
      );
      if (nextIsActive) {
        await this.assertProductPublishReady(tx, {
          name: resolvedName,
          description: dto.description,
          categoryId: requestedCategoryId,
          categoryTypeId: requestedCategoryTypeId,
          tags: resolvedTags,
          price: resolvedPrice,
          images: normalizedImages,
          thumbnail: resolvedThumbnail,
          variants: derivedFromVariants?.variants ?? [],
          totalStock:
            derivedFromVariants?.totalStock ?? (dto.totalStock || 0),
          trackInventory: dto.trackInventory ?? true,
          customOrderEnabled: nextCustomOrderEnabled,
        });
      }

      await this.lockCollectionForUpdate(tx, collectionId);
      await this.assertCollectionCapacity(tx, collectionId);
      const orderIndex = await tx.storeCollectionProduct.count({
        where: { collectionId },
      });

      let created = null as Awaited<ReturnType<typeof tx.product.create>> | null;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          created = await tx.product.create({
            data: {
              id: uuidv4(),
              collectionId,
              categoryId: requestedCategoryId,
              categoryTypeId: requestedCategoryTypeId,
              brandId: brand.id,
              name: resolvedName,
              slug,
              description: dto.description,
              currency,
              standardCheckoutEnabled:
                dto.standardCheckoutEnabled !== false,
              customOrderEnabled: nextCustomOrderEnabled,
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
              sizingMode: this.normalizeSizingMode(dto.sizingMode),
              rtwSizeSystem: dto.rtwSizeSystem || null,
              rtwSizeType: dto.rtwSizeType || null,
              rtwLinkedToInventory: dto.rtwLinkedToInventory ?? false,
              customGender: dto.customGender || null,
              customMeasurementKeys:
                this.normalizeRequiredMeasurementKeys(dto.customMeasurementKeys),
              customFreeformPointIds:
                this.normalizeRequiredMeasurementKeys(dto.customFreeformPointIds),
              fitPreference: dto.fitPreference || null,
              targetAgeGroup: dto.targetAgeGroup || 'ADULT',
              colors: derivedFromVariants?.colors ?? dto.colors ?? [],
              colorImages: dto.colorImages || null,
              colorHexCodes:
                derivedFromVariants?.colorHexCodes ?? dto.colorHexCodes ?? null,
              // Media
              images: normalizedImages,
              thumbnail: resolvedThumbnail,
              // Inventory
              totalStock: initialTotalStock,
              lowStockThreshold: dto.lowStockThreshold || 5,
              trackInventory: dto.trackInventory ?? true,
              allowBackorders: dto.allowBackorders ?? false,
              customOrderOutOfStockTriggeredAt:
                initialOutOfStockTriggeredAt,
              customOrderOutOfStockReminderSentAt: null,
              customOrderOutOfStockDiscontinueAt:
                initialOutOfStockDiscontinueAt,
              // Metadata
              tags: resolvedTags,
              gender: dto.gender || 'EVERYBODY',
              isActive: nextIsActive,
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
          break;
        } catch (error) {
          if (
            error instanceof Prisma.PrismaClientKnownRequestError &&
            error.code === 'P2002' &&
            attempt < 2
          ) {
            slug = this.generateSlug(resolvedName);
            continue;
          }
          throw error;
        }
      }

      if (!created) {
        throw new InternalServerErrorException('Unable to create product');
      }

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

    if (this.categoriesService && Array.isArray(dto.filterValueIds)) {
      await this.categoriesService.setEntityFilters(
        'PRODUCT',
        product.id,
        this.normalizeFilterValueIds(dto.filterValueIds),
      );
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
      include: {
        brand: true,
        variants: {
          select: {
            size: true,
            color: true,
            sku: true,
            price: true,
            stock: true,
            colorHex: true,
          },
        },
      },
    });

    if (!product) {
      throw new NotFoundException('Product not found');
    }

    if (product.brand.ownerId !== brandOwnerId) {
      throw new ForbiddenException('You can only update your own products');
    }

    if ((dto as any).sizingModeDeprecatedAliasUsed) {
      this.logger.warn(
        `Deprecated sizingMode 'RTW_PLUS_CUSTOM' used by store owner ${brandOwnerId}; auto-mapped to RTW_PLUS_FITTINGS`,
      );
    }

    if (dto.isActive === true) {
      await this.assertProductRepublishUnlocked(productId);
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

    let resolvedCategoryId: string | null | undefined = undefined;
    if (dto.categoryId !== undefined) {
      const requestedCategoryId = (dto.categoryId || '').trim();
      resolvedCategoryId = requestedCategoryId || null;
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
    if ((dto as any).variants !== undefined) {
      this.assertProductVariantRequirements(derivedFromVariants?.variants ?? [], {
        requireInStockVariant: false,
        messagePrefix: 'A product',
      });
    }

    const updateData: Prisma.ProductUpdateInput = {};
    const nextCustomOrderEnabled =
      dto.customOrderEnabled !== undefined
        ? dto.customOrderEnabled === true
        : product.customOrderEnabled === true;

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
    if (dto.standardCheckoutEnabled !== undefined) {
      updateData.standardCheckoutEnabled = dto.standardCheckoutEnabled;
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
    if (dto.sizingMode !== undefined)
      updateData.sizingMode = this.normalizeSizingMode(dto.sizingMode);
    if (dto.rtwSizeSystem !== undefined)
      updateData.rtwSizeSystem = dto.rtwSizeSystem || null;
    if (dto.rtwSizeType !== undefined)
      updateData.rtwSizeType = dto.rtwSizeType || null;
    if (dto.rtwLinkedToInventory !== undefined)
      updateData.rtwLinkedToInventory = dto.rtwLinkedToInventory;
    if (dto.customGender !== undefined)
      updateData.customGender = dto.customGender || null;
    if (dto.customMeasurementKeys !== undefined)
      updateData.customMeasurementKeys = this.normalizeRequiredMeasurementKeys(
        dto.customMeasurementKeys,
      );
    if (dto.customFreeformPointIds !== undefined)
      updateData.customFreeformPointIds = this.normalizeRequiredMeasurementKeys(
        dto.customFreeformPointIds,
      );
    if (dto.fitPreference !== undefined)
      updateData.fitPreference = dto.fitPreference || null;
    if (dto.targetAgeGroup !== undefined)
      updateData.targetAgeGroup = dto.targetAgeGroup;
    
    // Media
    if (dto.images !== undefined) {
      const normalizedImages = Array.isArray(dto.images)
        ? dto.images.filter(Boolean)
        : [];
      if (normalizedImages.length > this.maxProductMediaCount) {
        throw new BadRequestException(
          `You can upload up to ${this.maxProductMediaCount} images`,
        );
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
    if (dto.customOrderEnabled !== undefined) {
      updateData.customOrderEnabled = dto.customOrderEnabled;
    }
    
    // Metadata
    const nextTags =
      dto.tags !== undefined ? this.buildTagSet(dto.tags || []) : undefined;
    if (nextTags !== undefined) updateData.tags = nextTags;
    if (dto.gender !== undefined) updateData.gender = dto.gender;
    if (resolvedCategoryId !== undefined) {
      updateData.category = resolvedCategoryId
        ? { connect: { id: resolvedCategoryId } }
        : { disconnect: true };
      if (
        resolvedCategoryTypeId === undefined &&
        resolvedCategoryId !== product.categoryId
      ) {
        updateData.categoryType = { disconnect: true };
      }
    }
    if (resolvedCategoryTypeId !== undefined) {
      updateData.categoryType = resolvedCategoryTypeId
        ? { connect: { id: resolvedCategoryTypeId } }
        : { disconnect: true };
    }
    if (dto.isActive !== undefined) updateData.isActive = dto.isActive;
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
            // Reset when switching collection to avoid stale mismatched sub-category.
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

      const finalCategoryId =
        resolvedCategoryId !== undefined
          ? resolvedCategoryId
          : (product.categoryId ?? null);
      const finalCategoryTypeId =
        updateData.categoryType && resolvedCategoryTypeId === undefined
          ? null
          : resolvedCategoryTypeId !== undefined
            ? resolvedCategoryTypeId
            : (product.categoryTypeId ?? null);
      await this.assertProductTaxonomy(
        tx,
        finalCategoryId,
        finalCategoryTypeId,
      );

      const finalIsActive =
        dto.isActive !== undefined ? dto.isActive : product.isActive;
      const finalTotalStock =
        derivedFromVariants?.totalStock ??
        (dto.totalStock !== undefined ? dto.totalStock : product.totalStock);
      const stockLifecyclePatch = this.buildCustomOrderStockLifecycleData({
        previousTotalStock: product.totalStock,
        nextTotalStock: finalTotalStock,
        nextCustomOrderEnabled,
        currentIsActive: product.isActive,
        currentTriggeredAt: product.customOrderOutOfStockTriggeredAt,
        currentDiscontinueAt: product.customOrderOutOfStockDiscontinueAt,
        explicitIsActive: dto.isActive,
      });
      if (finalIsActive) {
        const nextImages =
          dto.images !== undefined
            ? (Array.isArray(dto.images) ? dto.images.filter(Boolean) : [])
            : (Array.isArray(product.images) ? product.images : []);
        const nextThumbnail =
          dto.images !== undefined
            ? (updateData.thumbnail as string | null | undefined)
            : dto.thumbnail !== undefined
              ? (dto.thumbnail || null)
              : (product.thumbnail ?? null);

        await this.assertProductPublishReady(tx, {
          name: dto.name !== undefined ? dto.name : product.name,
          description:
            dto.description !== undefined
              ? dto.description
              : product.description,
          categoryId: finalCategoryId,
          categoryTypeId: finalCategoryTypeId,
          tags: nextTags ?? previousTags,
          price:
            dto.price !== undefined ? dto.price : Number(product.price || 0),
          images: nextImages,
          thumbnail: nextThumbnail,
          variants:
            derivedFromVariants?.variants ??
            (Array.isArray(product.variants) ? product.variants : []),
          totalStock: finalTotalStock,
          trackInventory:
            dto.trackInventory !== undefined
              ? dto.trackInventory
              : product.trackInventory,
          customOrderEnabled: nextCustomOrderEnabled,
        });
      }

      Object.assign(updateData, stockLifecyclePatch);

      await tx.product.update({
        where: { id: productId },
        data: updateData,
      });

      if (dto.customOrderEnabled === false) {
        await tx.customOrderConfiguration.updateMany({
          where: {
            sourceType: CustomOrderSourceType.PRODUCT,
            sourceId: productId,
            isActive: true,
          },
          data: { isActive: false },
        });
      }

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

    if (updated && this.categoriesService && Array.isArray(dto.filterValueIds)) {
      await this.categoriesService.setEntityFilters(
        'PRODUCT',
        productId,
        this.normalizeFilterValueIds(dto.filterValueIds),
      );
    }

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

  private async assertProductRepublishUnlocked(productId: string) {
    const logs = await (this.prisma as any).adminAuditLog.findMany({
      where: {
        action: 'ADMIN_PRODUCT_MODERATE',
        targetType: 'Product',
        targetId: productId,
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
      const isActive = state.isActive;

      if (action === 'REPUBLISH' || isActive === true) {
        return;
      }

      if (action === 'UNPUBLISH' || isActive === false) {
        throw new ForbiddenException(
          'This product was unpublished by admin and can only be republished by admin.',
        );
      }
    }
  }

  async requestProductRepublishApproval(
    brandOwnerId: string,
    productId: string,
    reason?: string,
  ) {
    const product = await this.prisma.product.findFirst({
      where: { id: productId, deletedAt: null },
      include: { brand: true },
    });

    if (!product) {
      throw new NotFoundException('Product not found');
    }
    if (product.brand.ownerId !== brandOwnerId) {
      throw new ForbiddenException('You can only request republish for your own product');
    }
    if (product.isActive) {
      throw new BadRequestException('Product is already published');
    }

    let isAdminLocked = false;
    try {
      await this.assertProductRepublishUnlocked(productId);
    } catch (error) {
      if (error instanceof ForbiddenException) {
        isAdminLocked = true;
      } else {
        throw error;
      }
    }

    if (!isAdminLocked) {
      throw new BadRequestException('This product is not currently blocked by admin moderation');
    }

    const admins = await this.prisma.user.findMany({
      where: {
        role: { in: ['Admin', 'SuperAdmin'] as any },
        status: 'ACTIVE',
      },
      select: { id: true },
      take: 100,
    });

    if (this.notifications && admins.length > 0) {
      await Promise.all(
        admins
          .filter((admin) => admin.id !== brandOwnerId)
          .map((admin) =>
            this.notifications!.create(admin.id, NotificationType.ADMIN_ACTION, {
              actorId: brandOwnerId,
              payload: {
                targetType: 'PRODUCT',
                targetId: productId,
                action: 'REPUBLISH_REQUEST',
                reason: reason?.trim() || null,
                message: `A brand requested republish approval for product "${product.name}".${reason?.trim() ? ` Reason: ${reason.trim()}` : ''}`,
              },
            }).catch(() => undefined),
          ),
      );
    }

    return {
      success: true,
      message: 'Republish request sent to admin for review',
    };
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
          standardCheckoutEnabled: product.standardCheckoutEnabled !== false,
          customOrderEnabled: product.customOrderEnabled === true,
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
          customOrderOutOfStockTriggeredAt: null,
          customOrderOutOfStockReminderSentAt: null,
          customOrderOutOfStockDiscontinueAt: null,
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

    const activeOrders = await this.prisma.order.findMany({
      where: {
        brandId: product.brandId,
        status: { in: ['PENDING', 'PROCESSING', 'SHIPPED'] },
      },
      select: {
        items: true,
        orderItems: {
          select: { productId: true },
        },
      },
    });

    let activeOrdersCount = 0;
    for (const order of activeOrders) {
      if (this.orderContainsProduct(order, productId)) {
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

    // Notify wishlisted users that the product is unavailable
    if (this.notifications) {
      try {
        const wishlistItems = await this.prisma.wishlistItem.findMany({
          where: { productId },
          select: { userId: true },
        });
        for (const wi of wishlistItems) {
          await this.notifications.create(wi.userId, 'WISHLIST_PRODUCT_UNAVAILABLE', {
            actorId: brandOwnerId,
            payload: {
              productId,
              productName: product.name,
              brandName: product.brand.name,
            },
          });
        }
      } catch (err) {
        // Non-critical — don't fail the archive operation
        console.warn('Failed to send wishlist unavailable notifications:', err);
      }
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
        // Restored archived products should come back as drafts.
        isActive: false,
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



    // Only notify availability when the product is actually active/published.
    if (this.notifications && restored.isActive) {
      try {
        const wishlistItems = await this.prisma.wishlistItem.findMany({
          where: { productId },
          select: { userId: true },
        });
        for (const wi of wishlistItems) {
          await this.notifications.create(wi.userId, 'WISHLIST_PRODUCT_AVAILABLE', {
            actorId: brandOwnerId,
            payload: {
              productId,
              productName: product.name,
              brandName: product.brand.name,
            },
          });
        }
      } catch (err) {
        console.warn('Failed to send wishlist available notifications:', err);
      }
    }
    return this.attachProductMedia(restored);
  }

  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

  // toggleFeatured removed - featuring is now admin-only via AdminFeaturedService


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

    const activeOrders = await this.prisma.order.findMany({
      where: {
        brandId: product.brandId,
        status: { in: ['PENDING', 'PROCESSING', 'SHIPPED'] },
      },
      select: {
        items: true,
        orderItems: {
          select: { productId: true },
        },
      },
    });

    let activeOrdersCount = 0;
    for (const order of activeOrders) {
      if (this.orderContainsProduct(order, productId)) {
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
          select: {
            id: true,
            buyerId: true,
            items: true,
            orderItems: {
              select: { productId: true },
            },
          },
        });

        for (const order of orders) {
          if (this.orderContainsProduct(order, productId)) {
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
                targetUrl: `/orders/${order.id}`,
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

  async bulkDeleteProducts(
    brandOwnerId: string,
    dto: BulkDeleteProductsDto,
  ) {
    const productIds = this.normalizeBulkProductIds(dto.productIds);

    if (productIds.length === 0) {
      throw new BadRequestException('Select at least one product');
    }

    const cancelPendingOrders = dto.cancelPendingOrders === true;
    const successIds: string[] = [];
    const failures: Array<{ productId: string; message: string }> = [];

    for (const productId of productIds) {
      try {
        await this.deleteProduct(brandOwnerId, productId, cancelPendingOrders);
        successIds.push(productId);
      } catch (error: any) {
        const message =
          typeof error?.message === 'string' && error.message.length > 0
            ? error.message
            : 'Failed to delete product';
        failures.push({ productId, message });
      }
    }

    return {
      requestedCount: productIds.length,
      deletedCount: successIds.length,
      failedCount: failures.length,
      successIds,
      failures,
      message:
        failures.length === 0
          ? 'Products deleted'
          : 'Some products could not be deleted',
    };
  }

  async bulkArchiveProducts(
    brandOwnerId: string,
    dto: BulkArchiveProductsDto,
  ) {
    const productIds = this.normalizeBulkProductIds(dto.productIds);

    if (productIds.length === 0) {
      throw new BadRequestException('Select at least one product');
    }

    const successIds: string[] = [];
    const failures: Array<{ productId: string; message: string }> = [];

    for (const productId of productIds) {
      try {
        await this.archiveProduct(brandOwnerId, productId);
        successIds.push(productId);
      } catch (error: any) {
        const message =
          typeof error?.message === 'string' && error.message.length > 0
            ? error.message
            : 'Failed to archive product';
        failures.push({ productId, message });
      }
    }

    return {
      requestedCount: productIds.length,
      archivedCount: successIds.length,
      failedCount: failures.length,
      successIds,
      failures,
      message:
        failures.length === 0
          ? 'Products archived'
          : 'Some products could not be archived',
    };
  }

  async bulkUnpublishProducts(
    brandOwnerId: string,
    dto: BulkUnpublishProductsDto,
  ) {
    const productIds = this.normalizeBulkProductIds(dto.productIds);

    if (productIds.length === 0) {
      throw new BadRequestException('Select at least one product');
    }

    const successIds: string[] = [];
    const failures: Array<{ productId: string; message: string }> = [];

    for (const productId of productIds) {
      try {
        const product = await this.prisma.product.findFirst({
          where: { id: productId, deletedAt: null },
          include: { brand: true },
        });

        if (!product) {
          throw new NotFoundException('Product not found');
        }
        if (product.brand.ownerId !== brandOwnerId) {
          throw new ForbiddenException(
            'You can only unpublish your own products',
          );
        }
        if (product.archivedAt) {
          throw new BadRequestException(
            'Product is archived. Unarchive it first before unpublishing.',
          );
        }

        if (product.isActive) {
          await this.updateProduct(brandOwnerId, productId, {
            isActive: false,
            publishAt: null,
          });
        }
        successIds.push(productId);
      } catch (error: any) {
        const message =
          typeof error?.message === 'string' && error.message.length > 0
            ? error.message
            : 'Failed to unpublish product';
        failures.push({ productId, message });
      }
    }

    return {
      requestedCount: productIds.length,
      unpublishedCount: successIds.length,
      failedCount: failures.length,
      successIds,
      failures,
      message:
        failures.length === 0
          ? 'Products unpublished'
          : 'Some products could not be unpublished',
    };
  }

  private normalizeBulkProductIds(rawIds?: string[] | null): string[] {
    const source = Array.isArray(rawIds) ? rawIds : [];
    return Array.from(
      new Set(
        source
          .map((id) => String(id || '').trim())
          .filter((id) => id.length > 0),
      ),
    );
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
        categoryType: {
          select: {
            id: true,
            categoryId: true,
            slug: true,
            name: true,
          },
        },
        collection: {
          select: {
            id: true,
            title: true,
            description: true,
            status: true,
            isAvailableInStore: true,
            deletedAt: true,
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
                deletedAt: true,
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

    // Store gating: brand must be open and product must be publicly available for non-owners.
    if (!isOwner) {
      if (!product.brand.isStoreOpen) {
        throw new NotFoundException('Store is closed');
      }
      if (!this.isProductPubliclyAvailable(product)) {
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

  async resolvePublicProductBySlug(slug: string, userId?: string) {
    const normalizedSlug = slug.trim();
    if (!normalizedSlug) {
      throw new NotFoundException('Product not found');
    }

    const product = await this.prisma.product.findFirst({
      where: {
        slug: normalizedSlug,
        deletedAt: null,
      },
      select: {
        id: true,
        slug: true,
        name: true,
        isActive: true,
        publishAt: true,
        archivedAt: true,
        deletedAt: true,
        totalStock: true,
        customOrderEnabled: true,
        collectionId: true,
        collection: {
          select: {
            id: true,
            title: true,
            description: true,
            status: true,
            isAvailableInStore: true,
            deletedAt: true,
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
                deletedAt: true,
              },
            },
          },
        },
        brand: {
          select: {
            ownerId: true,
            isStoreOpen: true,
          },
        },
        variants: {
          select: {
            size: true,
          },
        },
      },
    });

    if (!product) {
      throw new NotFoundException('Product not found');
    }

    const isOwner = Boolean(userId && product.brand.ownerId === userId);

    if (!isOwner) {
      if (!product.brand.isStoreOpen) {
        throw new NotFoundException('Store is closed');
      }
      if (!this.isProductPubliclyAvailable(product)) {
        throw new NotFoundException('Product not available');
      }
    }

    return {
      id: product.id,
      slug: product.slug,
      name: product.name,
    };
  }

  async resolvePublicStorefrontBySlug(slug: string) {
    const normalizedSlug = slug.trim();
    if (!normalizedSlug) {
      throw new NotFoundException('Storefront not found');
    }

    const user = await this.prisma.user.findUnique({
      where: { username: normalizedSlug },
      select: {
        id: true,
        username: true,
        type: true,
        brandFullName: true,
        brand: {
          select: {
            name: true,
            isStoreOpen: true,
          },
        },
      },
    });

    if (!user || user.type !== UserType.BRAND || !user.brand?.isStoreOpen) {
      throw new NotFoundException('Storefront not found');
    }

    return {
      ownerId: user.id,
      slug: this.canonicalStoreSlug(user),
      displayName: this.canonicalStoreName(user, user.brand),
    };
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
      // Public: only active products available in storefront.
      where.isActive = true;
      where.deletedAt = null;
      andFilters.push({
        OR: [
          { collections: { none: {} } },
          {
            collections: {
              some: {
                collection: {
                  status: 'PUBLISHED',
                  isAvailableInStore: true,
                  deletedAt: null,
                },
              },
            },
          },
        ],
      });
      andFilters.push(this.buildMarketplaceInventoryWhereFilter());
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

    if (andFilters.length > 0) {
      const existingAnd = Array.isArray(where.AND)
        ? where.AND
        : where.AND
          ? [where.AND]
          : [];
      where.AND = [...existingAnd, ...andFilters];
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
          categoryType: {
            select: { id: true, categoryId: true, slug: true, name: true },
          },
          variants: {
            select: {
              id: true,
              size: true,
              color: true,
              stock: true,
              price: true,
              sku: true,
              colorHex: true,
            },
          },
        },
      }),
      this.prisma.product.count({ where }),
    ]);

    const nextCursor = products.length > 0 ? products[products.length - 1].id : null;

    const baseItems = products.map((p) => this.transformProduct(p));
    const productFilterRows = await this.getProductFilterRows(
      baseItems.map((item: any) => item.id).filter(Boolean),
    );
    const productFilterMap = this.buildProductFilterPayloadByProductId(
      productFilterRows,
    );
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
      const filterPayload = productFilterMap.get(base.id) ?? {
        filters: [],
        filterValueIds: [],
        filterSelection: {},
      };
      if (images.length === 0) {
        return {
          ...base,
          ...filterPayload,
          media: [],
          mediaIds: [],
        };
      }
      const media = images.map((url: string) => ({
        id: idByUrl.get(url) ?? url,
        url,
        type: 'image',
        isPrimary: !!base.thumbnail && url === base.thumbnail,
      }));
      return {
        ...base,
        ...filterPayload,
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

  async getMarketplaceProducts(
    options: {
      page?: number;
      limit?: number;
      cursor?: string;
      collectionId?: string;
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
    } = {},
  ) {
    const {
      page = 1,
      limit = 40,
      cursor,
      collectionId,
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
    } = options;

    const safePage = Math.max(1, Number(page) || 1);
    const safeLimit = Math.min(120, Math.max(1, Number(limit) || 40));

    const where: Prisma.ProductWhereInput = {
      isActive: true,
      deletedAt: null,
      brand: { isStoreOpen: true },
    };

    const andFilters: Prisma.ProductWhereInput[] = [
      {
        OR: [
          { collections: { none: {} } },
          {
            collections: {
              some: {
                collection: {
                  status: 'PUBLISHED',
                  isAvailableInStore: true,
                  deletedAt: null,
                },
              },
            },
          },
        ],
      },
      this.buildMarketplaceInventoryWhereFilter(),
    ];

    if (
      gender &&
      ['MALE', 'FEMALE', 'EVERYBODY'].includes(gender.toUpperCase())
    ) {
      where.gender = gender.toUpperCase() as CollectionType;
    }

    if (minPrice !== undefined || maxPrice !== undefined) {
      where.price = {};
      if (minPrice !== undefined) where.price.gte = minPrice;
      if (maxPrice !== undefined) where.price.lte = maxPrice;
    }

    if (sizes && sizes.length > 0) {
      where.sizes = { hasSome: sizes };
    }

    if (colors && colors.length > 0) {
      where.colors = { hasSome: colors };
    }

    if (tags && tags.length > 0) {
      const normalized = this.buildTagSet(tags);
      if (normalized.length > 0) {
        where.tags = { hasSome: normalized };
      }
    }

    if (typeof isFeatured === 'boolean') {
      where.isFeatured = isFeatured;
    }

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

    if (category) {
      andFilters.push({
        collections: {
          some: {
            collection: { category: { slug: category } },
          },
        },
      });
    }

    if (collectionId) {
      andFilters.push({
        collections: { some: { collectionId } },
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
          categoryType: {
            select: { id: true, categoryId: true, slug: true, name: true },
          },
          variants: {
            select: {
              id: true,
              size: true,
              color: true,
              stock: true,
              price: true,
              sku: true,
              colorHex: true,
            },
          },
        },
      }),
      this.prisma.product.count({ where }),
    ]);

    const nextCursor = products.length > 0 ? products[products.length - 1].id : null;

    const baseItems = products.map((p) => this.transformProduct(p));
    const productFilterRows = await this.getProductFilterRows(
      baseItems.map((item: any) => item.id).filter(Boolean),
    );
    const productFilterMap = this.buildProductFilterPayloadByProductId(
      productFilterRows,
    );
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
      const filterPayload = productFilterMap.get(base.id) ?? {
        filters: [],
        filterValueIds: [],
        filterSelection: {},
      };
      if (images.length === 0) {
        return {
          ...base,
          ...filterPayload,
          media: [],
          mediaIds: [],
        };
      }
      const media = images.map((url: string) => ({
        id: idByUrl.get(url) ?? url,
        url,
        type: 'image',
        isPrimary: !!base.thumbnail && url === base.thumbnail,
      }));
      return {
        ...base,
        ...filterPayload,
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
        OR: [
          { collections: { none: {} } },
          {
            collections: {
              some: {
                collection: {
                  isAvailableInStore: true,
                  status: 'PUBLISHED',
                  deletedAt: null,
                },
              },
            },
          },
        ],
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
    if (
      (hasVariantSizes || product.sizes.length > 0) &&
      !dto.selectedSize
    ) {
      throw new BadRequestException('Please select a size');
    }
    if (dto.selectedSize && !product.sizes.includes(dto.selectedSize)) {
      throw new BadRequestException('Invalid size selected');
    }

    // Validate color
    if (
      (hasVariantColors || product.colors.length > 0) &&
      !dto.selectedColor
    ) {
      throw new BadRequestException('Please select a color');
    }
    if (dto.selectedColor && !product.colors.includes(dto.selectedColor)) {
      throw new BadRequestException('Invalid color selected');
    }

    const sizingPayload = this.resolveCartItemSizing(
      product,
      {
        sizingMode: dto.sizingMode,
        requiredMeasurementKeys: dto.requiredMeasurementKeys,
        sizeFitData: dto.sizeFitData ?? null,
      },
      product.name,
    );

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
    const selectedVariant =
      variants.length > 0
        ? variants.find(
            (v) =>
              (v.size || null) === (dto.selectedSize || null) &&
              (v.color || null) === (dto.selectedColor || null),
          )
        : null;

    if (resultingQuantity > 99) {
      throw new BadRequestException(
        'Cart quantity limit exceeded for this item (max 99)',
      );
    }

    if (variants.length > 0 && !selectedVariant) {
      throw new BadRequestException('Selected variant is not available');
    }

    // Check stock (variant-aware)
    if (
      product.trackInventory &&
      !product.allowBackorders
    ) {
      if (selectedVariant) {
        const available = Number(selectedVariant.stock || 0);
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

    await this.prisma.$transaction(async (tx) => {
      if (existingItem) {
        await tx.cartItem.update({
          where: { id: existingItem.id },
          data: {
            quantity: resultingQuantity,
            sizingMode: sizingPayload.sizingMode,
            requiredMeasurementKeys: sizingPayload.requiredMeasurementKeys,
            sizeFitData: sizingPayload.sizeFitData,
          },
        });
      } else {
        await tx.cartItem.create({
          data: {
            id: uuidv4(),
            userId,
            productId: dto.productId,
            quantity: quantityToAdd,
            selectedSize: dto.selectedSize || null,
            selectedColor: dto.selectedColor || null,
            sizingMode: sizingPayload.sizingMode,
            requiredMeasurementKeys: sizingPayload.requiredMeasurementKeys,
            sizeFitData: sizingPayload.sizeFitData,
          },
        });
      }

    });

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
                collection: {
                  select: {
                    id: true,
                    status: true,
                    isAvailableInStore: true,
                    deletedAt: true,
                  },
                },
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

      const isProductAvailable =
        !product.deletedAt &&
        product.isActive &&
        Boolean(product.brand?.isStoreOpen) &&
        product.brand?.ownerId !== userId &&
        this.hasPublicStoreAccess(product) &&
        this.isProductPubliclyInventoryEligible(product);

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
          if (
            !match ||
            available <= 0
          ) {
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
        sizingMode: item.sizingMode,
        requiredMeasurementKeys: item.requiredMeasurementKeys,
        sizeFitData:
          item.sizeFitData && typeof item.sizeFitData === 'object'
            ? item.sizeFitData
            : null,
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

  private resolveWishlistAvailability(product: any, userId: string): {
    status:
      | 'AVAILABLE'
      | 'OUT_OF_STOCK'
      | 'ARCHIVED'
      | 'DELETED'
      | 'UNPUBLISHED'
      | 'STORE_CLOSED'
      | 'OWN_PRODUCT';
    reason:
      | 'available'
      | 'out_of_stock'
      | 'archived'
      | 'deleted'
      | 'not_in_store'
      | 'store_closed'
      | 'own_product';
    isAvailable: boolean;
    canAddToCart: boolean;
  } {
    if (product.deletedAt) {
      return {
        status: 'DELETED',
        reason: 'deleted',
        isAvailable: false,
        canAddToCart: false,
      };
    }

    if (product.archivedAt || !product.isActive) {
      return {
        status: 'ARCHIVED',
        reason: 'archived',
        isAvailable: false,
        canAddToCart: false,
      };
    }

    if (!product.brand?.isStoreOpen) {
      return {
        status: 'STORE_CLOSED',
        reason: 'store_closed',
        isAvailable: false,
        canAddToCart: false,
      };
    }

    if (product.brand?.ownerId === userId) {
      return {
        status: 'OWN_PRODUCT',
        reason: 'own_product',
        isAvailable: false,
        canAddToCart: false,
      };
    }

    if (!this.hasPublicStoreAccess(product)) {
      return {
        status: 'UNPUBLISHED',
        reason: 'not_in_store',
        isAvailable: false,
        canAddToCart: false,
      };
    }

    const isOutOfStock =
      Boolean(product.trackInventory) &&
      !product.allowBackorders &&
      Number(product.totalStock ?? 0) <= 0 &&
      !this.shouldAllowCustomOrderCarry(product);

    if (isOutOfStock) {
      return {
        status: 'OUT_OF_STOCK',
        reason: 'out_of_stock',
        isAvailable: false,
        canAddToCart: false,
      };
    }

    return {
      status: 'AVAILABLE',
      reason: 'available',
      isAvailable: true,
      canAddToCart: true,
    };
  }

  async addToWishlist(userId: string, dto: AddToWishlistDto) {
    const product = await this.prisma.product.findFirst({
      where: {
        id: dto.productId,
        deletedAt: null,
        isActive: true,
        brand: { isStoreOpen: true },
        OR: [
          { collections: { none: {} } },
          {
            collections: {
              some: {
                collection: {
                  isAvailableInStore: true,
                  status: 'PUBLISHED',
                  deletedAt: null,
                },
              },
            },
          },
        ],
      },
      include: {
        brand: {
          select: {
            ownerId: true,
          },
        },
        variants: {
          select: {
            size: true,
          },
        },
      },
    });

    if (!product) {
      throw new NotFoundException('Product not found');
    }
    if (!this.isProductPubliclyInventoryEligible(product)) {
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
    const deleted = await this.prisma.wishlistItem.deleteMany({
      where: { userId, productId },
    });

    return {
      success: true,
      message:
        deleted.count > 0 ? 'Removed from wishlist' : 'Item already removed',
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
                  collection: {
                    select: {
                      id: true,
                      status: true,
                      isAvailableInStore: true,
                      deletedAt: true,
                    },
                  },
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

    // Keep wishlist immutable on read: expose availability state instead of
    // deleting items when products become unavailable.
    const wishlistItems = items.map((item) => {
      const availability = this.resolveWishlistAvailability(item.product, userId);
      return {
        id: item.id,
        addedAt: item.createdAt,
        product: this.transformProduct(item.product),
        availabilityStatus: availability.status,
        availabilityReason: availability.reason,
        isAvailable: availability.isAvailable,
        canAddToCart: availability.canAddToCart,
      };
    });

    return {
      items: wishlistItems,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  async isInWishlist(userId: string, productId: string) {
    const item = await this.prisma.wishlistItem.findUnique({
      where: {
        userId_productId: { userId, productId },
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

  private hasPublicStoreAccess(product: { collections?: Array<any> } | null | undefined): boolean {
    const links = Array.isArray(product?.collections) ? product.collections : [];
    if (links.length === 0) return true;

    return links.some((link: any) => {
      const collection = link?.collection;
      if (!collection) return false;
      if (collection.deletedAt) return false;
      return collection.isAvailableInStore && collection.status === 'PUBLISHED';
    });
  }

  private isProductPubliclyAvailable(product: {
    deletedAt?: Date | null;
    archivedAt?: Date | null;
    isActive?: boolean | null;
    brand?: { isStoreOpen?: boolean | null } | null;
    collections?: Array<any> | null;
    totalStock?: number | null;
    customOrderEnabled?: boolean | null;
    variants?: Array<{ size?: string | null } | null> | null;
  }): boolean {
    if (product.deletedAt || product.archivedAt || product.isActive === false) {
      return false;
    }

    if (!product.brand?.isStoreOpen) {
      return false;
    }

    if (!this.hasPublicStoreAccess(product)) {
      return false;
    }

    return this.isProductPubliclyInventoryEligible(product);
  }

  private shouldAllowCustomOrderCarry(product: {
    totalStock?: number | null;
    customOrderEnabled?: boolean | null;
    variants?: Array<{ size?: string | null } | null> | null;
  }): boolean {
    return this.canBagOutOfStockCustomOrderProduct(product);
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
      categoryId: product.categoryId ?? null,
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
      sizingMode: this.normalizeSizingMode(product.sizingMode),
      customMeasurementKeys: this.normalizeRequiredMeasurementKeys(
        product.customMeasurementKeys,
      ),
      standardCheckoutEnabled: product.standardCheckoutEnabled !== false,
      customOrderEnabled: product.customOrderEnabled === true,
      customAvailable: product.customOrderEnabled === true,
      customOrderOutOfStockTriggeredAt:
        product.customOrderOutOfStockTriggeredAt ?? null,
      customOrderOutOfStockReminderSentAt:
        product.customOrderOutOfStockReminderSentAt ?? null,
      customOrderOutOfStockDiscontinueAt:
        product.customOrderOutOfStockDiscontinueAt ?? null,
      isCustomOrderOnly: this.shouldAllowCustomOrderCarry(product),
      canBagWhenOutOfStock: this.shouldAllowCustomOrderCarry(product),
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
      subCategoryId: product.categoryTypeId ?? null,
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

  private normalizeSizingMode(value?: string | null): SizingMode {
    const normalized = String(value ?? '')
      .trim()
      .toUpperCase();
    switch (normalized) {
      case 'RTW':
        return SizingMode.RTW;
      case 'CUSTOM':
      case 'RTW_PLUS_FITTINGS':
      case 'RTW_PLUS_CUSTOM':
        return SizingMode.RTW_PLUS_FITTINGS;
      default:
        return SizingMode.NONE;
    }
  }

  private normalizeRequiredMeasurementKeys(raw?: unknown): string[] {
    if (!Array.isArray(raw)) return [];
    return Array.from(
      new Set(
        raw
          .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
          .filter((entry) => entry.length > 0),
      ),
    );
  }

  private normalizeSizeFitData(raw?: unknown): Record<string, any> | null {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return null;
    }
    return raw as Record<string, any>;
  }

  private extractProvidedMeasurementKeys(sizeFitData: Record<string, any> | null): string[] {
    if (!sizeFitData) return [];

    const measurements =
      sizeFitData.measurements &&
      typeof sizeFitData.measurements === 'object' &&
      !Array.isArray(sizeFitData.measurements)
        ? (sizeFitData.measurements as Record<string, any>)
        : null;

    if (measurements) {
      return Object.keys(measurements).filter((key) => {
        const value = measurements[key];
        if (value == null) return false;
        if (typeof value === 'number') return Number.isFinite(value);
        if (typeof value === 'object' && value !== null) {
          const numericValue = (value as any).value;
          return typeof numericValue === 'number' && Number.isFinite(numericValue);
        }
        return false;
      });
    }

    return Object.keys(sizeFitData).filter((key) => {
      const value = sizeFitData[key];
      return typeof value === 'number' && Number.isFinite(value);
    });
  }

  private resolveCartItemSizing(
    product: any,
    payload: {
      sizingMode?: string | null;
      requiredMeasurementKeys?: string[] | null;
      sizeFitData?: Record<string, any> | null;
    },
    productNameForError?: string,
  ): {
    sizingMode: SizingMode;
    requiredMeasurementKeys: string[];
    sizeFitData: Record<string, any> | null;
  } {
    const productName = productNameForError || product?.name || 'product';
    const productSizingMode = this.normalizeSizingMode(product?.sizingMode);
    const requestSizingMode = this.normalizeSizingMode(payload?.sizingMode);
    const sizingMode =
      requestSizingMode === SizingMode.NONE ? productSizingMode : requestSizingMode;

    const productRequiredKeys = this.normalizeRequiredMeasurementKeys(
      product?.customMeasurementKeys,
    );
    const requestedKeys = this.normalizeRequiredMeasurementKeys(
      payload?.requiredMeasurementKeys,
    );

    const requiredMeasurementKeys =
      requestedKeys.length > 0
        ? requestedKeys.filter((key) => productRequiredKeys.includes(key))
        : productRequiredKeys;

    const sizeFitData = this.normalizeSizeFitData(payload?.sizeFitData);

    if (
      sizingMode === SizingMode.RTW_PLUS_FITTINGS &&
      requiredMeasurementKeys.length > 0
    ) {
      const providedKeys = this.extractProvidedMeasurementKeys(sizeFitData);
      const missingKeys = requiredMeasurementKeys.filter(
        (key) => !providedKeys.includes(key),
      );
      if (missingKeys.length > 0) {
        throw new BadRequestException(
          `Missing required measurements for ${productName}: ${missingKeys.join(', ')}`,
        );
      }
    }

    return {
      sizingMode,
      requiredMeasurementKeys,
      sizeFitData,
    };
  }

  private getOrderLineItems(order: any): Array<{
    productId?: string;
    name?: string;
    thumbnail?: string | null;
    price?: number;
    quantity?: number;
    selectedSize?: string | null;
    selectedColor?: string | null;
    sizingMode?: SizingMode | string;
    requiredMeasurementKeys?: string[];
    sizeFitSnapshot?: Record<string, any> | null;
  }> {
    const relationalItems = Array.isArray(order?.orderItems) ? order.orderItems : [];
    if (relationalItems.length > 0) {
      return relationalItems.map((item: any) => ({
        productId: item.productId,
        name: item.nameAtPurchase ?? undefined,
        thumbnail: item.thumbnailAtPurchase ?? null,
        price:
          typeof item.unitPrice === 'number'
            ? item.unitPrice
            : Number(item.unitPrice ?? 0),
        quantity: item.quantity,
        selectedSize: item.selectedSize ?? null,
        selectedColor: item.selectedColor ?? null,
        sizingMode: item.sizingMode,
        requiredMeasurementKeys: this.normalizeRequiredMeasurementKeys(
          item.requiredMeasurementKeys,
        ),
        sizeFitSnapshot:
          item.sizeFitSnapshot &&
          typeof item.sizeFitSnapshot === 'object' &&
          !Array.isArray(item.sizeFitSnapshot)
            ? item.sizeFitSnapshot
            : null,
      }));
    }

    return Array.isArray(order?.items) ? (order.items as any[]) : [];
  }

  private orderContainsProduct(order: any, productId: string): boolean {
    const items = this.getOrderLineItems(order);
    return items.some((item) => item?.productId === productId);
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

        const orderItems: Array<{
          productId: string;
          name: string;
          thumbnail: string | null;
          price: number;
          quantity: number;
          selectedSize: string | null;
          selectedColor: string | null;
          sizingMode: SizingMode;
          requiredMeasurementKeys: string[];
          sizeFitSnapshot: Record<string, any> | null;
        }> = [];
        let totalAmount = 0;

        for (const item of items) {
          const product = await tx.product.findFirst({
            where: { id: item.productId, deletedAt: null },
            include: {
              brand: { select: { ownerId: true, isStoreOpen: true } },
              collection: true,
              collections: { include: { collection: true } },
              variants: true,
            },
          });

          if (!product || !product.isActive) {
            throw new BadRequestException('Product not available');
          }

          if (!this.isProductPubliclyAvailable(product)) {
            throw new BadRequestException(
              `Product not available in store: ${product.name}`,
            );
          }

          const variants = Array.isArray((product as any).variants)
            ? ((product as any).variants as any[])
            : [];
          const hasVariantSizes = variants.some((v) => v.size);
          const hasVariantColors = variants.some((v) => v.color);
          if (
            (hasVariantSizes || product.sizes.length > 0) &&
            !item.selectedSize
          ) {
            throw new BadRequestException(`Please select a size for ${product.name}`);
          }
          if (item.selectedSize && product.sizes.length > 0 && !product.sizes.includes(item.selectedSize)) {
            throw new BadRequestException(`Invalid size for ${product.name}`);
          }

          if (
            (hasVariantColors || product.colors.length > 0) &&
            !item.selectedColor
          ) {
            throw new BadRequestException(`Please select a color for ${product.name}`);
          }
          if (item.selectedColor && product.colors.length > 0 && !product.colors.includes(item.selectedColor)) {
            throw new BadRequestException(`Invalid color for ${product.name}`);
          }

          const sizingPayload = this.resolveCartItemSizing(
            product,
            {
              sizingMode: item.sizingMode,
              requiredMeasurementKeys: item.requiredMeasurementKeys,
              sizeFitData:
                item.sizeFitData && typeof item.sizeFitData === 'object'
                  ? (item.sizeFitData as Record<string, any>)
                  : null,
            },
            product.name,
          );

          const quantity = item.quantity;

          await this.lockProductForUpdate(tx, product.id);

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
          if (
            product.trackInventory &&
            !product.allowBackorders
          ) {
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
            thumbnail: product.thumbnail ?? null,
            price: unitPrice,
            quantity,
            selectedSize: item.selectedSize || null,
            selectedColor: item.selectedColor || null,
            sizingMode: sizingPayload.sizingMode,
            requiredMeasurementKeys: sizingPayload.requiredMeasurementKeys,
            sizeFitSnapshot: sizingPayload.sizeFitData,
          });
        }

        const shippingState = (dto.shippingAddress as any)?.state ?? '';
        const shippingCost = shippingState ? calculateShipping(shippingState) : 0;

        const order = await tx.order.create({
          data: {
            id: uuidv4(),
            brandId,
            buyerId: userId,
            customerName: dto.customerName || 'Customer',
            shippingAddress: (dto.shippingAddress as Record<string, any>) || null,
            contactInfo: {
              ...(dto.contactInfo || {}),
              ...(sizeFitSnapshot ? { sizeFitSnapshot } : {}),
            } as any,
            items: orderItems,
            totalAmount: new Prisma.Decimal((totalAmount + shippingCost).toFixed(2)),
            shippingCost: new Prisma.Decimal(shippingCost.toFixed(2)),
            currency: brand.currency || 'NGN',
            status: 'PENDING',
            paymentStatus: 'PENDING',
            paymentMethod: (dto as any).paymentMethod || 'PENDING_SELECTION',
            promoCode: (dto as any).promoCode || null,
          },
        });

        if (orderItems.length > 0) {
          await tx.orderItem.createMany({
            data: orderItems.map((item) => ({
              id: uuidv4(),
              orderId: order.id,
              productId: item.productId,
              brandId,
              buyerId: userId,
              quantity: item.quantity,
              currency: brand.currency || 'NGN',
              unitPrice: new Prisma.Decimal(item.price.toFixed(2)),
              totalPrice: new Prisma.Decimal((item.price * item.quantity).toFixed(2)),
              selectedSize: item.selectedSize,
              selectedColor: item.selectedColor,
              sizingMode: item.sizingMode,
              requiredMeasurementKeys: item.requiredMeasurementKeys,
              sizeFitSnapshot: item.sizeFitSnapshot,
              thumbnailAtPurchase: item.thumbnail,
              nameAtPurchase: item.name,
            })),
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
          orderItems: {
            select: {
              id: true,
              productId: true,
              quantity: true,
              unitPrice: true,
              selectedSize: true,
              selectedColor: true,
              sizingMode: true,
              requiredMeasurementKeys: true,
              sizeFitSnapshot: true,
              thumbnailAtPurchase: true,
              nameAtPurchase: true,
            },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.order.count({ where: { buyerId: userId } }),
    ]);

    const reviewStatesByOrderItemId = await this.getReviewStateByOrderItemId(
      userId,
      orders.flatMap((order) => order.orderItems),
      orders,
    );
    const paymentStatusByOrderId = await reconcileStandardOrderPaymentStatuses(this.prisma, orders);
    const paidOrderIds = orders
      .filter((order) => paymentStatusByOrderId.get(order.id) === PaymentStatus.PAID)
      .map((order) => order.id);
    if (paidOrderIds.length > 0 && this.standardOrderFinanceSyncService) {
      await this.standardOrderFinanceSyncService.syncPaidOrdersByOrderIds(paidOrderIds);
    }

    const normalizedOrders = orders.map((order) => ({
      ...order,
      paymentStatus:
        paymentStatusByOrderId.get(order.id) ?? order.paymentStatus,
      items: this.getOrderLineItems(order),
      orderItems: order.orderItems.map((item) => ({
        ...item,
        orderItemId: item.id,
        productName: item.nameAtPurchase,
        thumbnail: item.thumbnailAtPurchase,
        reviewState: reviewStatesByOrderItemId.get(item.id)?.reviewState ?? 'NOT_DELIVERED',
        existingReviewId:
          reviewStatesByOrderItemId.get(item.id)?.existingReviewId ?? null,
      })),
    }));

    return {
      items: normalizedOrders,
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
        brand: {
          select: {
            id: true,
            name: true,
            logo: true,
            currency: true,
            contactEmail: true,
            owner: { select: { phoneNumber: true, address: true } },
          },
        },
        orderItems: {
          select: {
            id: true,
            productId: true,
            quantity: true,
            unitPrice: true,
            selectedSize: true,
            selectedColor: true,
            sizingMode: true,
            requiredMeasurementKeys: true,
            sizeFitSnapshot: true,
            thumbnailAtPurchase: true,
            nameAtPurchase: true,
          },
        },
      },
    });

    if (!order) {
      throw new NotFoundException('Order not found');
    }

    const reviewStatesByOrderItemId = await this.getReviewStateByOrderItemId(
      userId,
      order.orderItems,
      [order],
    );
    const paymentStatusByOrderId = await reconcileStandardOrderPaymentStatuses(this.prisma, [order]);
    if (
      paymentStatusByOrderId.get(order.id) === PaymentStatus.PAID &&
      this.standardOrderFinanceSyncService
    ) {
      await this.standardOrderFinanceSyncService.syncPaidOrdersByOrderIds([order.id]);
    }

    const financeSnapshot = await this.buildStandardOrderFinanceSnapshot(order);

    return {
      ...order,
      paymentStatus:
        paymentStatusByOrderId.get(order.id) ?? order.paymentStatus,
      financeBreakdown: financeSnapshot.breakdown,
      buyerReceipt: financeSnapshot.receipt,
      items: this.getOrderLineItems(order),
      orderItems: order.orderItems.map((item) => ({
        ...item,
        orderItemId: item.id,
        productName: item.nameAtPurchase,
        thumbnail: item.thumbnailAtPurchase,
        reviewState: reviewStatesByOrderItemId.get(item.id)?.reviewState ?? 'NOT_DELIVERED',
        existingReviewId:
          reviewStatesByOrderItemId.get(item.id)?.existingReviewId ?? null,
      })),
    };
  }

  private async buildStandardOrderFinanceSnapshot(order: {
    id: string;
    paymentReference?: string | null;
    paymentStatus?: PaymentStatus | string | null;
    totalAmount: Prisma.Decimal | number;
    shippingCost?: Prisma.Decimal | number | null;
    discountAmount?: Prisma.Decimal | number | null;
    currency?: string | null;
    paidAt?: Date | string | null;
    createdAt?: Date | string | null;
    orderItems?: Array<{
      quantity?: number | null;
      unitPrice?: Prisma.Decimal | number | null;
      totalPrice?: Prisma.Decimal | number | null;
      nameAtPurchase?: string | null;
    }>;
  }) {
    const paymentAttempt = order.paymentReference
      ? await this.prisma.paymentAttempt.findFirst({
          where: { reference: order.paymentReference },
          select: {
            id: true,
            reference: true,
            amount: true,
            currency: true,
            settlementAmount: true,
            settlementCurrency: true,
            confirmedAt: true,
          },
        })
      : null;

    const [hold, receipt, ledgerTransactions] = await Promise.all([
      this.prisma.escrowHold.findUnique({
        where: { orderId: order.id },
        select: {
          totalAmount: true,
          commissionRate: true,
          commissionAmount: true,
          netBrandAmount: true,
          currency: true,
          status: true,
          firstReleaseAmount: true,
          firstReleaseCommissionAmount: true,
          firstReleaseNetAmount: true,
          firstReleasedAt: true,
          secondReleaseAmount: true,
          secondReleaseCommissionAmount: true,
          secondReleaseNetAmount: true,
          secondReleaseEligibleAt: true,
          secondReleaseCondition: true,
          secondReleasedAt: true,
          refundedAt: true,
          refundReason: true,
        },
      }),
      (this.prisma as any).financialDocument.findFirst({
        where: {
          type: 'BUYER_RECEIPT',
          OR: [
            ...(paymentAttempt?.id ? [{ paymentAttemptId: paymentAttempt.id }] : []),
            { orderId: order.id },
          ],
        },
        orderBy: { issuedAt: 'desc' },
      }),
      (this.prisma as any).ledgerTransaction.findMany({
        where: {
          referenceType: 'Order',
          referenceId: order.id,
        },
        orderBy: { createdAt: 'asc' },
        include: {
          entries: {
            include: {
              account: {
                select: {
                  code: true,
                  name: true,
                  type: true,
                  subType: true,
                  entityType: true,
                  entityId: true,
                },
              },
            },
          },
        },
      }),
    ]);

    const itemSubtotal = this.roundCurrency(
      Array.isArray(order.orderItems)
        ? order.orderItems.reduce((sum, item) => {
            if (item.totalPrice != null) {
              return sum + Number(item.totalPrice);
            }
            return sum + Number(item.unitPrice ?? 0) * Number(item.quantity ?? 0);
          }, 0)
        : 0,
    );
    const shippingAmount = this.roundCurrency(Number(order.shippingCost ?? 0));
    const discountAmount = this.roundCurrency(Number(order.discountAmount ?? 0));
    const grossAmount = this.roundCurrency(Number(order.totalAmount ?? 0));
    const receiptMetadata = this.asJsonObject(receipt?.metadataJson);

    return {
      breakdown: {
        currency: String(order.currency || paymentAttempt?.currency || hold?.currency || 'NGN'),
        itemSubtotal,
        shippingAmount,
        discountAmount,
        grossAmount,
        paymentReference: order.paymentReference ?? paymentAttempt?.reference ?? null,
        paymentStatus: order.paymentStatus ?? null,
        paidAt: order.paidAt ?? paymentAttempt?.confirmedAt ?? null,
        escrowStatus: hold?.status ?? null,
        commissionRate: hold ? Number(hold.commissionRate ?? 0) : null,
        commissionAmount: hold ? this.roundCurrency(Number(hold.commissionAmount ?? 0)) : null,
        netBrandAmount: hold ? this.roundCurrency(Number(hold.netBrandAmount ?? 0)) : null,
        releaseSchedule: hold
          ? [
              {
                stage: 'SHIPPED_RELEASE',
                grossAmount: this.roundCurrency(Number(hold.firstReleaseAmount ?? 0)),
                commissionAmount: this.roundCurrency(
                  Number(hold.firstReleaseCommissionAmount ?? 0),
                ),
                netAmount: this.roundCurrency(Number(hold.firstReleaseNetAmount ?? 0)),
                releasedAt: hold.firstReleasedAt ?? null,
              },
              {
                stage: 'DELIVERED_RELEASE',
                grossAmount: this.roundCurrency(Number(hold.secondReleaseAmount ?? 0)),
                commissionAmount: this.roundCurrency(
                  Number(hold.secondReleaseCommissionAmount ?? 0),
                ),
                netAmount: this.roundCurrency(Number(hold.secondReleaseNetAmount ?? 0)),
                eligibleAt: hold.secondReleaseEligibleAt ?? null,
                condition: hold.secondReleaseCondition ?? null,
                releasedAt: hold.secondReleasedAt ?? null,
              },
            ]
          : [],
        ledgerTransactions: Array.isArray(ledgerTransactions)
          ? ledgerTransactions.map((transaction: any) => ({
              id: transaction.id,
              type: transaction.type,
              description: transaction.description,
              totalAmount: this.roundCurrency(Number(transaction.totalAmount ?? 0)),
              currency: transaction.currency,
              createdAt: transaction.createdAt,
              entries: Array.isArray(transaction.entries)
                ? transaction.entries.map((entry: any) => ({
                    id: entry.id,
                    direction: entry.direction,
                    amount: this.roundCurrency(Number(entry.amount ?? 0)),
                    accountCode: entry.account?.code ?? null,
                    accountName: entry.account?.name ?? null,
                    accountType: entry.account?.type ?? null,
                    accountSubType: entry.account?.subType ?? null,
                  }))
                : [],
            }))
          : [],
      },
      receipt: receipt
        ? {
            id: receipt.id,
            documentNumber: receipt.documentNumber,
            type: receipt.type,
            issuedAt: receipt.issuedAt,
            currency: receipt.currency,
            grossAmount: this.roundCurrency(Number(receipt.grossAmount ?? 0)),
            commissionAmount:
              receipt.commissionAmount != null
                ? this.roundCurrency(Number(receipt.commissionAmount))
                : null,
            netAmount:
              receipt.netAmount != null
                ? this.roundCurrency(Number(receipt.netAmount))
                : null,
            paymentAttemptId: receipt.paymentAttemptId ?? paymentAttempt?.id ?? null,
            paymentReference: paymentAttempt?.reference ?? order.paymentReference ?? null,
            settlementCurrency:
              typeof receiptMetadata?.settlementCurrency === 'string'
                ? receiptMetadata.settlementCurrency
                : paymentAttempt?.settlementCurrency ?? null,
            settlementAmount:
              receiptMetadata?.settlementAmount != null
                ? this.roundCurrency(Number(receiptMetadata.settlementAmount))
                : paymentAttempt?.settlementAmount != null
                  ? this.roundCurrency(Number(paymentAttempt.settlementAmount))
                  : null,
            issuedToName:
              typeof receiptMetadata?.issuedToName === 'string'
                ? receiptMetadata.issuedToName
                : null,
            lineItems: Array.isArray(receiptMetadata?.lineItems)
              ? receiptMetadata.lineItems
                  .map((item) => {
                    const raw = this.asJsonObject(item);
                    return {
                      label:
                        typeof raw?.label === 'string'
                          ? raw.label
                          : `Order ${order.id.slice(0, 8)}`,
                      amount: this.roundCurrency(Number(raw?.amount ?? 0)),
                    };
                  })
                  .filter((item) => item.amount >= 0)
              : [],
          }
        : null,
    };
  }

  private asJsonObject(value: unknown): Record<string, any> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, any>)
      : null;
  }

  private roundCurrency(value: number) {
    return Math.round((value + Number.EPSILON) * 100) / 100;
  }

  async confirmOrderDelivery(userId: string, orderId: string, note?: string) {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, buyerId: userId },
      select: {
        id: true,
        status: true,
        paymentStatus: true,
        buyerConfirmedDeliveryAt: true,
        brandId: true,
        brand: {
          select: {
            ownerId: true,
            name: true,
          },
        },
      },
    });

    if (!order) {
      throw new NotFoundException('Order not found');
    }

    // Buyer can confirm delivery when order is SHIPPED (new flow) or DELIVERED (legacy)
    if (order.status !== OrderStatus.SHIPPED && order.status !== OrderStatus.DELIVERED) {
      throw new BadRequestException('Only shipped or delivered orders can be confirmed');
    }

    if (order.paymentStatus !== PaymentStatus.PAID) {
      throw new BadRequestException('Only paid orders can be confirmed');
    }

    if (order.buyerConfirmedDeliveryAt) {
      throw new ConflictException('Order delivery has already been confirmed');
    }

    const previousStatus = order.status;
    await this.prisma.$transaction(async (tx) => {
      await tx.order.update({
        where: { id: orderId },
        data: {
          // Move to DELIVERED + set buyer confirmation in one step
          status: OrderStatus.DELIVERED,
          deliveredAt: new Date(),
          buyerConfirmedDeliveryAt: new Date(),
        },
      });

      if (this.standardOrderEscrowService) {
        await this.standardOrderEscrowService.markBuyerDeliveryConfirmed(tx, orderId);
      }
    });

    if (this.notifications && order.brand?.ownerId) {
      await this.notifications
        .create(order.brand.ownerId, NotificationType.ORDER_STATUS_UPDATED, {
          actorId: userId,
          payload: {
            orderId,
            status: 'DELIVERED',
            previousStatus,
            buyerConfirmedDelivery: true,
            note: note?.trim() || null,
            targetUrl: `/studio?tab=orders&orderId=${orderId}`,
          },
        })
        .catch(() => undefined);
    }

    return this.getMyOrder(userId, orderId);
  }

  async cancelMyOrder(userId: string, orderId: string, reason?: string) {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, buyerId: userId },
      select: {
        id: true,
        status: true,
        paymentStatus: true,
        brandId: true,
      },
    });

    if (!order) {
      throw new NotFoundException('Order not found');
    }

    if (order.status !== 'PENDING') {
      throw new BadRequestException('Only pending orders can be cancelled by buyer');
    }

    const updated = await this.prisma.order.update({
      where: { id: orderId },
      data: { status: 'CANCELLED' },
    });

    if (this.notifications) {
      await this.notifications
        .create(order.brandId, NotificationType.ORDER_STATUS_UPDATED, {
          actorId: userId,
          payload: {
            orderId,
            status: 'CANCELLED',
            previousStatus: 'PENDING',
            reason: reason ?? null,
            cancelledByBuyer: true,
            targetUrl: `/studio?tab=orders&orderId=${orderId}`,
          },
        })
        .catch(() => undefined);
    }

    return updated;
  }

  private async getReviewStateByOrderItemId(
    userId: string,
    orderItems: Array<{ id: string; productId: string | null }>,
    orders: Array<{ id: string; status: string; orderItems: Array<{ id: string }> }>,
  ) {
    if (orderItems.length === 0) {
      return new Map<string, { reviewState: string; existingReviewId: string | null }>();
    }

    const productIds = Array.from(
      new Set(
        orderItems
          .map((item) => item.productId)
          .filter((productId): productId is string => Boolean(productId)),
      ),
    );
    const orderItemIds = orderItems.map((item) => item.id);
    const deliveredOrderIds = new Set(
      orders.filter((order) => order.status === 'DELIVERED').map((order) => order.id),
    );

    const [existingReviews, openDisputes] = await Promise.all([
      productIds.length > 0
        ? this.prisma.productReview.findMany({
            where: {
              userId,
              productId: { in: productIds },
              status: { not: 'DELETED_BY_USER' as any },
            },
            select: {
              id: true,
              productId: true,
            },
            orderBy: { createdAt: 'desc' },
          })
        : Promise.resolve([]),
      this.prisma.sizingDispute.findMany({
        where: {
          orderItemId: { in: orderItemIds },
          status: { in: ['OPEN', 'IN_PROGRESS'] as any },
        },
        select: { orderItemId: true },
      }),
    ]);

    const reviewByProductId = new Map<string, string>();
    for (const review of existingReviews) {
      if (!reviewByProductId.has(review.productId)) {
        reviewByProductId.set(review.productId, review.id);
      }
    }

    const disputeOrderItemIds = new Set(openDisputes.map((dispute) => dispute.orderItemId));
    const orderIdByOrderItemId = new Map<string, string>();
    for (const order of orders) {
      for (const item of order.orderItems) {
        orderIdByOrderItemId.set(item.id, order.id);
      }
    }

    const states = new Map<string, { reviewState: string; existingReviewId: string | null }>();
    for (const item of orderItems) {
      const orderId = orderIdByOrderItemId.get(item.id);
      const existingReviewId = item.productId ? reviewByProductId.get(item.productId) ?? null : null;

      if (!orderId || !deliveredOrderIds.has(orderId)) {
        states.set(item.id, { reviewState: 'NOT_DELIVERED', existingReviewId });
        continue;
      }

      if (existingReviewId) {
        states.set(item.id, { reviewState: 'ALREADY_REVIEWED', existingReviewId });
        continue;
      }

      if (disputeOrderItemIds.has(item.id)) {
        states.set(item.id, { reviewState: 'BLOCKED_BY_DISPUTE', existingReviewId: null });
        continue;
      }

      states.set(item.id, { reviewState: 'CAN_CREATE', existingReviewId: null });
    }

    return states;
  }

  async resolveOrderAccess(
    user: { id: string; role?: string; type?: UserType },
    orderId: string,
  ) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        buyerId: true,
        brandId: true,
        brand: {
          select: {
            ownerId: true,
          },
        },
      },
    });

    if (!order) {
      throw new NotFoundException('Order not found');
    }

    if (order.buyerId && order.buyerId === user.id) {
      return {
        orderId: order.id,
        viewerRole: 'BUYER' as const,
        destination: `/orders/${order.id}`,
      };
    }

    if (order.brand?.ownerId === user.id) {
      return {
        orderId: order.id,
        viewerRole: 'BRAND' as const,
        destination: `/studio?tab=orders&orderId=${encodeURIComponent(order.id)}`,
      };
    }

    throw new ForbiddenException('You do not have access to this order');
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
    const paymentAccount =
      brand?.id != null
        ? await this.getStorePaymentAccountModel().findUnique({
            where: { brandId: brand.id },
          })
        : null;
    const completeness = brand
      ? this.computeStoreCompleteness(brand, paymentAccount)
      : { isComplete: false, missingFields: ['name', 'description', 'tags', 'paymentAccount'] };

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
      paymentAccount: this.summarizePaymentAccount(paymentAccount),
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

  private getStorePaymentAccountModel() {
    return (this.prisma as any).storePaymentAccount;
  }

  private getStorePaymentAccountSecret() {
    const secret = String(process.env.STORE_PAYMENT_ACCOUNT_SECRET ?? '').trim();
    if (!secret) {
      throw new BadRequestException(
        'STORE_PAYMENT_ACCOUNT_SECRET is required before brand payout accounts can be encrypted',
      );
    }
    return secret;
  }

  private getStorePaymentAccountEncryptionKey() {
    return createHash('sha256').update(this.getStorePaymentAccountSecret()).digest();
  }

  private getStorePaymentAccountDecryptionKeys() {
    const secrets = [
      String(process.env.STORE_PAYMENT_ACCOUNT_SECRET ?? '').trim(),
      String(process.env.VERIFICATION_DRAFT_SECRET ?? '').trim(),
    ].filter((value): value is string => Boolean(value));

    return Array.from(new Set(secrets)).map((secret) =>
      createHash('sha256').update(secret).digest(),
    );
  }

  private encryptStorePaymentValue(value: string) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.getStorePaymentAccountEncryptionKey(), iv);
    const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${iv.toString('base64')}.${tag.toString('base64')}.${encrypted.toString('base64')}`;
  }

  private decryptStorePaymentValue(value?: string | null) {
    if (!value) return null;
    try {
      const [ivText, tagText, encryptedText] = value.split('.');
      if (!ivText || !tagText || !encryptedText) return null;
      for (const key of this.getStorePaymentAccountDecryptionKeys()) {
        try {
          const decipher = createDecipheriv(
            'aes-256-gcm',
            key,
            Buffer.from(ivText, 'base64'),
          );
          decipher.setAuthTag(Buffer.from(tagText, 'base64'));
          return Buffer.concat([
            decipher.update(Buffer.from(encryptedText, 'base64')),
            decipher.final(),
          ]).toString('utf8');
        } catch {
          continue;
        }
      }
      return null;
    } catch {
      return null;
    }
  }

  private getRequiredPaystackSecret() {
    const secret = resolvePaystackSecret();
    if (!secret) {
      throw new BadRequestException(
        `Paystack secret is missing. Configure one of: ${describePaystackSecretEnvKeys()}`,
      );
    }
    return secret;
  }

  private normalizeBrandShippingRules(
    shippingRules: Record<string, any> | null | undefined,
  ): Prisma.JsonObject | null {
    if (!shippingRules || typeof shippingRules !== 'object' || Array.isArray(shippingRules)) {
      return null;
    }

    const nextRules = { ...shippingRules } as Record<string, any>;
    const nextOrderSettings =
      nextRules.orderSettings &&
      typeof nextRules.orderSettings === 'object' &&
      !Array.isArray(nextRules.orderSettings)
        ? { ...(nextRules.orderSettings as Record<string, unknown>) }
        : {};

    nextRules.orderSettings = {
      ...nextOrderSettings,
      orderProcessingMode: 'auto-confirm',
    };

    return nextRules as Prisma.JsonObject;
  }

  private async callPaystack<T = any>(
    path: string,
    init?: RequestInit & { bodyJson?: Record<string, unknown> },
  ): Promise<T> {
    const secret = this.getRequiredPaystackSecret();
    const { bodyJson, headers, ...rest } = init ?? {};
    const requestHeaders: Record<string, string> = {
      Authorization: `Bearer ${secret}`,
      Accept: 'application/json',
      ...(headers as Record<string, string> | undefined),
    };
    if (bodyJson) {
      requestHeaders['Content-Type'] = 'application/json';
    }

    const response = await fetch(`https://api.paystack.co${path}`, {
      ...rest,
      headers: requestHeaders,
      body: bodyJson ? JSON.stringify(bodyJson) : rest.body,
    });

    let payload: any = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }

    if (!response.ok || payload?.status === false) {
      throw new BadRequestException(
        String(payload?.message || 'Paystack request failed'),
      );
    }

    return (payload?.data ?? payload) as T;
  }

  private maskAccountNumber(value: string | null | undefined) {
    const digits = String(value ?? '').replace(/\D+/g, '');
    if (!digits) {
      return null;
    }
    if (digits.length <= 4) {
      return digits;
    }
    return `${'*'.repeat(Math.max(0, digits.length - 4))}${digits.slice(-4)}`;
  }

  private sanitizePaystackSnapshot(value: unknown): Prisma.JsonValue | null {
    if (Array.isArray(value)) {
      return value.map((entry) => this.sanitizePaystackSnapshot(entry)) as Prisma.JsonValue;
    }

    if (value && typeof value === 'object') {
      const output: Record<string, Prisma.JsonValue> = {};
      for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
        if (key === 'account_number') {
          output[key] = this.maskAccountNumber(String(entry ?? ''));
          continue;
        }
        output[key] = this.sanitizePaystackSnapshot(entry);
      }
      return output as Prisma.JsonValue;
    }

    if (
      value === null ||
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
    ) {
      return value as Prisma.JsonValue;
    }

    return null;
  }

  private buildStorePaymentMetadata(params: {
    existingMetadata?: unknown;
    resolvedAccountNumber?: string | null;
    paystackBankId?: number | null;
    subaccountPayload?: Record<string, any> | null;
    transferRecipientPayload?: Record<string, any> | null;
    lastProviderSyncAt?: Date | null;
    lastSuccessfulSyncAt?: Date | null;
    syncMode: 'INITIAL_SETUP' | 'RESYNC' | 'BANK_DETAILS_UPDATE';
  }): Prisma.JsonObject {
    const existing =
      params.existingMetadata &&
      typeof params.existingMetadata === 'object' &&
      !Array.isArray(params.existingMetadata)
        ? { ...(params.existingMetadata as Record<string, unknown>) }
        : {};

    return {
      ...existing,
      provider: 'PAYSTACK',
      resolvedAccountNumber:
        params.resolvedAccountNumber != null
          ? this.maskAccountNumber(params.resolvedAccountNumber)
          : (existing['resolvedAccountNumber'] as Prisma.JsonValue | undefined) ?? null,
      paystackBankId:
        params.paystackBankId != null
          ? params.paystackBankId
          : (existing['paystackBankId'] as number | null | undefined) ?? null,
      lastProviderSyncAt:
        params.lastProviderSyncAt?.toISOString() ??
        (existing['lastProviderSyncAt'] as string | null | undefined) ??
        null,
      lastSuccessfulSyncAt:
        params.lastSuccessfulSyncAt?.toISOString() ??
        (existing['lastSuccessfulSyncAt'] as string | null | undefined) ??
        null,
      syncMode: params.syncMode,
      providerSyncVersion: 2,
      subaccountResponseSnapshot:
        params.subaccountPayload != null
          ? this.sanitizePaystackSnapshot(params.subaccountPayload)
          : (existing['subaccountResponseSnapshot'] as Prisma.JsonValue | undefined) ?? null,
      transferRecipientResponseSnapshot:
        params.transferRecipientPayload != null
          ? this.sanitizePaystackSnapshot(params.transferRecipientPayload)
          : (existing['transferRecipientResponseSnapshot'] as Prisma.JsonValue | undefined) ?? null,
    };
  }

  private async withStorePaymentAccountSyncLock<T>(
    brandId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    if (typeof (this.prisma as any)?.$transaction !== 'function') {
      return operation();
    }

    const lockKey = this.buildStorePaymentAccountLockKey(brandId);

    return (this.prisma as any).$transaction(
      async (tx: any) => {
        // pg_advisory_xact_lock returns a Postgres void type; use executeRaw to
        // avoid result deserialization errors in Prisma.
        if (typeof tx?.$executeRaw === 'function') {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(${lockKey})`;
        }
        return operation();
      },
      {
        maxWait: 120000,
        timeout: 180000,
      },
    );
  }

  private buildStorePaymentAccountLockKey(brandId: string): bigint {
    const digest = createHash('sha256')
      .update(`store-payment-account:${brandId}`)
      .digest();
    return digest.readBigInt64BE(0);
  }

  private summarizePaymentAccount(account: any) {
    const decryptedAccountNumber = this.decryptStorePaymentValue(
      account?.accountNumberEncrypted,
    );
    const metadata =
      account?.metadata && typeof account.metadata === 'object' && !Array.isArray(account.metadata)
        ? (account.metadata as Record<string, any>)
        : {};
    return {
      id: account?.id ?? null,
      provider: account?.provider ?? 'PAYSTACK',
      status: account?.status ?? 'PENDING_SETUP',
      isReady: account?.status === 'ACTIVE',
      businessName: account?.businessName ?? null,
      primaryContactName: account?.primaryContactName ?? null,
      primaryContactEmail: account?.primaryContactEmail ?? null,
      primaryContactPhone: account?.primaryContactPhone ?? null,
      bankCode: account?.bankCode ?? null,
      bankName: account?.bankName ?? null,
      accountName: account?.accountName ?? null,
      maskedAccountNumber:
        account?.accountNumberLast4 && typeof account.accountNumberLast4 === 'string'
          ? `******${account.accountNumberLast4}`
          : decryptedAccountNumber
            ? `******${decryptedAccountNumber.slice(-4)}`
            : null,
      subaccountCode: account?.subaccountCode ?? null,
      subaccountId: account?.subaccountId ?? null,
      subaccountActive: Boolean(account?.subaccountActive),
      subaccountVerified: Boolean(account?.subaccountVerified),
      transferRecipientCode: account?.transferRecipientCode ?? null,
      transferRecipientId: account?.transferRecipientId ?? null,
      transferRecipientActive: Boolean(account?.transferRecipientActive),
      lastSyncError: account?.lastSyncError ?? null,
      accountResolvedAt: account?.accountResolvedAt ?? null,
      subaccountLastSyncAt: account?.subaccountLastSyncAt ?? null,
      transferRecipientLastSyncAt: account?.transferRecipientLastSyncAt ?? null,
      lastProviderSyncAt:
        typeof metadata.lastProviderSyncAt === 'string'
          ? metadata.lastProviderSyncAt
          : null,
      lastSuccessfulSyncAt:
        typeof metadata.lastSuccessfulSyncAt === 'string'
          ? metadata.lastSuccessfulSyncAt
          : null,
      paystackBankId:
        metadata.paystackBankId != null ? String(metadata.paystackBankId) : null,
      updatedAt: account?.updatedAt ?? null,
    };
  }

  private getPaystackTestBankFallbackUntilMs(): number | null {
    const raw = String(
      process.env[PAYSTACK_TEST_BANK_FALLBACK_UNTIL_ENV] ?? '',
    ).trim();
    if (!raw) return null;

    const parsed = Date.parse(raw);
    return Number.isFinite(parsed) ? parsed : null;
  }

  private isPaystackTestBankFallbackActive() {
    const expiresAtMs = this.getPaystackTestBankFallbackUntilMs();
    if (!expiresAtMs) return false;
    return Date.now() < expiresAtMs;
  }

  private getPaystackTestBankOption(): SupportedPaymentBank {
    return {
      id: -1,
      code: PAYSTACK_TEST_BANK_CODE,
      name: 'Paystack Test Bank',
      currency: 'NGN',
    };
  }

  private withTemporaryPaystackTestBank(
    banks: SupportedPaymentBank[],
  ): SupportedPaymentBank[] {
    if (!this.isPaystackTestBankFallbackActive()) {
      return banks;
    }

    if (banks.some((bank) => bank.code === PAYSTACK_TEST_BANK_CODE)) {
      return banks;
    }

    return [this.getPaystackTestBankOption(), ...banks];
  }

  private throwUnsupportedBankCode(bankCode: string): never {
    if (bankCode === PAYSTACK_TEST_BANK_CODE) {
      throw new BadRequestException(
        `Bank code 001 (Paystack test bank) is not available right now. Set ${PAYSTACK_TEST_BANK_FALLBACK_UNTIL_ENV} to a future ISO timestamp to enable it temporarily.`,
      );
    }

    throw new BadRequestException('Selected bank is not supported by Paystack');
  }

  private isLocalOrDevRuntime() {
    const runtime = String(
      process.env.APP_ENV ?? process.env.NODE_ENV ?? '',
    )
      .trim()
      .toLowerCase();

    return !['production', 'prod', 'staging', 'stage', 'qa', 'uat'].includes(runtime);
  }

  private isStorePaymentTestBypassEnabled() {
    const raw = String(
      process.env[STORE_PAYMENT_TEST_ACCOUNT_DEV_BYPASS_ENV] ?? '',
    )
      .trim()
      .toLowerCase();

    if (!raw) {
      return this.isLocalOrDevRuntime();
    }

    return ['1', 'true', 'yes', 'on'].includes(raw);
  }

  private shouldAcceptTestAccountAsValidForSetup(params: {
    bankCode: string;
    syncError: string | null;
  }) {
    if (!params.syncError) return false;
    if (params.bankCode !== PAYSTACK_TEST_BANK_CODE) return false;
    if (!this.isLocalOrDevRuntime()) return false;
    if (!this.isStorePaymentTestBypassEnabled()) return false;

    return /account details are invalid/i.test(params.syncError);
  }

  private shouldBypassPaystackSyncForDevTestAccount(bankCode: string) {
    return (
      bankCode === PAYSTACK_TEST_BANK_CODE &&
      this.isLocalOrDevRuntime() &&
      this.isStorePaymentTestBypassEnabled()
    );
  }

  async listSupportedPaymentBanks() {
    const now = Date.now();
    if (
      this.supportedPaymentBanksCache &&
      this.supportedPaymentBanksCache.expiresAt > now
    ) {
      return this.withTemporaryPaystackTestBank(
        this.supportedPaymentBanksCache.banks,
      );
    }

    if (this.supportedPaymentBanksRefresh) {
      return this.supportedPaymentBanksRefresh;
    }

    this.supportedPaymentBanksRefresh = this.fetchSupportedPaymentBanks()
      .then((banks) => {
        this.supportedPaymentBanksCache = {
          banks,
          expiresAt: Date.now() + this.supportedPaymentBanksTtlMs,
        };
        return this.withTemporaryPaystackTestBank(banks);
      })
      .finally(() => {
        this.supportedPaymentBanksRefresh = null;
      });

    return this.supportedPaymentBanksRefresh;
  }

  private async fetchSupportedPaymentBanks() {
    const rows = await this.callPaystack<
      Array<{
        id: number;
        name: string;
        code: string;
        active?: boolean;
        currency?: string;
        type?: string;
      }>
    >('/bank?country=nigeria&currency=NGN');

    return rows
      .filter((row) => row && row.active !== false && String(row.type || 'nuban') === 'nuban')
      .map((row) => ({
        id: row.id,
        code: row.code,
        name: row.name,
        currency: row.currency || 'NGN',
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  async getStorePaymentAccount(ownerId: string) {
    const [resolvedBrand, owner] = await Promise.all([
      this.resolveBrandByIdOrOwner(ownerId),
      this.prisma.user.findUnique({
        where: { id: ownerId },
        select: {
          id: true,
          email: true,
          firstName: true,
          lastName: true,
          phoneNumber: true,
        },
      }),
    ]);

    if (!resolvedBrand) {
      throw new NotFoundException('Brand not found');
    }

    const brand = await this.prisma.brand.findUnique({
      where: { id: resolvedBrand.id },
      select: {
        id: true,
        name: true,
      },
    });

    if (!brand) {
      throw new NotFoundException('Brand not found');
    }

    const account = await this.getStorePaymentAccountModel().findUnique({
      where: { brandId: brand.id },
    });

    const suggestedContactName =
      `${owner?.firstName ?? ''} ${owner?.lastName ?? ''}`.trim() || brand.name;

    return {
      brandId: brand.id,
      provider: 'PAYSTACK',
      isRequiredForStoreOpen: true,
      suggestedDefaults: {
        businessName: brand.name,
        primaryContactName: account?.primaryContactName ?? suggestedContactName,
        primaryContactEmail:
          account?.primaryContactEmail ?? owner?.email ?? null,
        primaryContactPhone:
          account?.primaryContactPhone ?? owner?.phoneNumber ?? null,
      },
      account: this.summarizePaymentAccount(account),
    };
  }

  async verifyStorePaymentAccount(
    ownerId: string,
    dto: VerifyStorePaymentAccountDto,
  ) {
    await this.assertEmailVerifiedForStoreSetup(ownerId, 'continue');

    const resolvedBrand = await this.resolveBrandByIdOrOwner(ownerId);
    if (!resolvedBrand) {
      throw new NotFoundException('Brand not found');
    }

    const bankCode = String(dto.bankCode ?? '').trim();
    const accountNumber = String(dto.accountNumber ?? '')
      .replace(/\D+/g, '')
      .trim();

    if (!bankCode) {
      throw new BadRequestException('Select the settlement bank first');
    }
    if (!/^\d{10}$/.test(accountNumber)) {
      throw new BadRequestException('Account number must be a valid 10-digit NUBAN');
    }

    const banks = await this.listSupportedPaymentBanks();
    const selectedBank = banks.find((bank) => bank.code === bankCode);
    if (!selectedBank) {
      this.throwUnsupportedBankCode(bankCode);
    }

    const brand = await this.prisma.brand.findUnique({
      where: { id: resolvedBrand.id },
      select: {
        id: true,
        name: true,
      },
    });

    if (!brand) {
      throw new NotFoundException('Brand not found');
    }

    if (this.shouldBypassPaystackSyncForDevTestAccount(bankCode)) {
      const verifiedAt = new Date().toISOString();
      return {
        bankCode: selectedBank.code,
        bankName: selectedBank.name,
        paystackBankId: null,
        accountNumber,
        maskedAccountNumber: this.maskAccountNumber(accountNumber),
        accountName: brand.name,
        message: 'Development test bank account verified successfully',
        verifiedAt,
      };
    }

    const resolved = await this.callPaystack<{
      account_number: string;
      account_name: string;
      bank_id?: number;
    }>(
      `/bank/resolve?account_number=${encodeURIComponent(accountNumber)}&bank_code=${encodeURIComponent(bankCode)}`,
      { method: 'GET' },
    );

    const resolvedAccountNumber = String(resolved.account_number ?? '').trim();
    if (resolvedAccountNumber && resolvedAccountNumber !== accountNumber) {
      throw new BadRequestException(
        'Verified account number does not match the submitted value',
      );
    }

    return {
      bankCode: selectedBank.code,
      bankName: selectedBank.name,
      paystackBankId: resolved.bank_id ?? null,
      accountNumber: resolvedAccountNumber || accountNumber,
      maskedAccountNumber: this.maskAccountNumber(
        resolvedAccountNumber || accountNumber,
      ),
      accountName: String(resolved.account_name ?? '').trim() || null,
      message: 'Bank account verified successfully',
      verifiedAt: new Date().toISOString(),
    };
  }

  async updateStorePaymentAccount(
    ownerId: string,
    dto: UpdateStorePaymentAccountDto,
  ) {
    await this.assertEmailVerifiedForStoreSetup(ownerId, 'continue');

    const [resolvedBrand, owner] = await Promise.all([
      this.resolveBrandByIdOrOwner(ownerId),
      this.prisma.user.findUnique({
        where: { id: ownerId },
        select: {
          id: true,
          email: true,
          firstName: true,
          lastName: true,
          phoneNumber: true,
        },
      }),
    ]);

    if (!resolvedBrand) {
      throw new NotFoundException('Brand not found');
    }

    const brand = await this.prisma.brand.findUnique({
      where: { id: resolvedBrand.id },
      select: {
        id: true,
        name: true,
      },
    });

    if (!brand) {
      throw new NotFoundException('Brand not found');
    }

    return this.withStorePaymentAccountSyncLock(brand.id, async () => {
      const existingAccount = await this.getStorePaymentAccountModel().findUnique({
        where: { brandId: brand.id },
      });

      const providedBankCode = String(dto.bankCode || '').trim();
      const providedAccountNumber = String(dto.accountNumber || '').trim();
      const decryptedExistingAccountNumber = this.decryptStorePaymentValue(
        existingAccount?.accountNumberEncrypted,
      );
      const bankCode =
        providedBankCode || String(existingAccount?.bankCode || '').trim();
      const accountNumber =
        providedAccountNumber || String(decryptedExistingAccountNumber || '').trim();

      if (!bankCode) {
        throw new BadRequestException('Select the settlement bank first');
      }
      if (!/^\d{10}$/.test(accountNumber)) {
        throw new BadRequestException('Account number must be a valid 10-digit NUBAN');
      }

      const bankDetailsChanged =
        !existingAccount ||
        bankCode !== String(existingAccount?.bankCode || '').trim() ||
        (providedAccountNumber.length > 0 &&
          accountNumber !== String(decryptedExistingAccountNumber || '').trim());
      const syncMode: 'INITIAL_SETUP' | 'RESYNC' | 'BANK_DETAILS_UPDATE' = !existingAccount
        ? 'INITIAL_SETUP'
        : bankDetailsChanged
          ? 'BANK_DETAILS_UPDATE'
          : 'RESYNC';

      const banks = await this.listSupportedPaymentBanks();
      const selectedBank = banks.find((bank) => bank.code === bankCode);
      if (!selectedBank) {
        this.throwUnsupportedBankCode(bankCode);
      }

      if (this.shouldBypassPaystackSyncForDevTestAccount(bankCode)) {
        const syncTimestamp = new Date();
        const nextAccountName =
          String(dto.primaryContactName || '').trim() ||
          String(existingAccount?.accountName || '').trim() ||
          brand.name;
        const nextPrimaryContactName =
          String(dto.primaryContactName || '').trim() ||
          existingAccount?.primaryContactName ||
          nextAccountName;
        const nextPrimaryContactEmail =
          String(dto.primaryContactEmail || '').trim() ||
          existingAccount?.primaryContactEmail ||
          owner?.email ||
          null;
        const nextPrimaryContactPhone =
          String(dto.primaryContactPhone || '').trim() ||
          existingAccount?.primaryContactPhone ||
          owner?.phoneNumber ||
          null;
        const accountNumberEncrypted = this.encryptStorePaymentValue(accountNumber);
        const lastSuccessfulSyncAt = syncTimestamp;
        const metadata = this.buildStorePaymentMetadata({
          existingMetadata: existingAccount?.metadata,
          resolvedAccountNumber: accountNumber,
          paystackBankId: null,
          subaccountPayload: null,
          transferRecipientPayload: null,
          lastProviderSyncAt: syncTimestamp,
          lastSuccessfulSyncAt,
          syncMode: !existingAccount ? 'INITIAL_SETUP' : 'RESYNC',
        });

        await this.getStorePaymentAccountModel().upsert({
          where: { brandId: brand.id },
          create: {
            id: uuidv4(),
            brandId: brand.id,
            status: 'ACTIVE',
            provider: 'PAYSTACK',
            countryCode: 'NG',
            currency: 'NGN',
            businessName: brand.name,
            primaryContactName: nextPrimaryContactName,
            primaryContactEmail: nextPrimaryContactEmail,
            primaryContactPhone: nextPrimaryContactPhone,
            bankCode,
            bankName: selectedBank.name,
            accountName: nextAccountName,
            accountNumberEncrypted,
            accountNumberLast4: accountNumber.slice(-4),
            isAccountResolved: true,
            accountResolvedAt: syncTimestamp,
            subaccountCode: existingAccount?.subaccountCode ?? null,
            subaccountId: existingAccount?.subaccountId ?? null,
            subaccountActive: Boolean(existingAccount?.subaccountActive),
            subaccountVerified: Boolean(existingAccount?.subaccountVerified),
            subaccountLastSyncAt: existingAccount?.subaccountLastSyncAt ?? null,
            transferRecipientCode: existingAccount?.transferRecipientCode ?? null,
            transferRecipientId: existingAccount?.transferRecipientId ?? null,
            transferRecipientActive: Boolean(existingAccount?.transferRecipientActive),
            transferRecipientLastSyncAt:
              existingAccount?.transferRecipientLastSyncAt ?? null,
            lastSyncError: null,
            metadata,
          },
          update: {
            status: 'ACTIVE',
            provider: 'PAYSTACK',
            countryCode: 'NG',
            currency: 'NGN',
            businessName: brand.name,
            primaryContactName: nextPrimaryContactName,
            primaryContactEmail: nextPrimaryContactEmail,
            primaryContactPhone: nextPrimaryContactPhone,
            bankCode,
            bankName: selectedBank.name,
            accountName: nextAccountName,
            accountNumberEncrypted,
            accountNumberLast4: accountNumber.slice(-4),
            isAccountResolved: true,
            accountResolvedAt: syncTimestamp,
            subaccountCode: existingAccount?.subaccountCode ?? null,
            subaccountId: existingAccount?.subaccountId ?? null,
            subaccountActive: Boolean(existingAccount?.subaccountActive),
            subaccountVerified: Boolean(existingAccount?.subaccountVerified),
            subaccountLastSyncAt: existingAccount?.subaccountLastSyncAt ?? null,
            transferRecipientCode: existingAccount?.transferRecipientCode ?? null,
            transferRecipientId: existingAccount?.transferRecipientId ?? null,
            transferRecipientActive: Boolean(existingAccount?.transferRecipientActive),
            transferRecipientLastSyncAt:
              existingAccount?.transferRecipientLastSyncAt ?? null,
            lastSyncError: null,
            metadata,
          },
        });

        this.logger.warn(
          `Accepted dev test account setup for bank 001 without provider sync (${brand.id}).`,
        );

        return this.getStorePaymentAccount(ownerId);
      }

      const resolved = await this.callPaystack<{
        account_number: string;
        account_name: string;
        bank_id?: number;
      }>(
        `/bank/resolve?account_number=${encodeURIComponent(accountNumber)}&bank_code=${encodeURIComponent(bankCode)}`,
        { method: 'GET' },
      );

      const primaryContactName =
        String(dto.primaryContactName || '').trim() ||
        existingAccount?.primaryContactName ||
        `${owner?.firstName ?? ''} ${owner?.lastName ?? ''}`.trim() ||
        brand.name;
      const primaryContactEmail =
        String(dto.primaryContactEmail || '').trim() ||
        existingAccount?.primaryContactEmail ||
        owner?.email ||
        null;
      const primaryContactPhone =
        String(dto.primaryContactPhone || '').trim() ||
        existingAccount?.primaryContactPhone ||
        owner?.phoneNumber ||
        null;

      let subaccountPayload: any = null;
      let transferRecipientPayload: any = null;
      let syncError: string | null = null;
      const syncTimestamp = new Date();
      let rollbackTransferRecipientCode: string | null = null;

      try {
        const subaccountBody = {
          business_name: brand.name,
          bank_code: bankCode,
          account_number: accountNumber,
          percentage_charge: 0,
          primary_contact_name: primaryContactName || undefined,
          primary_contact_email: primaryContactEmail || undefined,
          primary_contact_phone: primaryContactPhone || undefined,
          settlement_schedule: 'manual',
          description: `Threadly brand settlement account for ${brand.name}`,
          metadata: {
            threadlyBrandId: brand.id,
            threadlyOwnerId: ownerId,
          },
        };

        subaccountPayload = existingAccount?.subaccountCode
          ? await this.callPaystack(
              `/subaccount/${encodeURIComponent(existingAccount.subaccountCode)}`,
              {
                method: 'PUT',
                bodyJson: subaccountBody,
              },
            )
          : await this.callPaystack('/subaccount', {
              method: 'POST',
              bodyJson: subaccountBody,
            });

        const transferRecipientCreateBody = {
          type: 'nuban',
          name: resolved.account_name,
          account_number: accountNumber,
          bank_code: bankCode,
          currency: 'NGN',
          active: true,
          metadata: {
            threadlyBrandId: brand.id,
            threadlyOwnerId: ownerId,
          },
        };

        const existingRecipientCode = String(
          existingAccount?.transferRecipientCode ?? '',
        ).trim() || null;

        if (!existingRecipientCode) {
          transferRecipientPayload = await this.callPaystack('/transferrecipient', {
            method: 'POST',
            bodyJson: transferRecipientCreateBody,
          });
        } else {
          let existingRecipientPayload: any = null;
          try {
            existingRecipientPayload = await this.callPaystack(
              `/transferrecipient/${encodeURIComponent(existingRecipientCode)}`,
              { method: 'GET' },
            );
          } catch (error: any) {
            this.logger.warn(
              `Failed to fetch existing transfer recipient ${existingRecipientCode}: ${String(error?.message || error)}`,
            );
          }

          const existingDetails =
            existingRecipientPayload &&
            typeof existingRecipientPayload.details === 'object' &&
            !Array.isArray(existingRecipientPayload.details)
              ? existingRecipientPayload.details
              : null;
          const existingBankCode = String(existingDetails?.bank_code ?? '').trim();
          const existingAccountNumber = String(
            existingDetails?.account_number ?? '',
          )
            .replace(/\D+/g, '')
            .trim();

          const canReuseRecipient =
            Boolean(existingRecipientPayload) &&
            existingBankCode === bankCode &&
            existingAccountNumber === accountNumber;

          if (canReuseRecipient) {
            const updatedRecipient = await this.callPaystack(
              `/transferrecipient/${encodeURIComponent(existingRecipientCode)}`,
              {
                method: 'PUT',
                bodyJson: {
                  name: resolved.account_name,
                  email: primaryContactEmail || undefined,
                },
              },
            );

            transferRecipientPayload = {
              ...existingRecipientPayload,
              ...updatedRecipient,
              recipient_code:
                updatedRecipient?.recipient_code ??
                existingRecipientCode,
              id:
                updatedRecipient?.id ??
                existingRecipientPayload?.id ??
                existingAccount?.transferRecipientId ??
                null,
              active:
                updatedRecipient?.active ??
                existingRecipientPayload?.active ??
                true,
            };
          } else {
            transferRecipientPayload = await this.callPaystack('/transferrecipient', {
              method: 'POST',
              bodyJson: transferRecipientCreateBody,
            });

            const nextRecipientCode = String(
              transferRecipientPayload?.recipient_code ?? '',
            ).trim();
            if (nextRecipientCode && nextRecipientCode !== existingRecipientCode) {
              rollbackTransferRecipientCode = nextRecipientCode;
              try {
                await this.callPaystack(
                  `/transferrecipient/${encodeURIComponent(existingRecipientCode)}`,
                  { method: 'DELETE' },
                );
                rollbackTransferRecipientCode = null;
              } catch (error: any) {
                throw new Error(
                  `Failed to deactivate old transfer recipient ${existingRecipientCode}: ${String(
                    error?.message || error,
                  )}`,
                );
              }
            }
          }
        }
      } catch (error: any) {
        if (rollbackTransferRecipientCode) {
          try {
            await this.callPaystack(
              `/transferrecipient/${encodeURIComponent(rollbackTransferRecipientCode)}`,
              { method: 'DELETE' },
            );
          } catch (cleanupError: any) {
            this.logger.error(
              `Failed to rollback new transfer recipient ${rollbackTransferRecipientCode}: ${String(cleanupError?.message || cleanupError)}`,
            );
          }
        }

        syncError =
          error?.response?.data?.message ||
          error?.message ||
          'Unable to sync the Paystack payment account';
      }

      const providerSyncSucceeded =
        Boolean(subaccountPayload?.subaccount_code) &&
        Boolean(transferRecipientPayload?.recipient_code);
      const devTestAccountAccepted =
        this.shouldAcceptTestAccountAsValidForSetup({
          bankCode,
          syncError,
        });
      const effectiveSyncError = devTestAccountAccepted ? null : syncError;

      if (devTestAccountAccepted) {
        this.logger.warn(
          `Accepted test-bank payout account setup in local/dev after provider validation failure (${bankCode}).`,
        );
      }

      const syncSucceeded = providerSyncSucceeded || devTestAccountAccepted;
      const nextStatus = syncSucceeded
        ? 'ACTIVE'
        : effectiveSyncError
          ? 'SYNC_ERROR'
          : 'PENDING_SYNC';
      const lastSuccessfulSyncAt = syncSucceeded ? syncTimestamp : null;
      const canonicalSyncState = providerSyncSucceeded
        ? {
            subaccountCode: subaccountPayload?.subaccount_code ?? null,
            subaccountId:
              subaccountPayload?.id != null ? String(subaccountPayload.id) : null,
            subaccountActive: Boolean(subaccountPayload?.active),
            subaccountVerified: Boolean(subaccountPayload?.is_verified),
            subaccountLastSyncAt: syncTimestamp,
            transferRecipientCode: transferRecipientPayload?.recipient_code ?? null,
            transferRecipientId:
              transferRecipientPayload?.id != null
                ? String(transferRecipientPayload.id)
                : null,
            transferRecipientActive: Boolean(transferRecipientPayload?.active),
            transferRecipientLastSyncAt: syncTimestamp,
          }
        : {
            subaccountCode: existingAccount?.subaccountCode ?? null,
            subaccountId: existingAccount?.subaccountId ?? null,
            subaccountActive: Boolean(existingAccount?.subaccountActive),
            subaccountVerified: Boolean(existingAccount?.subaccountVerified),
            subaccountLastSyncAt: existingAccount?.subaccountLastSyncAt ?? null,
            transferRecipientCode:
              existingAccount?.transferRecipientCode ?? null,
            transferRecipientId: existingAccount?.transferRecipientId ?? null,
            transferRecipientActive: Boolean(existingAccount?.transferRecipientActive),
            transferRecipientLastSyncAt:
              existingAccount?.transferRecipientLastSyncAt ?? null,
          };
      const metadata = this.buildStorePaymentMetadata({
        existingMetadata: existingAccount?.metadata,
        resolvedAccountNumber: resolved.account_number,
        paystackBankId: resolved.bank_id ?? null,
        subaccountPayload,
        transferRecipientPayload,
        lastProviderSyncAt: syncTimestamp,
        lastSuccessfulSyncAt,
        syncMode,
      });

      await this.getStorePaymentAccountModel().upsert({
        where: { brandId: brand.id },
        create: {
          id: uuidv4(),
          brandId: brand.id,
          status: nextStatus,
          provider: 'PAYSTACK',
          countryCode: 'NG',
          currency: 'NGN',
          businessName: brand.name,
          primaryContactName: primaryContactName || null,
          primaryContactEmail: primaryContactEmail,
          primaryContactPhone: primaryContactPhone,
          bankCode,
          bankName: selectedBank.name,
          accountName: resolved.account_name,
          accountNumberEncrypted: this.encryptStorePaymentValue(accountNumber),
          accountNumberLast4: accountNumber.slice(-4),
          isAccountResolved: true,
          accountResolvedAt: syncTimestamp,
          ...canonicalSyncState,
          lastSyncError: effectiveSyncError,
          metadata,
        },
        update: {
          status: nextStatus,
          provider: 'PAYSTACK',
          countryCode: 'NG',
          currency: 'NGN',
          businessName: brand.name,
          primaryContactName: primaryContactName || null,
          primaryContactEmail: primaryContactEmail,
          primaryContactPhone: primaryContactPhone,
          bankCode,
          bankName: selectedBank.name,
          accountName: resolved.account_name,
          accountNumberEncrypted: this.encryptStorePaymentValue(accountNumber),
          accountNumberLast4: accountNumber.slice(-4),
          isAccountResolved: true,
          accountResolvedAt: syncTimestamp,
          ...canonicalSyncState,
          lastSyncError: effectiveSyncError,
          metadata,
        },
      });

      if (effectiveSyncError) {
        throw new BadRequestException(effectiveSyncError);
      }

      return this.getStorePaymentAccount(ownerId);
    });
  }

  private toMoney(value: unknown) {
    const numeric = Number(value ?? 0);
    if (!Number.isFinite(numeric)) {
      return 0;
    }
    return Math.round(numeric * 100) / 100;
  }

  private getEscrowRemainingAmount(hold: {
    netBrandAmount: unknown;
    firstReleaseNetAmount: unknown;
    secondReleaseNetAmount: unknown;
    firstReleasedAt?: Date | null;
    secondReleasedAt?: Date | null;
  }) {
    let remaining = this.toMoney(hold.netBrandAmount);
    if (hold.firstReleasedAt) {
      remaining -= this.toMoney(hold.firstReleaseNetAmount);
    }
    if (hold.secondReleasedAt) {
      remaining -= this.toMoney(hold.secondReleaseNetAmount);
    }
    return Math.max(0, this.toMoney(remaining));
  }

  async getStoreWallet(ownerId: string) {
    const resolvedBrand = await this.resolveBrandByIdOrOwner(ownerId);
    if (!resolvedBrand) {
      throw new NotFoundException('Brand not found');
    }

    const brandId = resolvedBrand.id;
    const pendingStatuses = [
      'PENDING_APPROVAL',
      'APPROVED',
      'PROCESSING',
      'ON_HOLD',
      'RECONCILIATION_REVIEW',
    ];

    const [paymentAccount, availableAccount, pendingPayouts, paidOut, heldHolds, recentPayouts] =
      await Promise.all([
        this.getStorePaymentAccountModel().findUnique({
          where: { brandId },
        }),
        this.prisma.ledgerAccount.findFirst({
          where: {
            entityType: 'BRAND',
            entityId: brandId,
            subType: 'BRAND_AVAILABLE',
            isActive: true,
          },
          select: { currentBalance: true },
        }),
        this.prisma.payout.aggregate({
          where: {
            brandId,
            status: { in: pendingStatuses as any },
          },
          _sum: { amount: true },
          _count: { id: true },
        }),
        this.prisma.payout.aggregate({
          where: {
            brandId,
            status: 'PAID' as any,
          },
          _sum: { amount: true },
          _count: { id: true },
        }),
        this.prisma.escrowHold.findMany({
          where: {
            brandId,
            status: {
              in: ['HELD', 'PARTIALLY_RELEASED', 'FROZEN'] as any,
            },
          },
          select: {
            netBrandAmount: true,
            firstReleaseNetAmount: true,
            secondReleaseNetAmount: true,
            firstReleasedAt: true,
            secondReleasedAt: true,
          },
        }),
        this.prisma.payout.findMany({
          where: { brandId },
          orderBy: { createdAt: 'desc' },
          take: 8,
          select: {
            id: true,
            amount: true,
            currency: true,
            status: true,
            providerTransferStatus: true,
            createdAt: true,
            processedAt: true,
            paidAt: true,
          },
        }),
      ]);

    const payoutIds = recentPayouts.map((payout) => payout.id);
    const statementRows =
      payoutIds.length > 0
        ? await (this.prisma as any).financialDocument.findMany({
            where: {
              payoutId: { in: payoutIds },
              type: 'BRAND_SETTLEMENT_STATEMENT',
              status: 'GENERATED',
            },
            select: {
              id: true,
              payoutId: true,
              documentNumber: true,
              issuedAt: true,
            },
          })
        : [];

    const statementByPayoutId = new Map<string, any>(
      statementRows.map((row: any) => [String(row.payoutId), row]),
    );

    const availableForPayout = this.toMoney(availableAccount?.currentBalance ?? 0);
    const pendingPayoutTotal = this.toMoney(pendingPayouts?._sum?.amount ?? 0);
    const totalPaidOut = this.toMoney(paidOut?._sum?.amount ?? 0);
    const heldInEscrow = this.toMoney(
      heldHolds.reduce((sum, hold) => sum + this.getEscrowRemainingAmount(hold), 0),
    );
    const totalEarnings = this.toMoney(
      availableForPayout + pendingPayoutTotal + totalPaidOut + heldInEscrow,
    );

    return {
      brandId,
      currency: 'NGN',
      paymentAccount: this.summarizePaymentAccount(paymentAccount),
      summary: {
        availableForPayout,
        heldInEscrow,
        totalEarnings,
        totalPaidOut,
        pendingPayoutTotal,
        pendingPayoutCount: Number(pendingPayouts?._count?.id ?? 0),
      },
      recentPayouts: recentPayouts.map((payout) => {
        const statement = statementByPayoutId.get(String(payout.id));
        return {
          id: payout.id,
          amount: this.toMoney(payout.amount),
          currency: payout.currency,
          status: payout.status,
          providerTransferStatus: payout.providerTransferStatus ?? null,
          createdAt: payout.createdAt,
          processedAt: payout.processedAt,
          paidAt: payout.paidAt,
          statement:
            statement != null
              ? {
                  id: String(statement.id),
                  documentNumber: String(statement.documentNumber),
                  issuedAt: statement.issuedAt,
                  downloadPath: `/store/payouts/${payout.id}/statement`,
                }
              : null,
        };
      }),
    };
  }

  async listStorePayouts(
    ownerId: string,
    params?: { page?: number; limit?: number; status?: string },
  ) {
    const resolvedBrand = await this.resolveBrandByIdOrOwner(ownerId);
    if (!resolvedBrand) {
      throw new NotFoundException('Brand not found');
    }

    const page = Math.max(1, Number(params?.page ?? 1));
    const limit = Math.min(100, Math.max(1, Number(params?.limit ?? 20)));
    const skip = (page - 1) * limit;
    const normalizedStatus = String(params?.status ?? '').trim().toUpperCase();
    const validStatuses = new Set([
      'PENDING_APPROVAL',
      'APPROVED',
      'PROCESSING',
      'PAID',
      'FAILED',
      'REJECTED',
      'ON_HOLD',
      'RECONCILIATION_REVIEW',
    ]);
    const statusFilter =
      normalizedStatus && validStatuses.has(normalizedStatus)
        ? normalizedStatus
        : null;

    const where = {
      brandId: resolvedBrand.id,
      ...(statusFilter ? { status: statusFilter as any } : {}),
    };

    const [total, payouts] = await Promise.all([
      this.prisma.payout.count({ where }),
      this.prisma.payout.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        select: {
          id: true,
          amount: true,
          currency: true,
          status: true,
          providerTransferStatus: true,
          providerTransferFailureMessage: true,
          providerTransferReference: true,
          createdAt: true,
          processedAt: true,
          paidAt: true,
        },
      }),
    ]);

    const payoutIds = payouts.map((payout) => payout.id);
    const statementRows =
      payoutIds.length > 0
        ? await (this.prisma as any).financialDocument.findMany({
            where: {
              payoutId: { in: payoutIds },
              type: 'BRAND_SETTLEMENT_STATEMENT',
              status: 'GENERATED',
            },
            select: {
              id: true,
              payoutId: true,
              documentNumber: true,
              issuedAt: true,
            },
          })
        : [];

    const statementByPayoutId = new Map<string, any>(
      statementRows.map((row: any) => [String(row.payoutId), row]),
    );

    return {
      items: payouts.map((payout) => {
        const statement = statementByPayoutId.get(String(payout.id));
        return {
          id: payout.id,
          amount: this.toMoney(payout.amount),
          currency: payout.currency,
          status: payout.status,
          providerTransferStatus: payout.providerTransferStatus ?? null,
          providerTransferFailureMessage:
            payout.providerTransferFailureMessage ?? null,
          providerTransferReference: payout.providerTransferReference ?? null,
          createdAt: payout.createdAt,
          processedAt: payout.processedAt,
          paidAt: payout.paidAt,
          statement:
            statement != null
              ? {
                  id: String(statement.id),
                  documentNumber: String(statement.documentNumber),
                  issuedAt: statement.issuedAt,
                  downloadPath: `/store/payouts/${payout.id}/statement`,
                }
              : null,
        };
      }),
      total,
      page,
      totalPages: Math.max(1, Math.ceil(total / limit)),
      hasNextPage: skip + payouts.length < total,
    };
  }

  async getStorePayoutDetail(ownerId: string, payoutId: string) {
    const resolvedBrand = await this.resolveBrandByIdOrOwner(ownerId);
    if (!resolvedBrand) {
      throw new NotFoundException('Brand not found');
    }

    const payout = await this.prisma.payout.findFirst({
      where: {
        id: payoutId,
        brandId: resolvedBrand.id,
      },
      select: {
        id: true,
        brandId: true,
        amount: true,
        currency: true,
        status: true,
        provider: true,
        reference: true,
        providerTransferStatus: true,
        providerTransferReference: true,
        providerTransferFailureMessage: true,
        providerTransferInitiatedAt: true,
        providerTransferFinalizedAt: true,
        providerTransferReversedAt: true,
        failureReason: true,
        statusReason: true,
        createdAt: true,
        processedAt: true,
        paidAt: true,
        ledgerSourceAllocations: {
          orderBy: { createdAt: 'asc' },
          select: {
            id: true,
            amount: true,
            currency: true,
            createdAt: true,
            releaseStage: true,
            ledgerEntry: {
              select: {
                id: true,
                amount: true,
                createdAt: true,
                transaction: {
                  select: {
                    referenceId: true,
                    referenceType: true,
                    description: true,
                    totalAmount: true,
                    currency: true,
                    createdAt: true,
                  },
                },
              },
            },
            escrowHold: {
              select: {
                id: true,
                order: {
                  select: {
                    id: true,
                    customerName: true,
                    orderItems: {
                      take: 1,
                      orderBy: { createdAt: 'asc' },
                      select: {
                        nameAtPurchase: true,
                      },
                    },
                  },
                },
              },
            },
          },
        },
        ledgerAllocations: {
          orderBy: { createdAt: 'asc' },
          select: {
            id: true,
            allocationType: true,
            amount: true,
            commissionAmount: true,
            netBrandAmount: true,
            currency: true,
            eligibleAt: true,
            createdAt: true,
            customOrderId: true,
            customOrder: {
              select: {
                id: true,
                sourceTitleSnapshot: true,
                buyer: {
                  select: {
                    firstName: true,
                    lastName: true,
                    username: true,
                  },
                },
              },
            },
          },
        },
      },
    });

    if (!payout) {
      throw new NotFoundException('Payout not found');
    }

    const statement = await (this.prisma as any).financialDocument.findFirst({
      where: {
        payoutId,
        type: 'BRAND_SETTLEMENT_STATEMENT',
        status: 'GENERATED',
      },
      select: {
        id: true,
        documentNumber: true,
        issuedAt: true,
      },
    });

    return {
      id: payout.id,
      brandId: payout.brandId,
      amount: this.toMoney(payout.amount),
      currency: payout.currency,
      status: payout.status,
      provider: payout.provider,
      reference: payout.reference ?? null,
      providerTransferStatus: payout.providerTransferStatus ?? null,
      providerTransferReference: payout.providerTransferReference ?? null,
      providerTransferFailureMessage:
        payout.providerTransferFailureMessage ?? null,
      providerTransferInitiatedAt: payout.providerTransferInitiatedAt,
      providerTransferFinalizedAt: payout.providerTransferFinalizedAt,
      providerTransferReversedAt: payout.providerTransferReversedAt,
      failureReason: payout.failureReason ?? null,
      statusReason: payout.statusReason ?? null,
      createdAt: payout.createdAt,
      processedAt: payout.processedAt,
      paidAt: payout.paidAt,
      statement:
        statement != null
          ? {
              id: String(statement.id),
              documentNumber: String(statement.documentNumber),
              issuedAt: statement.issuedAt,
              downloadPath: `/store/payouts/${payout.id}/statement`,
            }
          : null,
      sourceBreakdown: buildPayoutSourceBreakdown(payout),
    };
  }

  async getStorePayoutStatement(ownerId: string, payoutId: string) {
    const resolvedBrand = await this.resolveBrandByIdOrOwner(ownerId);
    if (!resolvedBrand) {
      throw new NotFoundException('Brand not found');
    }

    const payout = await this.prisma.payout.findFirst({
      where: {
        id: payoutId,
        brandId: resolvedBrand.id,
      },
      select: { id: true },
    });
    if (!payout) {
      throw new NotFoundException('Payout not found');
    }

    const document = await (this.prisma as any).financialDocument.findFirst({
      where: {
        payoutId,
        type: 'BRAND_SETTLEMENT_STATEMENT',
        status: 'GENERATED',
      },
      select: {
        id: true,
        documentNumber: true,
        issuedAt: true,
        currency: true,
        grossAmount: true,
        netAmount: true,
        contentHtml: true,
      },
    });

    if (!document) {
      throw new NotFoundException('Settlement statement is not available yet');
    }

    return {
      id: String(document.id),
      payoutId,
      documentNumber: String(document.documentNumber),
      issuedAt: document.issuedAt,
      currency: document.currency,
      grossAmount: this.toMoney(document.grossAmount),
      netAmount: this.toMoney(document.netAmount),
      contentHtml: String(document.contentHtml || ''),
    };
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
  }, paymentAccount?: { status?: string | null } | null): { isComplete: boolean; missingFields: string[] } {
    const missingFields: string[] = [];

    if (!brand.name?.trim()) missingFields.push('name');
    if (!brand.description?.trim()) missingFields.push('description');
    if (!brand.tags || brand.tags.length === 0) missingFields.push('tags');
    if (String(paymentAccount?.status || '').trim().toUpperCase() !== 'ACTIVE') {
      missingFields.push('paymentAccount');
    }

    return {
      isComplete: missingFields.length === 0,
      missingFields,
    };
  }

  /**
   * Compute whether the brand profile has finished the onboarding fields
   * required before store setup can be opened.
   */
  private computeBrandProfileCompleteness(brand: {
    brandDescription?: string | null;
    brandTags?: string[] | null;
    brandCountry?: string | null;
    brandState?: string | null;
  }): { isComplete: boolean; missingFields: string[] } {
    const missingFields: string[] = [];

    if ((brand.brandDescription ?? '').trim().length < 20) {
      missingFields.push('description');
    }
    if (!brand.brandTags || brand.brandTags.length === 0) {
      missingFields.push('tags');
    }
    if (!String(brand.brandCountry ?? '').trim() && !String(brand.brandState ?? '').trim()) {
      missingFields.push('location');
    }

    return {
      isComplete: missingFields.length === 0,
      missingFields,
    };
  }

  private async assertEmailVerifiedForStoreSetup(
    ownerId: string,
    phase: 'start' | 'continue' | 'complete' = 'continue',
  ) {
    const user = await this.prisma.user.findUnique({
      where: { id: ownerId },
      select: { id: true, isEmailVerified: true },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    if (user.isEmailVerified) {
      return;
    }

    if (phase === 'start') {
      throw new ForbiddenException(
        'Verify your email before starting store setup. Check your inbox and click the verification link.',
      );
    }

    if (phase === 'complete') {
      throw new ForbiddenException(
        'Verify your email before completing store setup. Check your inbox and click the verification link.',
      );
    }

    throw new ForbiddenException(
      'Verify your email before continuing store setup. Check your inbox and click the verification link.',
    );
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

    const [policy, paymentAccount, owner] = await Promise.all([
      this.prisma.storePolicy.findUnique({
        where: { brandId: brand.id },
        select: { responseTimeSla: true },
      }),
      this.getStorePaymentAccountModel().findUnique({
        where: { brandId: brand.id },
      }),
      this.prisma.user.findUnique({
        where: { id: ownerId },
        select: {
          isEmailVerified: true,
          brandDescription: true,
          brandTags: true,
          brandCountry: true,
          brandState: true,
        },
      }),
    ]);
    const profileCompleteness = this.computeBrandProfileCompleteness(owner ?? {});
    const { isComplete, missingFields } = this.computeStoreCompleteness(
      brand,
      paymentAccount,
    );

    return {
      brandId: brand.id,
      isStoreOpen: brand.isStoreOpen,
      isEmailVerified: owner?.isEmailVerified ?? true,
      isProfileComplete: profileCompleteness.isComplete,
      profileMissingFields: profileCompleteness.missingFields,
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
      paymentAccount: this.summarizePaymentAccount(paymentAccount),
    };
  }

  async openStore(ownerId: string) {
    await this.assertEmailVerifiedForStoreSetup(ownerId, 'complete');

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

    const paymentAccount = await this.getStorePaymentAccountModel().findUnique({
      where: { brandId: brand.id },
    });
    const { isComplete, missingFields } = this.computeStoreCompleteness(
      brand,
      paymentAccount,
    );

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

    void this.notifications
      ?.create(ownerId, NotificationType.VERIFICATION_NUDGE, {
        payload: {
          brandId: brand.id,
          brandName: brand.name,
          targetUrl: '/studio/verification',
          message:
            'Your store is live. Verify your brand to start making sales and build buyer trust.',
        },
        dedupeMs: 24 * 60 * 60 * 1000,
      })
      .catch((error) => {
        this.logger.warn(
          `Failed to send store-setup verification notification for brand=${brand.id}: ${String(error)}`,
        );
      });

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
    await this.assertEmailVerifiedForStoreSetup(ownerId, 'continue');

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

    const normalizedShippingRules = this.normalizeBrandShippingRules(
      policy?.shippingRules &&
        typeof policy.shippingRules === 'object' &&
        !Array.isArray(policy.shippingRules)
        ? (policy.shippingRules as Record<string, any>)
        : null,
    );

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
      shippingRules: normalizedShippingRules,
    };
  }

  async updateStorePolicies(ownerId: string, dto: UpdateStorePoliciesDto) {
    await this.assertEmailVerifiedForStoreSetup(ownerId, 'continue');

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
      const normalizedShippingRules = this.normalizeBrandShippingRules(
        dto.shippingRules as Record<string, any> | null,
      );
      updateData.shippingRules = normalizedShippingRules;
      createData.shippingRules = normalizedShippingRules;
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


