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
import { Prisma, NotificationType } from '@prisma/client';

@Injectable()
export class StoreService {
  constructor(private readonly prisma: PrismaService) {}

  // ==================== PRODUCTS ====================

  async createProduct(brandOwnerId: string, dto: CreateProductDto) {
    // Verify brand ownership
    const brand = await this.prisma.brand.findFirst({
      where: { ownerId: brandOwnerId },
    });

    if (!brand) {
      throw new ForbiddenException('You must be a brand owner to create products');
    }

    // Verify collection belongs to this brand
    const collection = await this.prisma.collection.findFirst({
      where: { id: dto.collectionId, ownerId: brandOwnerId },
    });

    if (!collection) {
      throw new NotFoundException('Collection not found or does not belong to you');
    }

    const product = await this.prisma.product.create({
      data: {
        id: uuidv4(),
        collectionId: dto.collectionId,
        brandId: brand.id,
        name: dto.name,
        description: dto.description,
        price: new Prisma.Decimal(dto.price),
        salePrice: dto.salePrice ? new Prisma.Decimal(dto.salePrice) : null,
        saleStartAt: dto.saleStartAt ? new Date(dto.saleStartAt) : null,
        saleEndAt: dto.saleEndAt ? new Date(dto.saleEndAt) : null,
        sizes: dto.sizes || [],
        sizeStock: dto.sizeStock || null,
        colors: dto.colors || [],
        colorImages: dto.colorImages || null,
        images: dto.images || [],
        thumbnail: dto.thumbnail,
        totalStock: dto.totalStock || 0,
        lowStockThreshold: dto.lowStockThreshold || 5,
        tags: dto.tags || [],
        gender: dto.gender || 'EVERYBODY',
        isActive: dto.isActive ?? true,
        isFeatured: dto.isFeatured ?? false,
      },
      include: {
        collection: { select: { id: true, title: true } },
        brand: { select: { id: true, name: true, logo: true } },
      },
    });

    return this.transformProduct(product);
  }

  async updateProduct(brandOwnerId: string, productId: string, dto: UpdateProductDto) {
    const product = await this.prisma.product.findFirst({
      where: { id: productId },
      include: { brand: true },
    });

    if (!product) {
      throw new NotFoundException('Product not found');
    }

    if (product.brand.ownerId !== brandOwnerId) {
      throw new ForbiddenException('You can only update your own products');
    }

    const updateData: any = {};
    
    if (dto.name !== undefined) updateData.name = dto.name;
    if (dto.description !== undefined) updateData.description = dto.description;
    if (dto.price !== undefined) updateData.price = new Prisma.Decimal(dto.price);
    if (dto.salePrice !== undefined) updateData.salePrice = dto.salePrice ? new Prisma.Decimal(dto.salePrice) : null;
    if (dto.saleStartAt !== undefined) updateData.saleStartAt = dto.saleStartAt ? new Date(dto.saleStartAt) : null;
    if (dto.saleEndAt !== undefined) updateData.saleEndAt = dto.saleEndAt ? new Date(dto.saleEndAt) : null;
    if (dto.sizes !== undefined) updateData.sizes = dto.sizes;
    if (dto.sizeStock !== undefined) updateData.sizeStock = dto.sizeStock;
    if (dto.colors !== undefined) updateData.colors = dto.colors;
    if (dto.colorImages !== undefined) updateData.colorImages = dto.colorImages;
    if (dto.images !== undefined) updateData.images = dto.images;
    if (dto.thumbnail !== undefined) updateData.thumbnail = dto.thumbnail;
    if (dto.totalStock !== undefined) updateData.totalStock = dto.totalStock;
    if (dto.lowStockThreshold !== undefined) updateData.lowStockThreshold = dto.lowStockThreshold;
    if (dto.tags !== undefined) updateData.tags = dto.tags;
    if (dto.gender !== undefined) updateData.gender = dto.gender;
    if (dto.isActive !== undefined) updateData.isActive = dto.isActive;
    if (dto.isFeatured !== undefined) updateData.isFeatured = dto.isFeatured;

    const updated = await this.prisma.product.update({
      where: { id: productId },
      data: updateData,
      include: {
        collection: { select: { id: true, title: true } },
        brand: { select: { id: true, name: true, logo: true } },
      },
    });

    return this.transformProduct(updated);
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

    await this.prisma.product.delete({ where: { id: productId } });
    return { success: true, message: 'Product deleted' };
  }

