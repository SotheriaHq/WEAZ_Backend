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
} from './brands.service';
import { UpdateBrandProfileDto } from './dto/update-brand-profile.dto';
import { AuthUserResponseDto } from '../auth/dto/auth-response.dto';
import { TransformInterceptor } from '../transform/transform.interceptor';
import { Request } from 'express';
import { CollectionsService } from '../collections/collections.service';
import { UserTypeGuard } from '../auth/guard/user-type.guard';
import { UserType, PatchStatus } from '@prisma/client';
import { JwtAuthGuard } from '../auth/guard/jwt-auth.guard';
import { BrandVerificationService } from '../brand-verification/brand-verification.service';
import {
  FinalizeVerificationUploadDto,
  PresignVerificationUploadDto,
  ResubmitVerificationInfoDto,
  SaveVerificationDraftDto,
  SignVerificationLetterDto,
  SubmitBrandVerificationDto,
  VerificationNudgePreferenceDto,
  VerificationVersionDto,
} from '../brand-verification/dto/verification.dto';

@Controller()
export class BrandsController {
  constructor(
    private readonly brandsService: BrandsService,
    private readonly collectionsService: CollectionsService,
    private readonly brandVerificationService: BrandVerificationService,
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
    const status =
      body.status === 'ACCEPTED' ? PatchStatus.ACCEPTED : PatchStatus.REJECTED;
    return this.brandsService.respondToBrandPatch(req.user.id, patchId, status);
  }

  @UseGuards(JwtAuthGuard)
  @Get('brands/:id/patches')
  async getBrandPatches(
    @Param('id') brandId: string,
    @Query('status') status?: 'PENDING' | 'ACCEPTED' | 'REJECTED',
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Req() req?: any,
  ) {
    if (req?.user?.id !== brandId) {
      throw new BadRequestException('Not authorized for this brand');
    }
    return this.brandsService.getBrandPatches(
      brandId,
      status === 'PENDING'
        ? PatchStatus.PENDING
        : status === 'REJECTED'
          ? PatchStatus.REJECTED
          : PatchStatus.ACCEPTED,
      page ? parseInt(page, 10) : 1,
      limit ? parseInt(limit, 10) : 20,
    );
  }

  @UseGuards(JwtAuthGuard, new UserTypeGuard(UserType.BRAND))
  @Delete('brands/patches/:patchId')
  async cancelBrandPatch(
    @Param('patchId') patchId: string,
    @Req() req: any,
  ) {
    return this.brandsService.cancelBrandPatch(req.user.id, patchId);
  }

