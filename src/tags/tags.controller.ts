import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { TagsService } from './tags.service';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from 'src/auth/guard/jwt-auth.guard';
import { OptionalJwtAuthGuard } from 'src/auth/guard/optional-jwt-auth.guard';
import { RolesGuard } from 'src/auth/guard/role.guard';
import { Roles } from 'src/auth/decorator/roles.decorator';
import { Role } from '@prisma/client';
import { AdminPermissionGuard } from 'src/admin/guards/admin-permission.guard';
import { RequirePermissions } from 'src/admin/decorators/require-permissions.decorator';
import { ADMIN_PERMISSIONS } from 'src/admin/constants/permissions';

@ApiTags('tags')
@Controller('tags')
export class TagsController {
  constructor(private readonly tags: TagsService) {}

  @UseGuards(OptionalJwtAuthGuard)
  @Get()
  @ApiOperation({
    summary: 'List popular tags',
  })
  async list(
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
    @Query('sort') sort?: string,
    @Query('state') state?: string,
    @Query('includeBanned') includeBanned?: string,
    @Req() req?: any,
  ) {
    const lim = limit ? parseInt(limit, 10) : 50;
    const viewerId = req?.user?.id ?? null;
    const isSuperAdmin = req?.user?.role === Role.SuperAdmin;

    const popular = await this.tags.getPopularTags(lim, {
      viewerId,
      isSuperAdmin,
    });
    return popular.map((p) => ({ name: p.tag, usageCount: p.count }));
  }

  @UseGuards(OptionalJwtAuthGuard)
  @Get('search')
  @ApiOperation({
    summary: 'Search tags by prefix',
  })
  async search(
    @Query('q') q = '',
    @Query('limit') limit?: string,
    @Query('sort') sort?: string,
    @Query('state') state?: string,
    @Query('includeBanned') includeBanned?: string,
    @Req() req?: any,
  ) {
    const lim = limit ? parseInt(limit, 10) : 10;
    const viewerId = req?.user?.id ?? null;
    const isSuperAdmin = req?.user?.role === Role.SuperAdmin;

    const rows = await this.tags.searchTags(q, lim, {
      viewerId,
      isSuperAdmin,
    });
    return {
      query: q,
      items: rows.map((p) => ({ name: p.tag, usageCount: p.count })),
    };
  }

  @UseGuards(OptionalJwtAuthGuard)
  @Get('trending')
  @ApiOperation({
    summary: 'List trending tags for a time window',
  })
  async trending(
    @Query('window') window = '24h',
    @Query('limit') limit?: string,
    @Req() req?: any,
  ) {
    const lim = limit ? parseInt(limit, 10) : 20;
    const viewerId = req?.user?.id ?? null;
    const isSuperAdmin = req?.user?.role === Role.SuperAdmin;
    const rows = await this.tags.getTrendingTags(window, lim, {
      viewerId,
      isSuperAdmin,
    });
    return {
      window,
      items: rows.map((p) => ({ name: p.tag, usageCount: p.count })),
    };
  }

