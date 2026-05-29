import {
  Controller,
  Get,
  Post,
  Patch,
  Param,
  Body,
  Query,
  Req,
  UseGuards,
  ValidationPipe,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { JwtAuthGuard } from 'src/auth/guard/jwt-auth.guard';
import { RolesGuard } from 'src/auth/guard/role.guard';
import { Roles } from 'src/auth/decorator/roles.decorator';
import { BrandVerificationService } from 'src/brand-verification/brand-verification.service';
import {
  RequestVerificationInfoDto,
  ReviewBrandVerificationDto,
  VerificationVersionDto,
  VerificationNoteDto,
} from 'src/brand-verification/dto/verification.dto';
import { AdminPermissionGuard } from '../guards/admin-permission.guard';
import { RequirePermissions } from '../decorators/require-permissions.decorator';
import { ADMIN_PERMISSIONS } from '../constants/permissions';
import { AdminBrandsService } from './admin-brands.service';
import { Request } from 'express';
import { resolveSearchQuery } from 'src/common/utils/search-query';

@ApiTags('admin/brands')
@ApiBearerAuth()
@Controller('admin/brands')
@UseGuards(JwtAuthGuard, RolesGuard, AdminPermissionGuard)
@Roles(Role.SuperAdmin, Role.Admin)
export class AdminBrandsController {
  constructor(
    private readonly adminBrandsService: AdminBrandsService,
    private readonly brandVerificationService: BrandVerificationService,
  ) {}

  @Get()
  @RequirePermissions(ADMIN_PERMISSIONS.BRANDS_READ)
  @ApiOperation({ summary: 'List brands (paginated)' })
  async list(
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
    @Query('q') q?: string,
    @Query('search') search?: string,
    @Query('isStoreOpen') isStoreOpen?: string,
  ) {
    return this.adminBrandsService.list({
      cursor,
      limit: limit ? parseInt(limit, 10) : undefined,
      search: resolveSearchQuery(q, search),
      isStoreOpen:
        isStoreOpen !== undefined ? isStoreOpen === 'true' : undefined,
    });
  }

  @Get('verification-queue')
  @RequirePermissions(ADMIN_PERMISSIONS.BRANDS_VERIFY)
  @ApiOperation({ summary: 'List brands pending verification' })
  async getVerificationQueue(
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
    @Query('q') q?: string,
    @Query('search') search?: string,
    @Query('status') status?: string,
  ) {
    return this.brandVerificationService.getQueue({
      cursor,
      limit: limit ? parseInt(limit, 10) : undefined,
      search: resolveSearchQuery(q, search),
      status,
    });
  }

  @Get('verification-rejection-reasons')
  @RequirePermissions(ADMIN_PERMISSIONS.BRANDS_VERIFY)
  @ApiOperation({ summary: 'List rejection reasons for brand verification' })
  async getVerificationRejectionReasons() {
    return this.brandVerificationService.getRejectionReasons();
  }

  @Get(':id')
  @RequirePermissions(ADMIN_PERMISSIONS.BRANDS_READ)
  @ApiOperation({ summary: 'Get brand by ID' })
  async getById(@Param('id') id: string) {
    return this.adminBrandsService.getById(id);
  }

  @Patch(':id/open-close')
  @RequirePermissions(ADMIN_PERMISSIONS.BRANDS_STORE_OVERRIDE)
  @ApiOperation({ summary: 'Override brand store open/close status' })
  async overrideStoreOpen(
    @Param('id') id: string,
    @Body('isStoreOpen') isStoreOpen: boolean,
    @Req() req: Request & { user: { id: string } },
  ) {
    return this.adminBrandsService.overrideStoreOpen(
      id,
      isStoreOpen,
      req.user.id,
      req,
    );
  }

  @Patch(':id/suspend')
  @RequirePermissions(ADMIN_PERMISSIONS.BRANDS_SUSPEND)
  @ApiOperation({ summary: 'Suspend a brand' })
  async suspend(
    @Param('id') id: string,
    @Body('reason') reason?: string,
    @Req() req?: Request & { user: { id: string } },
  ) {
    return this.adminBrandsService.suspendBrand(id, reason, req!.user.id, req!);
  }

  @Get(':id/verification')
  @RequirePermissions(ADMIN_PERMISSIONS.BRANDS_VERIFY)
  @ApiOperation({ summary: 'Get brand verification details' })
  async getVerificationDetails(@Param('id') id: string) {
    return this.brandVerificationService.getDetails(id);
  }

  @Patch(':id/verification/claim')
  @RequirePermissions(ADMIN_PERMISSIONS.BRANDS_VERIFY)
  @ApiOperation({ summary: 'Claim a verification review' })
  async claimVerification(
    @Param('id') id: string,
    @Body(new ValidationPipe({ whitelist: true, transform: true }))
    dto: VerificationVersionDto,
    @Req() req: Request & { user: { id: string } },
  ) {
    return this.brandVerificationService.claim(
      id,
      req.user.id,
      req,
      dto.expectedUpdatedAt,
    );
  }

  @Patch(':id/verification/release')
  @RequirePermissions(ADMIN_PERMISSIONS.BRANDS_VERIFY)
  @ApiOperation({ summary: 'Release a claimed verification review' })
  async releaseVerification(
    @Param('id') id: string,
    @Body(new ValidationPipe({ whitelist: true, transform: true }))
    dto: VerificationVersionDto,
    @Req() req: Request & { user: { id: string } },
  ) {
    return this.brandVerificationService.release(
      id,
      req.user.id,
      req,
      dto.expectedUpdatedAt,
    );
  }

  @Patch(':id/verification/reassign-to-self')
  @RequirePermissions(ADMIN_PERMISSIONS.BRANDS_VERIFY)
  @ApiOperation({
    summary: 'Reassign an active verification review to yourself',
  })
  async reassignVerificationToSelf(
    @Param('id') id: string,
    @Body(new ValidationPipe({ whitelist: true, transform: true }))
    dto: VerificationVersionDto,
    @Req() req: Request & { user: { id: string } },
  ) {
    return this.brandVerificationService.reassignToSelf(
      id,
      req.user.id,
      req,
      dto.expectedUpdatedAt,
    );
  }

  @Patch(':id/verification/request-info')
  @RequirePermissions(ADMIN_PERMISSIONS.BRANDS_VERIFY)
  @ApiOperation({
    summary: 'Request more verification information from a brand',
  })
  async requestVerificationInfo(
    @Param('id') id: string,
    @Body(new ValidationPipe({ whitelist: true }))
    dto: RequestVerificationInfoDto,
    @Req() req: Request & { user: { id: string } },
  ) {
    return this.brandVerificationService.requestInfo(id, req.user.id, dto, req);
  }

  @Patch(':id/verification')
  @RequirePermissions(ADMIN_PERMISSIONS.BRANDS_VERIFY)
  @ApiOperation({ summary: 'Approve or reject brand verification' })
  async reviewVerification(
    @Param('id') id: string,
    @Body(new ValidationPipe({ whitelist: true }))
    dto: ReviewBrandVerificationDto,
    @Req() req: Request & { user: { id: string } },
  ) {
    return this.brandVerificationService.review(id, req.user.id, dto, req);
  }

  @Get(':id/verification/notes')
  @RequirePermissions(ADMIN_PERMISSIONS.BRANDS_VERIFY)
  @ApiOperation({ summary: 'Get verification review notes' })
  async getVerificationNotes(@Param('id') id: string) {
    return this.brandVerificationService.getNotes(id);
  }

  @Post(':id/verification/notes')
  @RequirePermissions(ADMIN_PERMISSIONS.BRANDS_VERIFY)
  @ApiOperation({ summary: 'Add a verification review note' })
  async addVerificationNote(
    @Param('id') id: string,
    @Body(new ValidationPipe({ whitelist: true })) dto: VerificationNoteDto,
    @Req() req: Request & { user: { id: string } },
  ) {
    return this.brandVerificationService.addNote(id, req.user.id, dto, req);
  }
}
