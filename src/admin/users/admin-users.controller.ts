import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  Query,
  Req,
  Headers,
  UseGuards,
  ForbiddenException,
  ValidationPipe,
} from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { Role, UserStatus } from '@prisma/client';
import { JwtAuthGuard } from 'src/auth/guard/jwt-auth.guard';
import { RolesGuard } from 'src/auth/guard/role.guard';
import { Roles } from 'src/auth/decorator/roles.decorator';
import { AdminPermissionGuard } from '../guards/admin-permission.guard';
import { RequirePermissions } from '../decorators/require-permissions.decorator';
import { ADMIN_PERMISSIONS } from '../constants/permissions';
import { AdminUsersService } from './admin-users.service';
import { Request } from 'express';
import { UpdatePermissionsDto } from './dto/update-permissions.dto';
import { CreateAdminDto } from './dto/create-admin.dto';
import { UpdateRoleDto } from './dto/update-role.dto';
import { UpdateUserStatusDto } from './dto/update-user-status.dto';
import { ReviewReactivationRequestDto } from './dto/review-reactivation-request.dto';
import { ReissueTempPasswordDto } from './dto/reissue-temp-password.dto';
import { resolveSearchQuery } from 'src/common/utils/search-query';

const SKIP_ALL_THROTTLERS = {
  default: true,
  short: true,
  medium: true,
  long: true,
} as const;

@ApiTags('admin/users')
@ApiBearerAuth()
@Controller('admin/users')
@UseGuards(JwtAuthGuard, RolesGuard, AdminPermissionGuard)
export class AdminUsersController {
  constructor(private readonly adminUsersService: AdminUsersService) {}

  @Post()
  @Roles(Role.SuperAdmin)
  @RequirePermissions(ADMIN_PERMISSIONS.USERS_ROLE_ASSIGN_ADMIN)
  @ApiOperation({ summary: 'Create admin account (SuperAdmin only)' })
  async createAdmin(
    @Body(ValidationPipe) dto: CreateAdminDto,
    @Req() req: Request & { user: { id: string } },
  ) {
    return this.adminUsersService.createAdmin(dto, req.user.id, req);
  }

  @Get()
  @Roles(Role.SuperAdmin, Role.Admin)
  @RequirePermissions(ADMIN_PERMISSIONS.USERS_READ)
  @ApiOperation({ summary: 'List users (paginated)' })
  async list(
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
    @Query('role') role?: Role,
    @Query('status') status?: UserStatus,
    @Query('q') q?: string,
    @Query('search') search?: string,
    @Query('sort') sort?: 'created_asc' | 'created_desc',
  ) {
    return this.adminUsersService.list({
      cursor,
      limit: limit ? parseInt(limit, 10) : undefined,
      role,
      status,
      search: resolveSearchQuery(q, search),
      sort,
    });
  }

  @Get('reactivation-requests')
  @SkipThrottle(SKIP_ALL_THROTTLERS)
  @Roles(Role.SuperAdmin, Role.Admin)
  @RequirePermissions(ADMIN_PERMISSIONS.USERS_READ)
  @ApiOperation({
    summary: 'List suspended/deactivated account reactivation requests',
  })
  async listReactivationRequests(
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
    @Query('status') status?: 'PENDING' | 'APPROVED' | 'REJECTED',
    @Query('email') email?: string,
  ) {
    return this.adminUsersService.listReactivationRequests({
      cursor,
      limit: limit ? parseInt(limit, 10) : undefined,
      status,
      email,
    });
  }

  @Patch('reactivation-requests/:requestId')
  @SkipThrottle(SKIP_ALL_THROTTLERS)
  @Roles(Role.SuperAdmin, Role.Admin)
  @RequirePermissions(ADMIN_PERMISSIONS.USERS_DEACTIVATE)
  @ApiOperation({ summary: 'Approve or reject a reactivation request' })
  async reviewReactivationRequest(
    @Param('requestId') requestId: string,
    @Body(ValidationPipe) body: ReviewReactivationRequestDto,
    @Req() req: Request & { user: { id: string; role: Role } },
  ) {
    return this.adminUsersService.reviewReactivationRequest(
      requestId,
      body,
      req.user.id,
      req.user.role,
      req,
    );
  }

  @Get(':id')
  @Roles(Role.SuperAdmin, Role.Admin)
  @RequirePermissions(ADMIN_PERMISSIONS.USERS_READ)
  @ApiOperation({ summary: 'Get user by ID' })
  async getById(@Param('id') id: string) {
    return this.adminUsersService.getById(id);
  }

  @Patch(':id/role')
  @Roles(Role.SuperAdmin)
  @RequirePermissions(
    ADMIN_PERMISSIONS.USERS_ROLE_ASSIGN_ADMIN,
    ADMIN_PERMISSIONS.USERS_ROLE_ASSIGN_USER,
  )
  @ApiOperation({ summary: 'Update user role (SuperAdmin only)' })
  async updateRole(
    @Param('id') id: string,
    @Body(ValidationPipe) body: UpdateRoleDto,
    @Req() req: Request & { user: { id: string } },
  ) {
    return this.adminUsersService.updateRole(id, body.role, req.user.id, req);
  }

