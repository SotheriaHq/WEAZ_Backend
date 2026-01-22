import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateProductDto, UpdateProductDto } from './dto/create-product.dto';
import { AddToCartDto, UpdateCartItemDto } from './dto/cart.dto';
import { AddToWishlistDto } from './dto/wishlist.dto';
import { CheckoutDto } from './dto/checkout.dto';
import { v4 as uuidv4 } from 'uuid';
import { CollectionType, Prisma, NotificationType, UserType } from '@prisma/client';
import { UpdateStoreNameDto } from './dto/update-store-name.dto';
import { UpdateStoreProfileDto } from './dto/update-store-profile.dto';
import { PasswordService } from 'src/auth/helper/password.service';
import { UploadService } from 'src/upload/upload.service';
import { FileType } from 'src/upload/upload.enums';
import { ProductViewCounterService } from './product-view-counter.service';

@Injectable()
export class StoreService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwordService: PasswordService,
    private readonly uploadService: UploadService,
    private readonly viewCounter: ProductViewCounterService,
  ) {}

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
    return (tag || '').trim().replace(/\s+/g, ' ').slice(0, 40);
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
    const set = new Set<string>();
    for (const tag of tags) {
      const normalized = this.normalizeTag(String(tag ?? '')).toLowerCase();
      if (!normalized) continue;
      set.add(normalized);
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }

  private async getSystemTags(): Promise<string[]> {
    const [brandUsers, products] = await Promise.all([
      this.prisma.user.findMany({
        where: { type: 'BRAND' },
        select: { brandTags: true },
      }),
      this.prisma.product.findMany({
        select: { tags: true },
        take: 2000,
        orderBy: { updatedAt: 'desc' },
      }),
    ]);

    const tags: string[] = [];
    for (const u of brandUsers) tags.push(...(u.brandTags || []));
    for (const p of products) tags.push(...(p.tags || []));
    return this.buildTagSet(tags);
  }

  private async getActiveCategories() {
    return this.prisma.collectionCategory.findMany({
      where: { isActive: true },
      orderBy: [{ order: 'asc' }, { createdAt: 'asc' }],
      select: { id: true, slug: true, name: true },
    });
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

  // ==================== PRODUCTS ====================

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
      const collection = await this.prisma.collection.findFirst({
        where: { id: requestedCollectionId, ownerId: brandOwnerId },
      });

      if (!collection) {
        throw new NotFoundException(
          'Collection not found or does not belong to you',
        );
      }
    }

    const isDraft = dto.isActive === false;
    const resolvedName = (dto.name ?? '').trim() || (isDraft ? 'Untitled Draft' : '');
    if (!resolvedName) {
      throw new BadRequestException('Product name is required');
    }

    const resolvedPrice =
      typeof dto.price === 'number' ? dto.price : isDraft ? 0 : undefined;
    if (resolvedPrice === undefined) {
      throw new BadRequestException('Product price is required');
    }

    // Generate slug if not provided
    const slug = dto.slug || this.generateSlug(resolvedName);

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

    const product = await this.prisma.$transaction(async (tx) => {
      let collectionId = requestedCollectionId;

      if (!collectionId) {
        const existingDefault = await tx.collection.findFirst({
          where: {
            ownerId: brandOwnerId,
            isAvailableInStore: true,
            status: 'PUBLISHED',
          },
          orderBy: { updatedAt: 'desc' },
          select: { id: true },
        });

        if (existingDefault?.id) {
          collectionId = existingDefault.id;
        } else {
          const createdDefault = await tx.collection.create({
            data: {
              id: uuidv4(),
              ownerId: brandOwnerId,
              title: 'Store Products',
              status: 'PUBLISHED',
              visibility: 'PUBLIC',
              type: 'EVERYBODY',
              isAvailableInStore: true,
            },
            select: { id: true },
          });
          collectionId = createdDefault.id;
        }
      }

      const created = await tx.product.create({
        data: {
          id: uuidv4(),
          collectionId: collectionId!,
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
          images: dto.images || [],
          thumbnail: dto.thumbnail,
          // Inventory
          totalStock:
            derivedFromVariants?.totalStock ?? (dto.totalStock || 0),
          lowStockThreshold: dto.lowStockThreshold || 5,
          trackInventory: dto.trackInventory ?? true,
          allowBackorders: dto.allowBackorders ?? false,
          // Metadata
          tags: this.buildTagSet(dto.tags || []),
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
          collection: { select: { id: true, title: true } },
          brand: { select: { id: true, name: true, logo: true, currency: true } },
          variants: true,
        },
      });
    });

    if (!product) {
      throw new NotFoundException('Product not found');
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

    let resolvedCollectionId: string | null | undefined = undefined;
    if (dto.collectionId !== undefined) {
      const requestedCollectionId = (dto.collectionId || '').trim();
      if (requestedCollectionId) {
        const collection = await this.prisma.collection.findFirst({
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
    if (dto.slug !== undefined) updateData.slug = dto.slug;
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
    if (dto.images !== undefined) updateData.images = dto.images;
    if (dto.thumbnail !== undefined) updateData.thumbnail = dto.thumbnail;
    
    // Inventory
    if (dto.totalStock !== undefined) updateData.totalStock = dto.totalStock;
    if (dto.lowStockThreshold !== undefined) updateData.lowStockThreshold = dto.lowStockThreshold;
    if (dto.trackInventory !== undefined) updateData.trackInventory = dto.trackInventory;
    if (dto.allowBackorders !== undefined) updateData.allowBackorders = dto.allowBackorders;
    
    // Metadata
    if (dto.tags !== undefined) updateData.tags = this.buildTagSet(dto.tags || []);
    if (dto.gender !== undefined) updateData.gender = dto.gender;
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

    const updated = await this.prisma.$transaction(async (tx) => {
      if (resolvedCollectionId !== undefined) {
        let finalCollectionId = resolvedCollectionId;
        if (finalCollectionId === null) {
          const existingDefault = await tx.collection.findFirst({
            where: {
              ownerId: brandOwnerId,
              isAvailableInStore: true,
              status: 'PUBLISHED',
            },
            orderBy: { updatedAt: 'desc' },
            select: { id: true },
          });

          if (existingDefault?.id) {
            finalCollectionId = existingDefault.id;
          } else {
            const createdDefault = await tx.collection.create({
              data: {
                id: uuidv4(),
                ownerId: brandOwnerId,
                title: 'Store Products',
                status: 'PUBLISHED',
                visibility: 'PUBLIC',
                type: 'EVERYBODY',
                isAvailableInStore: true,
              },
              select: { id: true },
            });
            finalCollectionId = createdDefault.id;
          }
        }

        if (finalCollectionId) {
          updateData.collection = { connect: { id: finalCollectionId } };
        }
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
          collection: { select: { id: true, title: true } },
          brand: { select: { id: true, name: true, logo: true } },
          variants: true,
        },
      });
    });

    return this.attachProductMedia(updated);
  }

  async duplicateProduct(brandOwnerId: string, productId: string) {
    const product = await this.prisma.product.findFirst({
      where: { id: productId },
      include: { brand: true, variants: true },
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
      const created = await tx.product.create({
        data: {
          id: uuidv4(),
          collectionId: product.collectionId,
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
          likesCount: 0,
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
          collection: { select: { id: true, title: true } },
          brand: { select: { id: true, name: true, logo: true, currency: true } },
          variants: true,
        },
      });
    });

    return this.attachProductMedia(duplicated);
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // DELETE IMPACT CHECK
  // Returns info about what will be affected if a product is deleted
  // ═══════════════════════════════════════════════════════════════════════════════

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
      totalLikes: product.likesCount ?? 0,
      canDelete: !hasActiveOrders,
      mustArchiveReason: hasActiveOrders
        ? 'This product has active orders and can only be archived.'
        : undefined,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // ARCHIVE PRODUCT
  // Sets archivedAt with 60-day auto-delete schedule
  // ═══════════════════════════════════════════════════════════════════════════════

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

    const archived = await this.prisma.product.update({
      where: { id: productId },
      data: {
        archivedAt: now,
        archiveExpiresAt: expiresAt,
        archiveLastReminder: null,
        isActive: false,
      },
      include: {
        collection: { select: { id: true, title: true } },
        brand: { select: { id: true, name: true, logo: true, currency: true } },
        variants: true,
      },
    });

    return this.attachProductMedia(archived);
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // UNARCHIVE PRODUCT
  // Restores product and clears archive schedule
  // ═══════════════════════════════════════════════════════════════════════════════

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

    const restored = await this.prisma.product.update({
      where: { id: productId },
      data: {
        archivedAt: null,
        archiveExpiresAt: null,
        archiveLastReminder: null,
        // Keep isActive as false - user should manually publish
      },
      include: {
        collection: { select: { id: true, title: true } },
        brand: { select: { id: true, name: true, logo: true, currency: true } },
        variants: true,
      },
    });

    return this.attachProductMedia(restored);
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // TOGGLE FEATURED
  // Toggles the isFeatured flag on a product
  // ═══════════════════════════════════════════════════════════════════════════════

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
        collection: { select: { id: true, title: true } },
        brand: { select: { id: true, name: true, logo: true, currency: true } },
        variants: true,
      },
    });

    return this.attachProductMedia(updated);
  }

  async deleteProduct(brandOwnerId: string, productId: string) {
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

    if (activeOrdersCount > 0) {
      throw new BadRequestException(
        'Cannot delete product with active orders. Please archive it instead.',
      );
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.product.update({
        where: { id: productId },
        data: { deletedAt: new Date(), isActive: false },
      });
      await tx.cartItem.deleteMany({ where: { productId } });
      await tx.wishlistItem.deleteMany({ where: { productId } });
    });

    return { success: true, message: 'Product deleted' };
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

    await this.prisma.$transaction(async (tx) => {
      await tx.cartItem.deleteMany({ where: { productId } });
      await tx.wishlistItem.deleteMany({ where: { productId } });
      await tx.productVariant.deleteMany({ where: { productId } });
      await tx.product.delete({ where: { id: productId } });
    });

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
      if (
        !product.collection.isAvailableInStore ||
        product.collection.status !== 'PUBLISHED'
      ) {
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
        where.collectionId = collectionId;
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
      where.collection = {
        is: {
          status: 'PUBLISHED',
          isAvailableInStore: true,
        },
      };
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

    // Category filter via collection
    if (category) {
      const existingIs =
        where.collection && typeof where.collection === 'object' && 'is' in where.collection
          ? (where.collection as Prisma.CollectionScalarRelationFilter).is
          : undefined;

      where.collection = {
        is: {
          ...(existingIs && typeof existingIs === 'object' ? existingIs : {}),
          category: { slug: category },
        },
      };
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

    const restored = await this.prisma.product.update({
      where: { id: productId },
      data: { deletedAt: null, isActive: false },
      include: {
        collection: { select: { id: true, title: true } },
        brand: { select: { id: true, name: true, logo: true, currency: true } },
        variants: true,
      },
    });

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
        collection: { isAvailableInStore: true, status: 'PUBLISHED' },
      },
      include: { variants: true },
    });

    if (!product) {
      throw new NotFoundException('Product not found or unavailable');
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

    const quantity = dto.quantity || 1;

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
        if (available < quantity) {
          throw new BadRequestException(
            `Only ${available} items available for the selected variant`,
          );
        }
      } else if (dto.selectedSize && product.sizeStock) {
        const sizeStock = product.sizeStock as Record<string, number>;
        const available = sizeStock[dto.selectedSize] || 0;
        if (available < quantity) {
          throw new BadRequestException(
            `Only ${available} items available in size ${dto.selectedSize}`,
          );
        }
      } else if (product.totalStock < quantity) {
        throw new BadRequestException(`Only ${product.totalStock} items available`);
      }
    }

    // Upsert cart item
    const existingItem = await this.prisma.cartItem.findFirst({
      where: {
        userId,
        productId: dto.productId,
        selectedSize: dto.selectedSize || null,
        selectedColor: dto.selectedColor || null,
      },
    });

    if (existingItem) {
      const newQuantity = existingItem.quantity + (dto.quantity || 1);
      await this.prisma.cartItem.update({
        where: { id: existingItem.id },
        data: { quantity: newQuantity },
      });
    } else {
      await this.prisma.cartItem.create({
        data: {
          id: uuidv4(),
          userId,
          productId: dto.productId,
          quantity: dto.quantity || 1,
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
            brand: { select: { id: true, name: true, currency: true, isStoreOpen: true } },
            collection: { select: { id: true, status: true, isAvailableInStore: true } },
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
        Boolean(product.collection?.isAvailableInStore) &&
        product.collection?.status === 'PUBLISHED';

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
        collection: { isAvailableInStore: true, status: 'PUBLISHED' },
      },
    });

    if (!product) {
      throw new NotFoundException('Product not found');
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
                select: { id: true, name: true, logo: true, currency: true, isStoreOpen: true },
              },
              collection: { select: { id: true, status: true, isAvailableInStore: true } },
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

      const isProductAvailable =
        !product.deletedAt &&
        product.isActive &&
        Boolean(product.brand?.isStoreOpen) &&
        Boolean(product.collection?.isAvailableInStore) &&
        product.collection?.status === 'PUBLISHED';

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
        product: { deletedAt: null, isActive: true },
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
      collectionId: product.collectionId,
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
      likesCount: product.likesCount,
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
            variants: true,
          },
        },
      },
      orderBy: { createdAt: 'asc' },
    });

    if (cartItems.length === 0) {
      throw new BadRequestException('Cart is empty');
    }

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

        const orderItems: any[] = [];
        let totalAmount = 0;

        for (const item of items) {
          const product = await tx.product.findFirst({
            where: { id: item.productId, deletedAt: null },
            include: { collection: true, variants: true },
          });

          if (!product || !product.isActive) {
            throw new BadRequestException('Product not available');
          }

          if (
            !product.collection ||
            !product.collection.isAvailableInStore ||
            product.collection.status !== 'PUBLISHED'
          ) {
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
            contactInfo: dto.contactInfo || null,
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
    const [user, brand, categories, tags] = await Promise.all([
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
        select: { id: true, name: true, isStoreOpen: true },
      }),
      this.getActiveCategories(),
      this.getSystemTags(),
    ]);

    if (!user) throw new NotFoundException('User not found');

    const storeName = this.canonicalStoreName(user, brand);
    const slug = this.canonicalStoreSlug(user);

    const userTags = (user.brandTags || [])
      .map((t) => this.normalizeTag(t))
      .filter(Boolean);

    const taglineFromDescription =
      (user.brandDescription || '').split(/(?<=[.!?])\s+/)[0]?.trim() || '';
    const suggestedTagline = (
      taglineFromDescription || userTags.slice(0, 3).join(' • ')
    ).slice(0, 60);

    return {
      brand: {
        storeName,
        slug,
        contactEmail: user.email,
        description: user.brandDescription || '',
        instagram: user.socialInstagram || '',
        twitter: user.socialTwitter || '',
        website: user.socialWebsite || '',
        tags: userTags,
        tagline: suggestedTagline,
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
    const [user, brand] = await Promise.all([
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
          tagline: true,
          logo: true,
          banner: true,
          tags: true,
          storeNameLastChangedAt: true,
          isStoreOpen: true,
        },
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
      contactEmail: user.email,
      isEmailVerified: user.isEmailVerified,
      isStoreOpen: Boolean(brand?.isStoreOpen),
      isSetupComplete: completeness.isComplete,
      missingFields: completeness.missingFields,
      storeNameLastChangedAt: lastChangedAt,
      storeNameNextAllowedAt: nextAllowedAt,
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
            isStoreOpen: true,
          },
        });
      }
    }

    if (!brand) {
      throw new NotFoundException('Brand not found');
    }

    const { isComplete, missingFields } = this.computeStoreCompleteness(brand);

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

    return { success: true, message: 'Store is now open!', brandId: brand.id };
  }

  async updateStoreProfile(ownerId: string, dto: UpdateStoreProfileDto) {
    const brand = await this.prisma.brand.findUnique({
      where: { ownerId },
      select: { id: true },
    });

    if (!brand) {
      throw new NotFoundException('Brand not found');
    }

    const updateData: any = {};

    if (dto.description !== undefined) updateData.description = dto.description;
    if (dto.tagline !== undefined) updateData.tagline = dto.tagline;
    if (dto.tags !== undefined) {
      // Normalize and de-duplicate tags.
      // NOTE: Do not hard-filter against "system tags" here.
      // In a fresh environment (or early product lifecycle), system tags may be empty,
      // which would make it impossible for any brand to ever complete store setup.
      updateData.tags = this.buildTagSet(dto.tags || []);
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

    return this.getStoreStatus(ownerId);
  }
}

