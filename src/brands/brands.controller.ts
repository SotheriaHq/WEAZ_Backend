import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Delete,
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
import { UpdateBrandProfileDto } from './dto/update-brand-profile.dto';
import { AuthUserResponseDto } from '../auth/dto/auth-response.dto';
import { TransformInterceptor } from '../transform/transform.interceptor';
import { Request } from 'express';
import { CollectionsService } from '../collections/collections.service';
import { UserTypeGuard } from '../auth/guard/user-type.guard';
import { UserType, PatchStatus } from '@prisma/client';
import { JwtAuthGuard } from '../auth/guard/jwt-auth.guard';

@Controller()
export class BrandsController {
  constructor(
    private readonly brandsService: BrandsService,
    private readonly collectionsService: CollectionsService,
  ) {}

  // ... existing methods ...

  // ===================== Brand Patching =====================

  @UseGuards(JwtAuthGuard, new UserTypeGuard(UserType.BRAND))
  @Post('brands/:id/patches/request')
  async requestBrandPatch(
    @Param('id') brandId: string, // Target brand ID
    @Req() req: any,
  ) {
    // req.user.id is the requester
    return this.brandsService.requestBrandPatch(req.user.id, brandId);
  }

  @UseGuards(JwtAuthGuard, new UserTypeGuard(UserType.BRAND))
  @Patch('brands/patches/:patchId/respond')
  async respondToBrandPatch(
    @Param('patchId') patchId: string,
    @Body() body: { status: 'ACCEPTED' | 'REJECTED' },
    @Req() req: any,
  ) {
    const status = body.status === 'ACCEPTED' ? PatchStatus.ACCEPTED : PatchStatus.REJECTED;
    return this.brandsService.respondToBrandPatch(req.user.id, patchId, status);
  }

  @UseGuards(JwtAuthGuard)
  @Get('brands/:id/patches')
  async getBrandPatches(
    @Param('id') brandId: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.brandsService.getBrandPatches(
      brandId,
      PatchStatus.ACCEPTED,
      page ? parseInt(page, 10) : 1,
      limit ? parseInt(limit, 10) : 20,
    );
  }

  @UseGuards(JwtAuthGuard, new UserTypeGuard(UserType.BRAND))
  @Get('brands/me/patches/requests')
  async getMyPatchRequests(@Req() req: any) {
    return this.brandsService.getPendingPatchRequests(req.user.id);
  }

  // ===================== Subscriptions =====================

  @UseGuards(JwtAuthGuard)
  @Post('brands/:id/subscribe')
  async subscribe(@Param('id') brandId: string, @Req() req: any) {
    return this.brandsService.subscribeToBrand(req.user.id, brandId);
  }

  @UseGuards(JwtAuthGuard)
  @Delete('brands/:id/subscribe')
  async unsubscribe(@Param('id') brandId: string, @Req() req: any) {
    return this.brandsService.unsubscribeFromBrand(req.user.id, brandId);
  }

  @UseGuards(JwtAuthGuard, new UserTypeGuard(UserType.BRAND))
  @Get('brands/me/subscribers')
  async getMySubscribers(
    @Req() req: any,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.brandsService.getSubscribers(
      req.user.id,
      page ? parseInt(page, 10) : 1,
      limit ? parseInt(limit, 10) : 20,
    );
  }

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

  // ===================== Private Access (Brand-scoped) =====================
  @UseGuards(JwtAuthGuard, new UserTypeGuard(UserType.BRAND))
  @Get('brands/:id/private-access/requests')
  async listBrandAccessRequests(
    @Param('id') brandId: string,
    @Req() req: any,
    @Query('status') status?: 'pending' | 'approved',
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
    @Query('q') q?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    if (req.user?.id !== brandId) {
      throw new BadRequestException('Not authorized for this brand');
    }
    const take = pageSize
      ? parseInt(pageSize, 10)
      : limit
        ? parseInt(limit, 10)
        : 20;
    const pageNum = page ? parseInt(page, 10) : undefined;
    return this.collectionsService.listBrandAccessRequests(
      brandId,
      req.user.id,
      status === 'approved' ? 'APPROVED' : 'PENDING',
      take,
      cursor,
      q,
      pageNum,
    );
  }

