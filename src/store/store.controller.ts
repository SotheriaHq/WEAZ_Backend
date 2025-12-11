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
} from '@nestjs/common';
import { StoreService } from './store.service';
import { CreateProductDto, UpdateProductDto } from './dto/create-product.dto';
import { AddToCartDto, UpdateCartItemDto } from './dto/cart.dto';
import { AddToWishlistDto } from './dto/wishlist.dto';
import { JwtAuthGuard } from '../auth/guard/jwt-auth.guard';
import { UserTypeGuard } from '../auth/guard/user-type.guard';
import { OptionalJwtAuthGuard } from '../auth/guard/optional-jwt-auth.guard';
import { UserType } from '@prisma/client';

@Controller()
export class StoreController {
  constructor(private readonly storeService: StoreService) {}

  // ==================== PRODUCTS ====================

  @UseGuards(JwtAuthGuard, new UserTypeGuard(UserType.BRAND))
  @Post('products')
  async createProduct(
    @Body(ValidationPipe) dto: CreateProductDto,
    @Req() req: any,
  ) {
    return this.storeService.createProduct(req.user.id, dto);
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
  @Delete('products/:id')
  async deleteProduct(@Param('id') productId: string, @Req() req: any) {
    return this.storeService.deleteProduct(req.user.id, productId);
  }

  @UseGuards(OptionalJwtAuthGuard)
  @Get('products/:id')
  async getProduct(@Param('id') productId: string, @Req() req: any) {
    return this.storeService.getProduct(productId, req.user?.id);
  }

  @Get('brands/:brandId/products')
  async getBrandProducts(
    @Param('brandId') brandId: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('category') category?: string,
    @Query('gender') gender?: string,
    @Query('minPrice') minPrice?: string,
    @Query('maxPrice') maxPrice?: string,
    @Query('sizes') sizes?: string,
    @Query('colors') colors?: string,
    @Query('onSale') onSale?: string,
    @Query('sortBy') sortBy?: 'newest' | 'price_asc' | 'price_desc' | 'popular',
    @Query('search') search?: string,
  ) {
    return this.storeService.getBrandProducts(brandId, {
      page: page ? parseInt(page, 10) : 1,
      limit: limit ? parseInt(limit, 10) : 20,
      category,
      gender,
      minPrice: minPrice ? parseFloat(minPrice) : undefined,
      maxPrice: maxPrice ? parseFloat(maxPrice) : undefined,
      sizes: sizes ? sizes.split(',') : undefined,
      colors: colors ? colors.split(',') : undefined,
      onSale: onSale === 'true',
      sortBy,
      search,
    });
  }

  // ==================== CART ====================

  @UseGuards(JwtAuthGuard)
  @Post('cart')
  async addToCart(@Body(ValidationPipe) dto: AddToCartDto, @Req() req: any) {
    return this.storeService.addToCart(req.user.id, dto);
  }

  @UseGuards(JwtAuthGuard)
  @Get('cart')
  async getCart(@Req() req: any) {
    return this.storeService.getCart(req.user.id);
  }

  @UseGuards(JwtAuthGuard)
  @Patch('cart/:itemId')
  async updateCartItem(
    @Param('itemId') itemId: string,
    @Body(ValidationPipe) dto: UpdateCartItemDto,
    @Req() req: any,
  ) {
    return this.storeService.updateCartItem(req.user.id, itemId, dto);
  }

  @UseGuards(JwtAuthGuard)
  @Delete('cart/:itemId')
  async removeFromCart(@Param('itemId') itemId: string, @Req() req: any) {
    return this.storeService.removeFromCart(req.user.id, itemId);
  }

  @UseGuards(JwtAuthGuard)
  @Delete('cart')
  async clearCart(@Req() req: any) {
    return this.storeService.clearCart(req.user.id);
  }

  // ==================== WISHLIST ====================

  @UseGuards(JwtAuthGuard)
  @Post('wishlist')
  async addToWishlist(
    @Body(ValidationPipe) dto: AddToWishlistDto,
    @Req() req: any,
  ) {
    return this.storeService.addToWishlist(req.user.id, dto);
  }

  @UseGuards(JwtAuthGuard)
  @Delete('wishlist/:productId')
  async removeFromWishlist(
    @Param('productId') productId: string,
    @Req() req: any,
  ) {
    return this.storeService.removeFromWishlist(req.user.id, productId);
  }

  @UseGuards(JwtAuthGuard)
  @Get('wishlist')
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
  @Get('wishlist/check/:productId')
  async isInWishlist(@Param('productId') productId: string, @Req() req: any) {
    return this.storeService.isInWishlist(req.user.id, productId);
  }
}