  @UseGuards(JwtAuthGuard, new UserTypeGuard(UserType.BRAND))
  @Get('brands/me/patches/requests')
  async getMyPatchRequests(@Req() req: any) {
    return this.brandsService.getPendingPatchRequests(req.user.id);
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
  async revokeMyAccess(@Param('accessId') accessId: string, @Req() req: any) {
    const userId = req.user?.id;
    return this.collectionsService.userRevokeOwnAccess(accessId, userId);
  }

  // ===================== Dashboard Endpoints =====================

  @UseGuards(JwtAuthGuard, new UserTypeGuard(UserType.BRAND))
  @Get('brands/:id/dashboard/overview')
  async getDashboardOverview(@Param('id') brandId: string, @Req() req: any) {
    if (req.user.id !== brandId) {
      throw new BadRequestException('Not authorized for this brand');
    }
    return this.brandsService.getDashboardOverview(brandId);
  }

  @UseGuards(JwtAuthGuard, new UserTypeGuard(UserType.BRAND))
  @Get('brands/:id/dashboard/analytics')
  async getDashboardAnalytics(
    @Param('id') brandId: string,
    @Req() req: any,
    @Query('range') range: '7d' | '30d' | 'ytd' = '30d',
  ) {
    if (req.user.id !== brandId) {
      throw new BadRequestException('Not authorized for this brand');
    }
    return this.brandsService.getDashboardAnalytics(brandId, range);
  }

  @UseGuards(JwtAuthGuard, new UserTypeGuard(UserType.BRAND))
  @Get('brands/:id/dashboard/activity-feed')
  async getDashboardActivityFeed(
    @Param('id') brandId: string,
    @Req() req: any,
    @Query('limit') limit?: string,
  ) {
    if (req.user.id !== brandId) {
      throw new BadRequestException('Not authorized for this brand');
    }

    return this.brandsService.getDashboardActivityFeed(
      brandId,
      limit ? parseInt(limit, 10) : 12,
    );
  }

  // ===================== Brand Verification =====================

  @UseGuards(JwtAuthGuard, new UserTypeGuard(UserType.BRAND))
  @Post('brands/:id/verification/uploads/presign')
  async presignVerificationUpload(
    @Param('id') brandId: string,
    @Body(ValidationPipe) dto: PresignVerificationUploadDto,
    @Req() req: any,
  ) {
    if (req.user.id !== brandId) {
      throw new BadRequestException('Not authorized for this brand');
    }
    return this.brandVerificationService.presignUpload(brandId, dto);
  }

  @UseGuards(JwtAuthGuard, new UserTypeGuard(UserType.BRAND))
  @Post('brands/:id/verification/uploads/finalize')
  async finalizeVerificationUpload(
    @Param('id') brandId: string,
    @Body(ValidationPipe) dto: FinalizeVerificationUploadDto,
    @Req() req: any,
  ) {
    if (req.user.id !== brandId) {
      throw new BadRequestException('Not authorized for this brand');
    }
    return this.brandVerificationService.finalizeUpload(brandId, dto);
  }

  @UseGuards(JwtAuthGuard, new UserTypeGuard(UserType.BRAND))
  @Get('brands/:id/verification/draft')
  async getVerificationDraft(
    @Param('id') brandId: string,
    @Req() req: any,
  ) {
    if (req.user.id !== brandId) {
      throw new BadRequestException('Not authorized for this brand');
    }
    return this.brandVerificationService.getDraft(brandId);
  }

  @UseGuards(JwtAuthGuard, new UserTypeGuard(UserType.BRAND))
  @Patch('brands/:id/verification/draft')
  async saveVerificationDraft(
    @Param('id') brandId: string,
    @Body(ValidationPipe) dto: SaveVerificationDraftDto,
    @Req() req: any,
  ) {
    if (req.user.id !== brandId) {
      throw new BadRequestException('Not authorized for this brand');
    }
    return this.brandVerificationService.saveDraft(brandId, dto);
  }

  @UseGuards(JwtAuthGuard, new UserTypeGuard(UserType.BRAND))
  @Get('brands/:id/verification/letter')
  async getVerificationLetter(
    @Param('id') brandId: string,
    @Req() req: any,
  ) {
    if (req.user.id !== brandId) {
      throw new BadRequestException('Not authorized for this brand');
    }
    return this.brandVerificationService.getLetter(brandId);
  }

  @UseGuards(JwtAuthGuard, new UserTypeGuard(UserType.BRAND))
  @Post('brands/:id/verification/letter/sign')
  async signVerificationLetter(
    @Param('id') brandId: string,
    @Body(ValidationPipe) dto: SignVerificationLetterDto,
    @Req() req: any,
  ) {
    if (req.user.id !== brandId) {
      throw new BadRequestException('Not authorized for this brand');
    }
    return this.brandVerificationService.signLetter(brandId, dto, req);
  }

  @UseGuards(JwtAuthGuard, new UserTypeGuard(UserType.BRAND))
  @Post('brands/:id/verification')
  async submitVerification(
    @Param('id') brandId: string,
    @Body(ValidationPipe) dto: SubmitBrandVerificationDto,
    @Req() req: any,
  ) {
    if (req.user.id !== brandId) {
      throw new BadRequestException('Not authorized for this brand');
    }
    return this.brandVerificationService.submit(brandId, dto);
  }

  @UseGuards(JwtAuthGuard, new UserTypeGuard(UserType.BRAND))
  @Get('brands/:id/verification')
  async getVerificationStatus(
    @Param('id') brandId: string,
    @Req() req: any,
  ) {
    if (req.user.id !== brandId) {
      throw new BadRequestException('Not authorized for this brand');
    }
    return this.brandVerificationService.getStatus(brandId);
  }

  @UseGuards(JwtAuthGuard, new UserTypeGuard(UserType.BRAND))
  @Post('brands/:id/verification/cancel')
  async cancelVerification(
    @Param('id') brandId: string,
    @Body(ValidationPipe) dto: VerificationVersionDto,
    @Req() req: any,
  ) {
    if (req.user.id !== brandId) {
      throw new BadRequestException('Not authorized for this brand');
    }
    return this.brandVerificationService.cancel(brandId, dto.expectedUpdatedAt);
  }

  @UseGuards(JwtAuthGuard, new UserTypeGuard(UserType.BRAND))
  @Delete('brands/:id/verification')
  async cancelVerificationLegacy(
    @Param('id') brandId: string,
    @Req() req: any,
  ) {
    if (req.user.id !== brandId) {
      throw new BadRequestException('Not authorized for this brand');
    }
    return this.brandVerificationService.cancel(brandId);
  }

  @UseGuards(JwtAuthGuard, new UserTypeGuard(UserType.BRAND))
  @Post('brands/:id/verification/resubmit-info')
  async resubmitVerificationInfo(
    @Param('id') brandId: string,
    @Body(ValidationPipe) dto: ResubmitVerificationInfoDto,
    @Req() req: any,
  ) {
    if (req.user.id !== brandId) {
      throw new BadRequestException('Not authorized for this brand');
    }
    return this.brandVerificationService.resubmitInfo(brandId, dto);
  }

  @UseGuards(JwtAuthGuard, new UserTypeGuard(UserType.BRAND))
  @Patch('brands/:id/verification/nudge-optout')
  async updateVerificationNudgeOptOut(
    @Param('id') brandId: string,
    @Body(ValidationPipe) dto: VerificationNudgePreferenceDto,
    @Req() req: any,
  ) {
    if (req.user.id !== brandId) {
      throw new BadRequestException('Not authorized for this brand');
    }
    return this.brandVerificationService.setNudgeOptOut(
      brandId,
      dto.nudgeOptOut,
    );
  }
}