  @Patch(':id/permissions')
  @Roles(Role.SuperAdmin)
  @RequirePermissions(ADMIN_PERMISSIONS.PERMISSIONS_MANAGE)
  @ApiOperation({ summary: 'Update admin permissions (SuperAdmin only)' })
  async updatePermissions(
    @Param('id') id: string,
    @Body(ValidationPipe) body: UpdatePermissionsDto,
    @Req() req: Request & { user: { id: string } },
  ) {
    return this.adminUsersService.updatePermissions(
      id,
      body.permissions,
      req.user.id,
      req,
    );
  }

  @Patch(':id/status')
  @Roles(Role.SuperAdmin, Role.Admin)
  @RequirePermissions(ADMIN_PERMISSIONS.USERS_DEACTIVATE)
  @ApiOperation({ summary: 'Update user status (activate/suspend/deactivate)' })
  async updateStatus(
    @Param('id') id: string,
    @Body(ValidationPipe) body: UpdateUserStatusDto,
    @Req() req: Request & { user: { id: string; role: Role } },
  ) {
    return this.adminUsersService.updateStatus(
      id,
      body.status,
      body.reason,
      req.user.id,
      req.user.role,
      req,
    );
  }

  @Post(':id/force-password-reset')
  @Roles(Role.SuperAdmin)
  @RequirePermissions(ADMIN_PERMISSIONS.USERS_UPDATE)
  @ApiOperation({ summary: 'Force password reset (SuperAdmin only)' })
  async forcePasswordReset(
    @Param('id') id: string,
    @Req() req: Request & { user: { id: string } },
  ) {
    return this.adminUsersService.forcePasswordReset(id, req.user.id, req);
  }

  @Post(':id/reissue-temp-password')
  @Roles(Role.SuperAdmin)
  @RequirePermissions(ADMIN_PERMISSIONS.USERS_UPDATE)
  @ApiOperation({
    summary: 'Reissue temporary password for admin (SuperAdmin only)',
  })
  async reissueTempPassword(
    @Param('id') id: string,
    @Body(ValidationPipe) body: ReissueTempPasswordDto,
    @Req() req: Request & { user: { id: string; email: string } },
  ) {
    return this.adminUsersService.reissueTempPasswordForAdmin(
      id,
      body,
      req.user.id,
      req.user.email,
      req,
    );
  }

  @Get(':id/data-export')
  @Roles(Role.SuperAdmin, Role.Admin)
  @RequirePermissions(ADMIN_PERMISSIONS.USERS_DATA_EXPORT)
  @ApiOperation({ summary: 'Export user data (GDPR)' })
  async dataExport(
    @Param('id') id: string,
    @Req() req: Request & { user: { id: string } },
  ) {
    return this.adminUsersService.dataExport(id, req.user.id, req);
  }

  @Delete(':id/data-wipe')
  @Roles(Role.SuperAdmin)
  @RequirePermissions(ADMIN_PERMISSIONS.USERS_DATA_WIPE)
  @ApiOperation({
    summary: 'Permanently erase user data (GDPR, SuperAdmin only)',
  })
  async dataWipe(
    @Param('id') id: string,
    @Headers('x-confirm-wipe') confirmHeader: string,
    @Req() req: Request & { user: { id: string } },
  ) {
    if (confirmHeader !== 'true') {
      throw new ForbiddenException(
        'Data wipe requires X-Confirm-Wipe: true header',
      );
    }
    return this.adminUsersService.dataWipe(id, req.user.id, req);
  }

  @Delete(':id/hard-delete')
  @Roles(Role.SuperAdmin)
  @RequirePermissions(ADMIN_PERMISSIONS.USERS_DATA_WIPE)
  @ApiOperation({ summary: 'Hard-delete seeded user (SuperAdmin only)' })
  async hardDeleteSeededUser(
    @Param('id') id: string,
    @Req() req: Request & { user: { id: string } },
  ) {
    return this.adminUsersService.hardDeleteSeededUser(id, req.user.id, req);
  }

  @Delete(':id/permanent-delete')
  @Roles(Role.SuperAdmin)
  @RequirePermissions(ADMIN_PERMISSIONS.USERS_DATA_WIPE)
  @ApiOperation({
    summary: 'Permanently delete a deactivated admin user (SuperAdmin only)',
  })
  async permanentlyDeleteAdminUser(
    @Param('id') id: string,
    @Req() req: Request & { user: { id: string } },
  ) {
    return this.adminUsersService.permanentlyDeleteDeactivatedAdminUser(
      id,
      req.user.id,
      req,
    );
  }
}