  async getProduct(productId: string, userId?: string) {
    const product = await this.prisma.product.findUnique({
      where: { id: productId },
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
      },
    });

    if (!product) {
      throw new NotFoundException('Product not found');
    }

    const isOwner = userId && product.brand.ownerId === userId;

    // Store gating: brand must be open, collection must be store-enabled and published for non-owners
    if (!isOwner) {
      if (!product.brand.isStoreOpen) {
        throw new NotFoundException('Store is closed');
      }
      if (!product.collection.isAvailableInStore || product.collection.status !== 'PUBLISHED') {
        throw new NotFoundException('Product not available');
      }
    }

    // Check if user has wishlisted
    let isWishlisted = false;
    if (userId) {
      const wishlistItem = await this.prisma.wishlistItem.findUnique({
        where: { userId_productId: { userId, productId } },
      });
      isWishlisted = !!wishlistItem;
    }

    // Increment view count
    await this.prisma.product.update({
      where: { id: productId },
      data: { viewsCount: { increment: 1 } },
    });

    return { ...this.transformProduct(product), isWishlisted };
  }

  async getBrandProducts(
    brandId: string,
    options: {
      page?: number;
      limit?: number;
      category?: string;
      gender?: string;
      minPrice?: number;
      maxPrice?: number;
      sizes?: string[];
      colors?: string[];
      onSale?: boolean;
      sortBy?: 'newest' | 'price_asc' | 'price_desc' | 'popular';
      search?: string;
    } = {},
  ) {
    const {
      page = 1,
      limit = 20,
      category,
      gender,
      minPrice,
      maxPrice,
      sizes,
      colors,
      onSale,
      sortBy = 'newest',
      search,
    } = options;

    const where: any = {
      brandId,
      isActive: true,
      collection: {
        status: 'PUBLISHED',
        isAvailableInStore: true,
      },
    };

    // Gender filter
    if (gender && ['MALE', 'FEMALE', 'EVERYBODY'].includes(gender.toUpperCase())) {
      where.gender = gender.toUpperCase();
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

    // On sale filter
    if (onSale) {
      const now = new Date();
      where.salePrice = { not: null };
      where.OR = [
        { saleStartAt: null, saleEndAt: null },
        { saleStartAt: { lte: now }, saleEndAt: { gte: now } },
        { saleStartAt: { lte: now }, saleEndAt: null },
        { saleStartAt: null, saleEndAt: { gte: now } },
      ];
    }

    // Search filter
    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { description: { contains: search, mode: 'insensitive' } },
        { tags: { hasSome: [search] } },
      ];
    }

    // Category filter via collection
    if (category) {
      where.collection = {
        ...(where.collection || {}),
        category: { slug: category },
      };
    }

    // Sorting
    let orderBy: any = { createdAt: 'desc' };
    switch (sortBy) {
      case 'price_asc':
        orderBy = { price: 'asc' };
        break;
      case 'price_desc':
        orderBy = { price: 'desc' };
        break;
      case 'popular':
        orderBy = { viewsCount: 'desc' };
        break;
      default:
        orderBy = { createdAt: 'desc' };
    }

    // Gate by brand store state
    const brand = await this.prisma.brand.findUnique({
      where: { id: brandId },
      select: { id: true, isStoreOpen: true },
    });
    if (!brand || !brand.isStoreOpen) {
      throw new NotFoundException('Store is closed');
    }

    const [products, total] = await Promise.all([
      this.prisma.product.findMany({
        where,
        orderBy,
        skip: (page - 1) * limit,
        take: limit,
        include: {
          collection: {
            select: {
              id: true,
              title: true,
              status: true,
              isAvailableInStore: true,
            },
          },
          brand: { select: { id: true, name: true, logo: true, currency: true } },
        },
      }),
      this.prisma.product.count({ where }),
    ]);

    return {
      items: products.map((p) => this.transformProduct(p)),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
      hasNextPage: page * limit < total,
    };
  }

  // ==================== CART ====================

  async addToCart(userId: string, dto: AddToCartDto) {
    const product = await this.prisma.product.findUnique({
      where: { id: dto.productId },
    });

    if (!product || !product.isActive) {
      throw new NotFoundException('Product not found or unavailable');
    }

    // Validate size if product has sizes
    if (product.sizes.length > 0 && !dto.selectedSize) {
      throw new BadRequestException('Please select a size');
    }
    if (dto.selectedSize && !product.sizes.includes(dto.selectedSize)) {
      throw new BadRequestException('Invalid size selected');
    }

    // Validate color if product has colors
    if (product.colors.length > 0 && !dto.selectedColor) {
      throw new BadRequestException('Please select a color');
    }
    if (dto.selectedColor && !product.colors.includes(dto.selectedColor)) {
      throw new BadRequestException('Invalid color selected');
    }

    // Check stock
    if (dto.selectedSize && product.sizeStock) {
      const sizeStock = product.sizeStock as Record<string, number>;
      const available = sizeStock[dto.selectedSize] || 0;
      if (available < (dto.quantity || 1)) {
        throw new BadRequestException(`Only ${available} items available in size ${dto.selectedSize}`);
      }
    } else if (product.totalStock < (dto.quantity || 1)) {
      throw new BadRequestException(`Only ${product.totalStock} items available`);
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
            brand: { select: { id: true, name: true, currency: true } },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    const cartItems = items.map((item) => {
      const product = item.product;
      const isOnSale = this.isProductOnSale(product);
      const effectivePrice = isOnSale && product.salePrice 
        ? Number(product.salePrice) 
        : Number(product.price);
      
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

  async updateCartItem(userId: string, cartItemId: string, dto: UpdateCartItemDto) {
    const item = await this.prisma.cartItem.findFirst({
      where: { id: cartItemId, userId },
      include: { product: true },
    });

    if (!item) {
      throw new NotFoundException('Cart item not found');
    }

    // Check stock
    if (item.selectedSize && item.product.sizeStock) {
      const sizeStock = item.product.sizeStock as Record<string, number>;
      const available = sizeStock[item.selectedSize] || 0;
      if (available < dto.quantity) {
        throw new BadRequestException(`Only ${available} items available`);
      }
    } else if (item.product.totalStock < dto.quantity) {
      throw new BadRequestException(`Only ${item.product.totalStock} items available`);
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
    const product = await this.prisma.product.findUnique({
      where: { id: dto.productId },
    });

    if (!product) {
      throw new NotFoundException('Product not found');
    }

    // Check if already in wishlist
    const existing = await this.prisma.wishlistItem.findUnique({
      where: { userId_productId: { userId, productId: dto.productId } },
    });

    if (existing) {
      return { success: true, message: 'Already in wishlist', isWishlisted: true };
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

    return { success: true, message: 'Removed from wishlist', isWishlisted: false };
  }

  async getWishlist(userId: string, page = 1, limit = 20) {
    const [items, total] = await Promise.all([
      this.prisma.wishlistItem.findMany({
        where: { userId },
        include: {
          product: {
            include: {
              brand: { select: { id: true, name: true, logo: true, currency: true } },
            },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.wishlistItem.count({ where: { userId } }),
    ]);

    const wishlistItems = items.map((item) => ({
      id: item.id,
      addedAt: item.createdAt,
      product: this.transformProduct(item.product),
    }));

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
      where: { userId_productId: { userId, productId } },
    });
    return { isWishlisted: !!item };
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
    const effectivePrice = isOnSale && product.salePrice 
      ? Number(product.salePrice) 
      : Number(product.price);
    
    // Calculate discount percentage
    let discountPercent: number | null = null;
    if (isOnSale && product.salePrice) {
      discountPercent = Math.round(
        ((Number(product.price) - Number(product.salePrice)) / Number(product.price)) * 100
      );
    }

    // Calculate size availability
    const sizeAvailability = product.sizes.map((size: string) => {
      const stock = product.sizeStock?.[size] ?? product.totalStock;
      return { size, inStock: stock > 0, quantity: stock };
    });

    return {
      id: product.id,
      collectionId: product.collectionId,
      brandId: product.brandId,
      name: product.name,
      description: product.description,
      price: Number(product.price),
      salePrice: product.salePrice ? Number(product.salePrice) : null,
      effectivePrice,
      isOnSale,
      discountPercent,
      saleStartAt: product.saleStartAt,
      saleEndAt: product.saleEndAt,
      sizes: product.sizes,
      sizeStock: product.sizeStock,
      sizeAvailability,
      colors: product.colors,
      colorImages: product.colorImages,
      images: product.images,
      thumbnail: product.thumbnail,
      totalStock: product.totalStock,
      lowStockThreshold: product.lowStockThreshold,
      isLowStock: product.totalStock > 0 && product.totalStock <= product.lowStockThreshold,
      isOutOfStock: product.totalStock === 0,
      tags: product.tags,
      gender: product.gender,
      isActive: product.isActive,
      isFeatured: product.isFeatured,
      viewsCount: product.viewsCount,
      likesCount: product.likesCount,
      createdAt: product.createdAt,
      updatedAt: product.updatedAt,
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
          },
        },
      },
      orderBy: { createdAt: 'asc' },
    });

    if (cartItems.length === 0) {
      throw new BadRequestException('Cart is empty');
    }

    // Map items by brand to produce brand-scoped orders
    const itemsByBrand = cartItems.reduce<Record<string, typeof cartItems>>((acc, item) => {
      const brandId = item.product.brandId;
      if (!acc[brandId]) acc[brandId] = [];
      acc[brandId].push(item);
      return acc;
    }, {});

    const orders = await this.prisma.$transaction(async (tx) => {
      const createdOrders = [] as any[];

      for (const [brandId, items] of Object.entries(itemsByBrand)) {
        const brand = await tx.brand.findUnique({
          where: { id: brandId },
          select: { id: true, name: true, currency: true, isStoreOpen: true, ownerId: true },
        });

        if (!brand || !brand.isStoreOpen) {
          throw new BadRequestException('Store is closed');
        }

        const orderItems: any[] = [];
        let totalAmount = 0;

        for (const item of items) {
          const product = await tx.product.findUnique({
            where: { id: item.productId },
            include: { collection: true },
          });

          if (!product || !product.isActive) {
            throw new BadRequestException('Product not available');
          }

          if (!product.collection || !product.collection.isAvailableInStore || product.collection.status !== 'PUBLISHED') {
            throw new BadRequestException(`Product not available in store: ${product.name}`);
          }

          if (item.selectedSize && product.sizes.length > 0 && !product.sizes.includes(item.selectedSize)) {
            throw new BadRequestException(`Invalid size for ${product.name}`);
          }
          if (item.selectedColor && product.colors.length > 0 && !product.colors.includes(item.selectedColor)) {
            throw new BadRequestException(`Invalid color for ${product.name}`);
          }

          const sizeStock = (product.sizeStock as Record<string, number> | null) || null;
          const quantity = item.quantity;

          if (item.selectedSize && sizeStock) {
            const available = sizeStock[item.selectedSize] || 0;
            if (available < quantity) {
              throw new BadRequestException(`Only ${available} left for ${product.name} (${item.selectedSize})`);
            }
            sizeStock[item.selectedSize] = available - quantity;
          } else if (product.totalStock < quantity) {
            throw new BadRequestException(`Only ${product.totalStock} left for ${product.name}`);
          }

          const isOnSale = this.isProductOnSale(product);
          const unitPrice = isOnSale && product.salePrice ? Number(product.salePrice) : Number(product.price);
          totalAmount += unitPrice * quantity;

          await tx.product.update({
            where: { id: product.id },
            data: {
              totalStock: { decrement: quantity },
              ...(sizeStock ? { sizeStock } : {}),
            },
          });

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
          brand: { select: { id: true, name: true, logo: true, currency: true } },
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
}