  @UseGuards(JwtAuthGuard)
  @Get('brands/:id/private-access/my-states')
  async myAccessStates(@Param('id') brandId: string, @Req() req: any) {
    const viewerId = req.user?.id;
    return this.collectionsService.listViewerAccessStatesForBrand(
      brandId,
      viewerId,
    );
  }

  @UseGuards(JwtAuthGuard, new UserTypeGuard(UserType.BRAND))
  @Patch('brands/:id/private-access/:collectionId/:userId')
  async brandUpdateAccess(
    @Param('id') brandId: string,
    @Param('collectionId') collectionId: string,
    @Param('userId') userId: string,
    @Body() body: { state: 'APPROVED' | 'REVOKED' },
    @Req() req: any,
  ) {
    if (req.user?.id !== brandId) {
      throw new BadRequestException('Not authorized for this brand');
    }
    return this.collectionsService.updateAccessState(
      collectionId,
      req.user.id,
      userId,
      body?.state === 'APPROVED' ? 'APPROVED' : 'REVOKED',
    );
  }

  @UseGuards(JwtAuthGuard, new UserTypeGuard(UserType.BRAND))
  @Patch('brands/:id/private-access/:collectionId/:userId/reject')
  async brandRejectAccess(
    @Param('id') brandId: string,
    @Param('collectionId') collectionId: string,
    @Param('userId') userId: string,
    @Req() req: any,
  ) {
    if (req.user?.id !== brandId) {
      throw new BadRequestException('Not authorized for this brand');
    }
    return this.collectionsService.rejectAccess(
      collectionId,
      req.user.id,
      userId,
    );
  }

  @UseGuards(JwtAuthGuard, new UserTypeGuard(UserType.BRAND))
  @Patch('brands/:id/private-access/:collectionId/approve')
  async brandApproveBulk(
    @Param('id') brandId: string,
    @Param('collectionId') collectionId: string,
    @Body() body: { userIds: string[] },
    @Req() req: any,
  ) {
    if (req.user?.id !== brandId) {
      throw new BadRequestException('Not authorized for this brand');
    }
    return this.collectionsService.approveAccessBulk(
      collectionId,
      req.user.id,
      Array.isArray(body?.userIds) ? body.userIds : [],
    );
  }

  // ===================== Private Access (User-scoped) =====================
  
  @UseGuards(JwtAuthGuard)
  @Get('users/me/private-access/requests')
  async listMyAccessRequests(
    @Req() req: any,
    @Query('status') status?: 'pending' | 'approved' | 'rejected',
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    const userId = req.user?.id;
    const take = pageSize ? parseInt(pageSize, 10) : 20;
    const pageNum = page ? parseInt(page, 10) : 1;
    return this.collectionsService.listUserAccessRequests(
      userId,
      status,
      take,
      pageNum,
    );
  }

  @UseGuards(JwtAuthGuard)
  @Get('users/me/private-access/granted')
  async listMyGrantedAccesses(
    @Req() req: any,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    const userId = req.user?.id;
    const take = pageSize ? parseInt(pageSize, 10) : 20;
    const pageNum = page ? parseInt(page, 10) : 1;
    return this.collectionsService.listUserGrantedAccesses(
      userId,
      take,
      pageNum,
    );
  }

  @UseGuards(JwtAuthGuard)
  @Patch('users/me/private-access/requests/:requestId/cancel')
  async cancelMyAccessRequest(
    @Param('requestId') requestId: string,
    @Req() req: any,
  ) {
    const userId = req.user?.id;
    return this.collectionsService.cancelAccessRequest(requestId, userId);
  }

  @UseGuards(JwtAuthGuard)
  @Patch('users/me/private-access/granted/:accessId/revoke')
  async revokeMyAccess(
    @Param('accessId') accessId: string,
    @Req() req: any,
  ) {
    const userId = req.user?.id;
    return this.collectionsService.userRevokeOwnAccess(accessId, userId);
  }
}
