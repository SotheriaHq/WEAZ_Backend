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
import {
  BulkArchiveProductsDto,
  BulkDeleteProductsDto,
  BulkUnpublishProductsDto,
} from './dto/bulk-product-actions.dto';
import { UpdateStoreNameDto } from './dto/update-store-name.dto';
import { UpdateStoreProfileDto } from './dto/update-store-profile.dto';
import { UpdateStorePoliciesDto } from './dto/update-store-policies.dto';
import { UpdateStorePaymentAccountDto } from './dto/update-store-payment-account.dto';
import { VerifyStorePaymentAccountDto } from './dto/verify-store-payment-account.dto';
import { JwtAuthGuard } from '../auth/guard/jwt-auth.guard';
import { UserTypeGuard } from '../auth/guard/user-type.guard';
import { OptionalJwtAuthGuard } from '../auth/guard/optional-jwt-auth.guard';
import { UserType } from '@prisma/client';
import { Throttle } from '@nestjs/throttler';
import { IdempotencyInterceptor } from '../common/interceptors/idempotency.interceptor';
import { resolveSearchQuery } from '../common/utils/search-query';

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
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } })) // Hard cap; dynamic limit enforced in service
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

  // ═══════════════════════════════════════════════════════════════════════════════
  // ARCHIVE & DELETE ENDPOINTS
  // ═══════════════════════════════════════════════════════════════════════════════

  @UseGuards(JwtAuthGuard, new UserTypeGuard(UserType.BRAND))
  @Get('products/:id/delete-impact')
  async getDeleteImpact(@Param('id') productId: string, @Req() req: any) {
    return this.storeService.getDeleteImpact(req.user.id, productId);
  }

  @UseGuards(JwtAuthGuard, new UserTypeGuard(UserType.BRAND))
  @Post('products/:id/archive')
  async archiveProduct(@Param('id') productId: string, @Req() req: any) {
    return this.storeService.archiveProduct(req.user.id, productId);
  }

  @UseGuards(JwtAuthGuard, new UserTypeGuard(UserType.BRAND))
  @Post('products/:id/unarchive')
  async unarchiveProduct(@Param('id') productId: string, @Req() req: any) {
    return this.storeService.unarchiveProduct(req.user.id, productId);
  }

  @UseGuards(JwtAuthGuard, new UserTypeGuard(UserType.BRAND))
  @Post('products/:id/republish-request')
  async requestProductRepublish(
    @Param('id') productId: string,
    @Body() body: { reason?: string },
    @Req() req: any,
  ) {
    return this.storeService.requestProductRepublishApproval(
      req.user.id,
      productId,
      body?.reason,
    );
  }

  // toggleFeatured removed — featuring is now admin-only via /admin/featured

  @UseGuards(JwtAuthGuard, new UserTypeGuard(UserType.BRAND))
  @Post('products/bulk/delete')
  @UseInterceptors(IdempotencyInterceptor)
  async bulkDeleteProducts(
    @Body(ValidationPipe) dto: BulkDeleteProductsDto,
    @Req() req: any,
  ) {
    return this.storeService.bulkDeleteProducts(req.user.id, dto);
  }

  @UseGuards(JwtAuthGuard, new UserTypeGuard(UserType.BRAND))
  @Post('products/bulk/archive')
  @UseInterceptors(IdempotencyInterceptor)
  async bulkArchiveProducts(
    @Body(ValidationPipe) dto: BulkArchiveProductsDto,
    @Req() req: any,
  ) {
    return this.storeService.bulkArchiveProducts(req.user.id, dto);
  }

  @UseGuards(JwtAuthGuard, new UserTypeGuard(UserType.BRAND))
  @Post('products/bulk/unpublish')
  @UseInterceptors(IdempotencyInterceptor)
  async bulkUnpublishProducts(
    @Body(ValidationPipe) dto: BulkUnpublishProductsDto,
    @Req() req: any,
  ) {
    return this.storeService.bulkUnpublishProducts(req.user.id, dto);
  }

  @UseGuards(JwtAuthGuard, new UserTypeGuard(UserType.BRAND))
  @Delete('products/:id')
  async deleteProduct(
    @Param('id') productId: string,
    @Req() req: any,
    @Query('cancelPendingOrders') cancelPendingOrders?: string,
  ) {
    const cancelFlag = cancelPendingOrders === 'true';
    return this.storeService.deleteProduct(req.user.id, productId, cancelFlag);
  }

  @UseGuards(JwtAuthGuard, new UserTypeGuard(UserType.BRAND))
  @Delete('products/:id/permanent')
  async permanentlyDeleteProduct(@Param('id') productId: string, @Req() req: any) {
    return this.storeService.permanentlyDeleteProduct(req.user.id, productId);
  }

  @UseGuards(JwtAuthGuard, new UserTypeGuard(UserType.BRAND))
  @Post('products/:id/restore')
  async restoreProduct(@Param('id') productId: string, @Req() req: any) {
    return this.storeService.restoreProduct(req.user.id, productId);
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // PRICE CHANGE PREVIEW
  // ═══════════════════════════════════════════════════════════════════════════════

  @UseGuards(JwtAuthGuard, new UserTypeGuard(UserType.BRAND))
  @Post('products/:id/price-preview')
  async getProductPriceChangePreview(
    @Param('id') productId: string,
    @Body() body: { newPrice: number; newSalePrice?: number },
    @Req() req: any,
  ) {
    return this.storeService.getProductPriceChangePreview(
      req.user.id,
      productId,
      body.newPrice,
      body.newSalePrice,
    );
  }

  @UseGuards(OptionalJwtAuthGuard)
  @Get('public/storefronts/:slug')
  @Throttle({ default: { limit: 120, ttl: 60000 } })
  async resolveStorefrontBySlug(@Param('slug') slug: string) {
    return this.storeService.resolvePublicStorefrontBySlug(slug);
  }

  @UseGuards(OptionalJwtAuthGuard)
  @Get('public/products/slug/:slug')
  @Throttle({ default: { limit: 120, ttl: 60000 } })
  async resolveProductBySlug(@Param('slug') slug: string, @Req() req: any) {
    return this.storeService.resolvePublicProductBySlug(slug, req.user?.id);
  }

  @UseGuards(OptionalJwtAuthGuard)
  @Get(['products/market', 'store/products/market'])
  @Throttle({ default: { limit: 120, ttl: 60000 } })
  async getMarketplaceProducts(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
    @Query('collectionId') collectionId?: string,
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
    @Query('q') q?: string,
    @Query('search') search?: string,
  ) {
    const resolvedSortBy = sortBy ?? sort;
    const resolvedOnSale = this.parseBoolParam(onSale) ?? this.parseBoolParam(isOnSale);
    const resolvedIsFeatured = this.parseBoolParam(isFeatured);

    return this.storeService.getMarketplaceProducts({
      page: page ? parseInt(page, 10) : 1,
      limit: limit ? parseInt(limit, 10) : 40,
      cursor,
      collectionId,
      category,
      gender,
      minPrice: minPrice ? parseFloat(minPrice) : undefined,
      maxPrice: maxPrice ? parseFloat(maxPrice) : undefined,
      sizes: this.parseListParam(sizes),
      colors: this.parseListParam(colors),
      tags: this.parseListParam(tags),
      onSale: resolvedOnSale === true,
      isFeatured: resolvedIsFeatured,
      sortBy: resolvedSortBy,
      search: resolveSearchQuery(q, search),
    });
  }

  @UseGuards(OptionalJwtAuthGuard)
  @Get(['products/:id', 'store/products/:id'])
  @Throttle({ default: { limit: 120, ttl: 60000 } })
  async getProduct(
    @Param('id') productId: string,
    @Req() req: any,
    @Query('includeDeleted') includeDeleted?: string,
  ) {
    const includeDeletedFlag = this.parseBoolParam(includeDeleted) === true;
    return this.storeService.getProduct(productId, req.user?.id, includeDeletedFlag);
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
    @Query('q') q?: string,
    @Query('search') search?: string,
    @Query('includeDeleted') includeDeleted?: string,
    @Query('onlyDeleted') onlyDeleted?: string,
  ) {
    const resolvedSortBy = sortBy ?? sort;
    const resolvedOnSale = this.parseBoolParam(onSale) ?? this.parseBoolParam(isOnSale);
    const resolvedIsFeatured = this.parseBoolParam(isFeatured);
    const resolvedIncludeDeleted = this.parseBoolParam(includeDeleted);
    const resolvedOnlyDeleted = this.parseBoolParam(onlyDeleted);

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
      isFeatured: resolvedIsFeatured,
      sortBy: resolvedSortBy,
      search: resolveSearchQuery(q, search),
      includeDeleted: resolvedIncludeDeleted,
      onlyDeleted: resolvedOnlyDeleted,
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
  @Get(['orders/:orderId/resolve', 'store/orders/:orderId/resolve'])
  async resolveOrderAccess(@Param('orderId') orderId: string, @Req() req: any) {
    return this.storeService.resolveOrderAccess(req.user, orderId);
  }

  @UseGuards(JwtAuthGuard)
  @Get(['orders/:orderId', 'store/orders/:orderId'])
  async getMyOrder(@Param('orderId') orderId: string, @Req() req: any) {
    return this.storeService.getMyOrder(req.user.id, orderId);
  }

  @UseGuards(JwtAuthGuard)
  @Post(['orders/:orderId/confirm-delivery', 'store/orders/:orderId/confirm-delivery'])
  async confirmMyOrderDelivery(
    @Param('orderId') orderId: string,
    @Body() body: { note?: string },
    @Req() req: any,
  ) {
    return this.storeService.confirmOrderDelivery(req.user.id, orderId, body?.note);
  }

  @UseGuards(JwtAuthGuard)
  @Post(['orders/:orderId/cancel', 'store/orders/:orderId/cancel'])
  async cancelMyOrder(
    @Param('orderId') orderId: string,
    @Body() body: { reason?: string },
    @Req() req: any,
  ) {
    return this.storeService.cancelMyOrder(req.user.id, orderId, body?.reason);
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
  @Post('store/close')
  async closeStore(@Req() req: any) {
    return this.storeService.closeStore(req.user.id);
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

  @UseGuards(JwtAuthGuard, new UserTypeGuard(UserType.BRAND))
  @Get('store/policies')
  async getStorePolicies(@Req() req: any) {
    return this.storeService.getStorePolicies(req.user.id);
  }

  @UseGuards(JwtAuthGuard, new UserTypeGuard(UserType.BRAND))
  @Patch('store/policies')
  async updateStorePolicies(
    @Body(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
    dto: UpdateStorePoliciesDto,
    @Req() req: any,
  ) {
    return this.storeService.updateStorePolicies(req.user.id, dto);
  }

  @UseGuards(JwtAuthGuard, new UserTypeGuard(UserType.BRAND))
  @Get('store/payment-account')
  async getStorePaymentAccount(@Req() req: any) {
    return this.storeService.getStorePaymentAccount(req.user.id);
  }

  @UseGuards(JwtAuthGuard, new UserTypeGuard(UserType.BRAND))
  @Get('store/payment-account/banks')
  async listStorePaymentAccountBanks() {
    return this.storeService.listSupportedPaymentBanks();
  }

  @UseGuards(JwtAuthGuard, new UserTypeGuard(UserType.BRAND))
  @UseInterceptors(IdempotencyInterceptor)
  @Patch('store/payment-account')
  async updateStorePaymentAccount(
    @Body(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
    dto: UpdateStorePaymentAccountDto,
    @Req() req: any,
  ) {
    return this.storeService.updateStorePaymentAccount(req.user.id, dto);
  }

  @UseGuards(JwtAuthGuard, new UserTypeGuard(UserType.BRAND))
  @Post('store/payment-account/verify')
  async verifyStorePaymentAccount(
    @Body(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
    dto: VerifyStorePaymentAccountDto,
    @Req() req: any,
  ) {
    return this.storeService.verifyStorePaymentAccount(req.user.id, dto);
  }

  @UseGuards(JwtAuthGuard, new UserTypeGuard(UserType.BRAND))
  @Get('store/wallet')
  async getStoreWallet(@Req() req: any) {
    return this.storeService.getStoreWallet(req.user.id);
  }

  @UseGuards(JwtAuthGuard, new UserTypeGuard(UserType.BRAND))
  @Get('store/payouts')
  async listStorePayouts(
    @Req() req: any,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('status') status?: string,
  ) {
    return this.storeService.listStorePayouts(req.user.id, {
      page: page ? parseInt(page, 10) : 1,
      limit: limit ? parseInt(limit, 10) : 20,
      status,
    });
  }

  @UseGuards(JwtAuthGuard, new UserTypeGuard(UserType.BRAND))
  @Get('store/payouts/:payoutId')
  async getStorePayoutDetail(
    @Req() req: any,
    @Param('payoutId') payoutId: string,
  ) {
    return this.storeService.getStorePayoutDetail(req.user.id, payoutId);
  }

  @UseGuards(JwtAuthGuard, new UserTypeGuard(UserType.BRAND))
  @Get('store/payouts/:payoutId/statement')
  async getStorePayoutStatement(
    @Req() req: any,
    @Param('payoutId') payoutId: string,
  ) {
    return this.storeService.getStorePayoutStatement(req.user.id, payoutId);
  }
}
