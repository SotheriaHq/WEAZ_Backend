import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  Req,
  UseGuards,
  ValidationPipe,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { StoreService } from './store.service';
import { CreateProductDto, UpdateProductDto } from './dto/create-product.dto';
import { AddToCartDto, UpdateCartItemDto } from './dto/cart.dto';
import { AddToWishlistDto } from './dto/wishlist.dto';
import { CheckoutDto } from './dto/checkout.dto';
import { UpdateStoreNameDto } from './dto/update-store-name.dto';
import { UpdateStoreProfileDto } from './dto/update-store-profile.dto';
import { JwtAuthGuard } from '../auth/guard/jwt-auth.guard';
import { UserTypeGuard } from '../auth/guard/user-type.guard';
import { OptionalJwtAuthGuard } from '../auth/guard/optional-jwt-auth.guard';
import { UserType } from '@prisma/client';
import { Throttle } from '@nestjs/throttler';
import { IdempotencyInterceptor } from '../common/interceptors/idempotency.interceptor';

@Controller()
export class StoreController {
  constructor(private readonly storeService: StoreService) {}

  private parseListParam(value?: string | string[]): string[] | undefined {
    if (!value) return undefined;
    const raw = Array.isArray(value) ? value : [value];
    const items = raw
      .flatMap((v) => String(v).split(','))
      .map((v) => v.trim())
      .filter(Boolean);
    return items.length ? items : undefined;
  }

  private parseBoolParam(value?: string | boolean): boolean | undefined {
    if (typeof value === 'boolean') return value;
    if (typeof value !== 'string') return undefined;
    const v = value.trim().toLowerCase();
    if (v === 'true' || v === '1' || v === 'yes') return true;
    if (v === 'false' || v === '0' || v === 'no') return false;
    return undefined;
  }

  // ==================== PRODUCTS ====================

  // IMPORTANT: Static routes must come before `products/:id` to avoid capturing
  // `/products/categories` as `:id = categories`.

  @Get('products/categories')
  async getProductCategories() {
    // Product creation uses Collection categories.
    // We expose this alias for frontend compatibility.
    return this.storeService.getProductCategories();
  }

  @UseGuards(JwtAuthGuard, new UserTypeGuard(UserType.BRAND))
  @Post('products')
  @UseInterceptors(IdempotencyInterceptor)
  async createProduct(
    @Body(ValidationPipe) dto: CreateProductDto,
    @Req() req: any,
  ) {
    return this.storeService.createProduct(req.user.id, dto);
  }