  @Get('admin')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard, AdminPermissionGuard)
  @Roles(Role.SuperAdmin, Role.Admin)
  @RequirePermissions(ADMIN_PERMISSIONS.TAGS_READ)
  @ApiOperation({
    summary: 'List tag moderation queue rows',
  })
  async listAdmin(
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
    @Query('sort') sort?: string,
    @Query('state') state?: string,
    @Query('includeBanned') includeBanned?: string,
  ) {
    const lim = limit ? parseInt(limit, 10) : 50;
    const normalizedSort = String(sort ?? '').trim().toLowerCase();
    const isAdminSort = ['recent', 'popular', 'last-used', 'name-asc'].includes(normalizedSort);

    return this.tags.getAdminTagQueue({
      cursor,
      limit: lim,
      sort: isAdminSort ? (normalizedSort as any) : 'recent',
      state: state ? (String(state).trim().toLowerCase() as any) : undefined,
      includeBanned: ['1', 'true', 'yes', 'on'].includes((includeBanned || '').toLowerCase()),
    });
  }

  @Get('admin/search')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard, AdminPermissionGuard)
  @Roles(Role.SuperAdmin, Role.Admin)
  @RequirePermissions(ADMIN_PERMISSIONS.TAGS_READ)
  @ApiOperation({
    summary: 'Search tag moderation queue rows',
  })
  async searchAdmin(
    @Query('q') q = '',
    @Query('limit') limit?: string,
    @Query('sort') sort?: string,
    @Query('state') state?: string,
    @Query('includeBanned') includeBanned?: string,
  ) {
    const lim = limit ? parseInt(limit, 10) : 50;
    const normalizedSort = String(sort ?? '').trim().toLowerCase();
    const isAdminSort = ['recent', 'popular', 'last-used', 'name-asc'].includes(normalizedSort);

    const items = await this.tags.searchAdminTags(
      q,
      lim,
      ['1', 'true', 'yes', 'on'].includes((includeBanned || '').toLowerCase()),
      isAdminSort ? (normalizedSort as any) : 'popular',
      state ? (String(state).trim().toLowerCase() as any) : undefined,
    );

    return {
      query: q,
      items,
    };
  }

  @UseGuards(OptionalJwtAuthGuard)
  @Get(':normalizedName/lifecycle')
  @ApiOperation({
    summary: 'Get tag lifecycle details, usage actors, and timeline',
  })
  async lifecycle(
    @Param('normalizedName') normalizedName: string,
    @Req() req?: any,
  ) {
    return this.tags.getTagDetails(normalizedName, {
      viewerId: req?.user?.id ?? null,
      isSuperAdmin: req?.user?.role === Role.SuperAdmin,
    });
  }

  @UseGuards(OptionalJwtAuthGuard)
  @Get(':normalizedName')
  @ApiOperation({
    summary: 'Get tag details',
  })
  async details(
    @Param('normalizedName') normalizedName: string,
    @Req() req?: any,
  ) {
    return this.tags.getTagDetails(normalizedName, {
      viewerId: req?.user?.id ?? null,
      isSuperAdmin: req?.user?.role === Role.SuperAdmin,
    });
  }

  @UseGuards(OptionalJwtAuthGuard)
  @Get(':normalizedName/posts')
  @ApiOperation({
    summary: 'Get cursor-paginated feed for a tag',
  })
  async feed(
    @Param('normalizedName') normalizedName: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
    @Req() req?: any,
  ) {
    const lim = limit ? parseInt(limit, 10) : 20;
    return this.tags.getTagFeed(normalizedName, cursor, lim, {
      viewerId: req?.user?.id ?? null,
      isSuperAdmin: req?.user?.role === Role.SuperAdmin,
    });
  }

  @Patch('admin/status/:normalizedName')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard, AdminPermissionGuard)
  @Roles(Role.SuperAdmin, Role.Admin)
  @RequirePermissions(ADMIN_PERMISSIONS.TAGS_MODERATE)
  @ApiOperation({
    summary: 'Set moderation status for a tag',
  })
  async setStatus(
    @Param('normalizedName') normalizedName: string,
    @Body() body: { status?: 'PENDING' | 'APPROVED' | 'REJECTED' },
    @Req() req?: any,
  ) {
    const nextStatus = body?.status ?? 'APPROVED';
    return this.tags.setTagStatus(normalizedName, nextStatus, req?.user?.id ?? req?.user?.sub);
  }

  @Post('admin/ban/:normalizedName')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard, AdminPermissionGuard)
  @Roles(Role.SuperAdmin, Role.Admin)
  @RequirePermissions(ADMIN_PERMISSIONS.TAGS_MODERATE)
  @ApiOperation({
    summary: 'Ban or unban a tag',
  })
  async ban(
    @Param('normalizedName') normalizedName: string,
    @Query('banned') banned?: string,
    @Req() req?: any,
  ) {
    const shouldBan =
      banned === undefined ? true : ['1', 'true', 'yes', 'on'].includes(banned.toLowerCase());
    const status = shouldBan ? 'REJECTED' : 'APPROVED';
    const updated = await this.tags.setTagStatus(
      normalizedName,
      status,
      req?.user?.id ?? req?.user?.sub,
    );
    return { success: true, normalizedName, banned: shouldBan, status: updated.status };
  }

  @Post('admin/merge')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard, AdminPermissionGuard)
  @Roles(Role.SuperAdmin, Role.Admin)
  @RequirePermissions(ADMIN_PERMISSIONS.TAGS_MODERATE)
  @ApiOperation({
    summary: 'Merge source tag into target tag',
  })
  async merge(
    @Body() body: { sourceTag: string; targetTag: string },
    @Req() req?: any,
  ) {
    await this.tags.mergeTags(body?.sourceTag, body?.targetTag, req?.user?.id ?? req?.user?.sub);
    return { success: true };
  }

  @Post('admin/reindex')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard, AdminPermissionGuard)
  @Roles(Role.SuperAdmin, Role.Admin)
  @RequirePermissions(ADMIN_PERMISSIONS.TAGS_MODERATE)
  @ApiOperation({
    summary: 'Rebuild unified tag index from existing entities',
  })
  async reindex() {
    return this.tags.reindexAllTags();
  }

  @Patch('admin/meta/:normalizedName')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard, AdminPermissionGuard)
  @Roles(Role.SuperAdmin, Role.Admin)
  @RequirePermissions(ADMIN_PERMISSIONS.TAGS_MODERATE)
  @ApiOperation({
    summary: 'Update tag metadata (display name)',
  })
  async updateMetadata(
    @Param('normalizedName') normalizedName: string,
    @Body() body: { displayName?: string },
    @Req() req?: any,
  ) {
    return this.tags.updateTagMetadata(normalizedName, {
      displayName: body?.displayName,
    }, req?.user?.id ?? req?.user?.sub);
  }
}
