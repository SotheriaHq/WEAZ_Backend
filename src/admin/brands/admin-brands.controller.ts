import {
  Controller,
  Get,
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
import { AdminPermissionGuard } from '../guards/admin-permission.guard';
import { RequirePermissions } from '../decorators/require-permissions.decorator';
import { ADMIN_PERMISSIONS } from '../constants/permissions';
import { AdminBrandsService } from './admin-brands.service';
import { ReviewVerificationDto } from './dto/brand-verification.dto';
import { Request } from 'express';

@ApiTags('admin/brands')
@ApiBearerAuth()
@Controller('admin/brands')
@UseGuards(JwtAuthGuard, RolesGuard, AdminPermissionGuard)
@Roles(Role.SuperAdmin, Role.Admin)
export class AdminBrandsController {
  constructor(private readonly adminBrandsService: AdminBrandsService) {}

  @Get()
  @RequirePermissions(ADMIN_PERMISSIONS.BRANDS_READ)
  @ApiOperation({ summary: 'List brands (paginated)' })
  async list(
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
    @Query('search') search?: string,
    @Query('isStoreOpen') isStoreOpen?: string,
  ) {
    return this.adminBrandsService.list({
      cursor,
      limit: limit ? parseInt(limit, 10) : undefined,
      search,
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
  ) {
    return this.adminBrandsService.getVerificationQueue({
      cursor,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
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
    return this.adminBrandsService.suspendBrand(
      id,
      reason,
      req!.user.id,
      req!,
    );
  }

  @Get(':id/verification')
  @RequirePermissions(ADMIN_PERMISSIONS.BRANDS_VERIFY)
  @ApiOperation({ summary: 'Get brand verification details' })
  async getVerificationDetails(@Param('id') id: string) {
    return this.adminBrandsService.getVerificationDetails(id);
  }

  @Patch(':id/verification')
  @RequirePermissions(ADMIN_PERMISSIONS.BRANDS_VERIFY)
  @ApiOperation({ summary: 'Approve or reject brand verification' })
  async reviewVerification(
    @Param('id') id: string,
    @Body(new ValidationPipe({ whitelist: true })) dto: ReviewVerificationDto,
    @Req() req: Request & { user: { id: string } },
  ) {
    return this.adminBrandsService.reviewVerification(
      id,
      dto,
      req.user.id,
      req,
    );
  }
}
