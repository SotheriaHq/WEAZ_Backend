import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Query,
  Req,
  UseGuards,
  UseInterceptors,
  ValidationPipe,
} from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import {
  BrandsService,
  BrandProfileResponse,
  BrandReviewsResponse,
} from './brands.service';
import { JwtAuthGuard } from '../auth/guard/jwt-auth.guard';
import { UpdateBrandProfileDto } from './dto/update-brand-profile.dto';
import { AuthUserResponseDto } from '../auth/dto/auth-response.dto';
import { TransformInterceptor } from '../transform/transform.interceptor';
import { Request } from 'express';

@Controller()
export class BrandsController {
  constructor(private readonly brandsService: BrandsService) {}

  @Get('brands/:id')
  @SkipThrottle()
  async getBrandProfile(
    @Param('id') id: string,
  ): Promise<BrandProfileResponse> {
    if (!id) {
      throw new BadRequestException('Brand id is required');
    }
    return this.brandsService.getBrandProfile(id);
  }

  @Get('reviews')
  @SkipThrottle()
  async getBrandReviews(
    @Query('brandId') brandId?: string,
  ): Promise<BrandReviewsResponse> {
    if (!brandId) {
      throw new BadRequestException('brandId query parameter is required');
    }
    return this.brandsService.getBrandReviews(brandId);
  }

  @Patch('brands/:id')
  @UseGuards(JwtAuthGuard)
  @UseInterceptors(TransformInterceptor)
  async updateBrandProfile(
    @Param('id') id: string,
    @Body(ValidationPipe) dto: UpdateBrandProfileDto,
    @Req() req: Request & { user: { id: string } },
  ): Promise<AuthUserResponseDto> {
    if (!id) {
      throw new BadRequestException('Brand id is required');
    }
    if (!req.user || req.user.id !== id) {
      throw new BadRequestException('You can only update your own profile');
    }
    return this.brandsService.updateBrandProfile(id, dto);
  }
}
