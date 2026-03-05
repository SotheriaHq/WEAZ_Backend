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
import { Role, UserStatus } from '@prisma/client';
import { JwtAuthGuard } from 'src/auth/guard/jwt-auth.guard';
import { RolesGuard } from 'src/auth/guard/role.guard';
import { Roles } from 'src/auth/decorator/roles.decorator';
import { AdminPermissionGuard } from '../guards/admin-permission.guard';
import { RequirePermissions } from '../decorators/require-permissions.decorator';
import { ADMIN_PERMISSIONS } from '../constants/permissions';
import { AdminUsersService } from './admin-users.service';
import { Request } from 'express';

@ApiTags('admin/users')
@ApiBearerAuth()
@Controller('admin/users')
@UseGuards(JwtAuthGuard, RolesGuard, AdminPermissionGuard)
export class AdminUsersController {
  constructor(private readonly adminUsersService: AdminUsersService) {}

  @Post()
  @Roles(Role.SuperAdmin)
  @ApiOperation({ summary: 'Create admin account (SuperAdmin only)' })
  async createAdmin(
    @Body(ValidationPipe)
    dto: {
      email: string;
      firstName: string;
      lastName: string;
      role?: Role;
    },
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
    @Query('search') search?: string,
  ) {
    return this.adminUsersService.list({
      cursor,
      limit: limit ? parseInt(limit, 10) : undefined,
      role,
      status,
      search,
    });
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
  @ApiOperation({ summary: 'Update user role (SuperAdmin only)' })
  async updateRole(
    @Param('id') id: string,
    @Body('role') role: Role,
    @Req() req: Request & { user: { id: string } },
  ) {
    return this.adminUsersService.updateRole(id, role, req.user.id, req);
  }

  @Patch(':id/permissions')
  @Roles(Role.SuperAdmin)
  @RequirePermissions(ADMIN_PERMISSIONS.PERMISSIONS_MANAGE)
  @ApiOperation({ summary: 'Update admin permissions (SuperAdmin only)' })
  async updatePermissions(
    @Param('id') id: string,
    @Body('permissions') permissions: string[],
    @Req() req: Request & { user: { id: string } },
  ) {
    return this.adminUsersService.updatePermissions(
      id,
      permissions as any,
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
    @Body() body: { status: UserStatus; reason?: string },
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
  @ApiOperation({ summary: 'Force password reset (SuperAdmin only)' })
  async forcePasswordReset(
    @Param('id') id: string,
    @Req() req: Request & { user: { id: string } },
  ) {
    return this.adminUsersService.forcePasswordReset(id, req.user.id, req);
  }
}