  @UseGuards(JwtAuthGuard, new UserTypeGuard(UserType.BRAND))
  @Post('products/:id/media')
  @Throttle({ default: { limit: 20, ttl: 60000 } })
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage() }))
  async uploadProductMedia(
    @Param('id') productId: string,
    @UploadedFile() file: Express.Multer.File,
    @Body('isPrimary') isPrimaryRaw: string | boolean | undefined,
    @Req() req: any,
  ) {
    const isPrimary =
      typeof isPrimaryRaw === 'string'
        ? isPrimaryRaw === 'true'
        : Boolean(isPrimaryRaw);

    return this.storeService.uploadProductMedia(
      req.user.id,
      productId,
      file,
      isPrimary,
    );
  }

  @UseGuards(JwtAuthGuard, new UserTypeGuard(UserType.BRAND))
  @Delete('products/:id/media/:mediaId')
  async deleteProductMedia(
    @Param('id') productId: string,
    @Param('mediaId') mediaId: string,
    @Req() req: any,
  ) {
    return this.storeService.deleteProductMedia(req.user.id, productId, mediaId);
  }

  @UseGuards(JwtAuthGuard, new UserTypeGuard(UserType.BRAND))
  @Patch('products/:id/media/reorder')
  async reorderProductMedia(
    @Param('id') productId: string,
    @Body('mediaIds') mediaIds: string[],
    @Req() req: any,
  ) {
    return this.storeService.reorderProductMedia(req.user.id, productId, mediaIds);
  }

  @UseGuards(JwtAuthGuard, new UserTypeGuard(UserType.BRAND))
  @Patch('products/:id/media/:mediaId/primary')
  async setPrimaryProductMedia(
    @Param('id') productId: string,
    @Param('mediaId') mediaId: string,
    @Req() req: any,
  ) {
    return this.storeService.setPrimaryProductMedia(req.user.id, productId, mediaId);
  }

  @UseGuards(JwtAuthGuard, new UserTypeGuard(UserType.BRAND))
  @Patch('products/:id')
  async updateProduct(
    @Param('id') productId: string,
    @Body(ValidationPipe) dto: UpdateProductDto,
    @Req() req: any,
  ) {
    return this.storeService.updateProduct(req.user.id, productId, dto);
  }

  @UseGuards(JwtAuthGuard, new UserTypeGuard(UserType.BRAND))
  @Post('products/:id/duplicate')
  async duplicateProduct(@Param('id') productId: string, @Req() req: any) {
    return this.storeService.duplicateProduct(req.user.id, productId);
  }

  @UseGuards(JwtAuthGuard, new UserTypeGuard(UserType.BRAND))
  @Delete('products/:id')
  async deleteProduct(@Param('id') productId: string, @Req() req: any) {
    return this.storeService.deleteProduct(req.user.id, productId);
  }

  @UseGuards(OptionalJwtAuthGuard)
  @Get(['products/:id', 'store/products/:id'])
  @Throttle({ default: { limit: 120, ttl: 60000 } })
  async getProduct(@Param('id') productId: string, @Req() req: any) {
    return this.storeService.getProduct(productId, req.user?.id);
  }

  @UseGuards(OptionalJwtAuthGuard)
  @Get(['brands/:brandId/products', 'store/brands/:brandId/products'])
  @Throttle({ default: { limit: 120, ttl: 60000 } })
  async getBrandProducts(
    @Param('brandId') brandId: string,
    @Req() req: any,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
    @Query('collectionId') collectionId?: string,
    @Query('isActive') isActive?: string,
    @Query('category') category?: string,
    @Query('gender') gender?: string,
    @Query('minPrice') minPrice?: string,
    @Query('maxPrice') maxPrice?: string,
    @Query('sizes') sizes?: string | string[],
    @Query('colors') colors?: string | string[],
    @Query('tags') tags?: string | string[],
    @Query('onSale') onSale?: string,
    @Query('isOnSale') isOnSale?: string,
    @Query('isFeatured') isFeatured?: string,
    @Query('sortBy') sortBy?: 'newest' | 'price_asc' | 'price_desc' | 'popular',
    @Query('sort') sort?: 'newest' | 'price_asc' | 'price_desc' | 'popular',
    @Query('search') search?: string,
  ) {
    const resolvedSortBy = sortBy ?? sort;
    const resolvedOnSale = this.parseBoolParam(onSale) ?? this.parseBoolParam(isOnSale);

    return this.storeService.getBrandProducts(brandId, {
      page: page ? parseInt(page, 10) : 1,
      limit: limit ? parseInt(limit, 10) : 20,
      cursor,
      collectionId,
      isActive: typeof isActive === 'string' ? isActive === 'true' : undefined,
      category,
      gender,
      minPrice: minPrice ? parseFloat(minPrice) : undefined,
      maxPrice: maxPrice ? parseFloat(maxPrice) : undefined,
      sizes: this.parseListParam(sizes),
      colors: this.parseListParam(colors),
      tags: this.parseListParam(tags),
      onSale: resolvedOnSale === true,
      isFeatured: this.parseBoolParam(isFeatured) === true,
      sortBy: resolvedSortBy,
      search,
      requesterId: req.user?.id,
    });
  }

  // ==================== CART ====================

  @UseGuards(JwtAuthGuard)
  @Post(['cart', 'store/cart'])
  async addToCart(@Body(ValidationPipe) dto: AddToCartDto, @Req() req: any) {
    return this.storeService.addToCart(req.user.id, dto);
  }

  @UseGuards(JwtAuthGuard)
  @Get(['cart', 'store/cart'])
  async getCart(@Req() req: any) {
    return this.storeService.getCart(req.user.id);
  }

  @UseGuards(JwtAuthGuard)
  @Patch(['cart/:itemId', 'store/cart/:itemId'])
  async updateCartItem(
    @Param('itemId') itemId: string,
    @Body(ValidationPipe) dto: UpdateCartItemDto,
    @Req() req: any,
  ) {
    return this.storeService.updateCartItem(req.user.id, itemId, dto);
  }

  @UseGuards(JwtAuthGuard)
  @Delete(['cart/:itemId', 'store/cart/:itemId'])
  async removeFromCart(@Param('itemId') itemId: string, @Req() req: any) {
    return this.storeService.removeFromCart(req.user.id, itemId);
  }

  @UseGuards(JwtAuthGuard)
  @Delete(['cart', 'store/cart'])
  async clearCart(@Req() req: any) {
    return this.storeService.clearCart(req.user.id);
  }

  // ==================== WISHLIST ====================

  @UseGuards(JwtAuthGuard)
  @Post(['wishlist', 'store/wishlist'])
  async addToWishlist(
    @Body(ValidationPipe) dto: AddToWishlistDto,
    @Req() req: any,
  ) {
    return this.storeService.addToWishlist(req.user.id, dto);
  }

  @UseGuards(JwtAuthGuard)
  @Delete(['wishlist/:productId', 'store/wishlist/:productId'])
  async removeFromWishlist(
    @Param('productId') productId: string,
    @Req() req: any,
  ) {
    return this.storeService.removeFromWishlist(req.user.id, productId);
  }

  @UseGuards(JwtAuthGuard)
  @Get(['wishlist', 'store/wishlist'])
  async getWishlist(
    @Req() req: any,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.storeService.getWishlist(
      req.user.id,
      page ? parseInt(page, 10) : 1,
      limit ? parseInt(limit, 10) : 20,
    );
  }

  @UseGuards(JwtAuthGuard)
  @Get([
    'wishlist/check/:productId',
    'store/wishlist/check/:productId',
    'wishlist/:productId/check',
    'store/wishlist/:productId/check',
  ])
  async isInWishlist(@Param('productId') productId: string, @Req() req: any) {
    return this.storeService.isInWishlist(req.user.id, productId);
  }

  // ==================== CHECKOUT ====================

  @UseGuards(JwtAuthGuard)
  @Post(['checkout', 'store/checkout'])
  @UseInterceptors(IdempotencyInterceptor)
  async checkout(@Body(ValidationPipe) dto: CheckoutDto, @Req() req: any) {
    return this.storeService.checkout(req.user.id, dto);
  }

  // ==================== BUYER ORDERS ====================

  @UseGuards(JwtAuthGuard)
  @Get(['orders', 'store/orders'])
  async getMyOrders(
    @Req() req: any,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.storeService.getMyOrders(
      req.user.id,
      page ? parseInt(page, 10) : 1,
      limit ? parseInt(limit, 10) : 20,
    );
  }

  @UseGuards(JwtAuthGuard)
  @Get(['orders/:orderId', 'store/orders/:orderId'])
  async getMyOrder(@Param('orderId') orderId: string, @Req() req: any) {
    return this.storeService.getMyOrder(req.user.id, orderId);
  }

  // ==================== STORE SETUP & STATUS ====================

  @UseGuards(JwtAuthGuard, new UserTypeGuard(UserType.BRAND))
  @Get('store/wizard/prefill')
  async getStoreWizardPrefill(@Req() req: any) {
    return this.storeService.getStoreWizardPrefill(req.user.id);
  }

  @UseGuards(JwtAuthGuard, new UserTypeGuard(UserType.BRAND))
  @Get('store/settings/general')
  async getStoreGeneralSettings(@Req() req: any) {
    return this.storeService.getStoreGeneralSettings(req.user.id);
  }

  @UseGuards(JwtAuthGuard, new UserTypeGuard(UserType.BRAND))
  @Patch('store/settings/name')
  async updateStoreName(
    @Body(ValidationPipe) dto: UpdateStoreNameDto,
    @Req() req: any,
  ) {
    return this.storeService.updateStoreName(req.user.id, dto);
  }

  @UseGuards(JwtAuthGuard, new UserTypeGuard(UserType.BRAND))
  @Get('store/status')
  async getStoreStatus(@Req() req: any) {
    return this.storeService.getStoreStatus(req.user.id);
  }

  @UseGuards(JwtAuthGuard, new UserTypeGuard(UserType.BRAND))
  @Post('store/open')
  async openStore(@Req() req: any) {
    return this.storeService.openStore(req.user.id);
  }

  @UseGuards(JwtAuthGuard, new UserTypeGuard(UserType.BRAND))
  @Patch('store/profile')
  async updateStoreProfile(
    @Body(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
    dto: UpdateStoreProfileDto,
    @Req() req: any,
  ) {
    return this.storeService.updateStoreProfile(req.user.id, dto);
  }
}
