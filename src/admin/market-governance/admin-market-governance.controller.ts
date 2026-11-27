import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Role } from '@prisma/client';
import { Request } from 'express';
import { Roles } from 'src/auth/decorator/roles.decorator';
import { JwtAuthGuard } from 'src/auth/guard/jwt-auth.guard';
import { RolesGuard } from 'src/auth/guard/role.guard';
import { ADMIN_PERMISSIONS } from '../constants/permissions';
import { RequirePermissions } from '../decorators/require-permissions.decorator';
import { AdminPermissionGuard } from '../guards/admin-permission.guard';
import { AdminMarketGovernanceService } from './admin-market-governance.service';
import { AdminMarketSectionLifecycleService } from './admin-market-section-lifecycle.service';
import {
  AdminMarketGovernanceAuditQueryDto,
  CreateMarketSectionConfigDto,
  CreateMarketSuggestionBlockConfigDto,
  MarketSectionReasonDto,
  PatchMarketSectionConfigDto,
  PatchMarketSuggestionBlockConfigDto,
  PublishMarketSectionDto,
  SaveMarketSectionDraftDto,
} from './dto/admin-market-governance.dto';

type AdminRequest = Request & {
  user?: {
    id?: string;
    sub?: string;
    role?: Role;
    permissions?: string[];
  };
};

@Controller('admin/market-governance')
@UseGuards(JwtAuthGuard, RolesGuard, AdminPermissionGuard)
@Roles(Role.SuperAdmin, Role.Admin)
export class AdminMarketGovernanceController {
  constructor(
    private readonly service: AdminMarketGovernanceService,
    private readonly lifecycle: AdminMarketSectionLifecycleService,
  ) {}

  @Get('sections')
  @RequirePermissions(ADMIN_PERMISSIONS.MARKET_GOVERNANCE_READ)
  listSections() {
    return this.service.listSections();
  }

  @Post('sections')
  @RequirePermissions(ADMIN_PERMISSIONS.MARKET_GOVERNANCE_WRITE)
  createSection(
    @Body() dto: CreateMarketSectionConfigDto,
    @Req() req: AdminRequest,
  ) {
    return this.service.createSection(dto, this.getActorId(req), req);
  }

  @Patch('sections/:sectionKey')
  @RequirePermissions(ADMIN_PERMISSIONS.MARKET_GOVERNANCE_WRITE)
  patchSection(
    @Param('sectionKey') sectionKey: string,
    @Body() dto: PatchMarketSectionConfigDto,
    @Req() req: AdminRequest,
  ) {
    return this.service.patchSection(
      sectionKey,
      dto,
      this.getActorId(req),
      req,
    );
  }

  @Get('section-templates')
  @RequirePermissions(ADMIN_PERMISSIONS.MARKET_GOVERNANCE_READ)
  listSectionTemplates() {
    return this.lifecycle.listTemplates();
  }

  @Get('sections/:sectionKey/lifecycle')
  @RequirePermissions(ADMIN_PERMISSIONS.MARKET_GOVERNANCE_READ)
  getSectionLifecycle(@Param('sectionKey') sectionKey: string) {
    return this.lifecycle.getLifecycle(sectionKey);
  }

  @Put('sections/:sectionKey/draft')
  @RequirePermissions(ADMIN_PERMISSIONS.MARKET_GOVERNANCE_WRITE)
  saveSectionDraft(
    @Param('sectionKey') sectionKey: string,
    @Body() dto: SaveMarketSectionDraftDto,
    @Req() req: AdminRequest,
  ) {
    return this.lifecycle.saveDraft(sectionKey, dto, this.getActorId(req), req);
  }

  @Post('sections/:sectionKey/preview')
  @RequirePermissions(ADMIN_PERMISSIONS.MARKET_GOVERNANCE_READ)
  previewSectionDraft(@Param('sectionKey') sectionKey: string) {
    return this.lifecycle.preview(sectionKey);
  }

  @Post('sections/:sectionKey/publish')
  @RequirePermissions(ADMIN_PERMISSIONS.MARKET_GOVERNANCE_WRITE)
  publishSection(
    @Param('sectionKey') sectionKey: string,
    @Body() dto: PublishMarketSectionDto,
    @Req() req: AdminRequest,
  ) {
    return this.lifecycle.publish(sectionKey, dto, this.getActorId(req), req);
  }

  @Post('sections/:sectionKey/pause')
  @RequirePermissions(ADMIN_PERMISSIONS.MARKET_GOVERNANCE_WRITE)
  pauseSection(
    @Param('sectionKey') sectionKey: string,
    @Body() dto: MarketSectionReasonDto,
    @Req() req: AdminRequest,
  ) {
    return this.lifecycle.changeStatus(
      sectionKey,
      'pause',
      dto,
      this.getActorId(req),
      req,
    );
  }

  @Post('sections/:sectionKey/resume')
  @RequirePermissions(ADMIN_PERMISSIONS.MARKET_GOVERNANCE_WRITE)
  resumeSection(
    @Param('sectionKey') sectionKey: string,
    @Body() dto: MarketSectionReasonDto,
    @Req() req: AdminRequest,
  ) {
    return this.lifecycle.changeStatus(
      sectionKey,
      'resume',
      dto,
      this.getActorId(req),
      req,
    );
  }

  @Post('sections/:sectionKey/archive')
  @RequirePermissions(ADMIN_PERMISSIONS.MARKET_GOVERNANCE_WRITE)
  archiveSection(
    @Param('sectionKey') sectionKey: string,
    @Body() dto: MarketSectionReasonDto,
    @Req() req: AdminRequest,
  ) {
    return this.lifecycle.changeStatus(
      sectionKey,
      'archive',
      dto,
      this.getActorId(req),
      req,
    );
  }

  @Get('sections/:sectionKey/versions')
  @RequirePermissions(ADMIN_PERMISSIONS.MARKET_GOVERNANCE_READ)
  listSectionVersions(@Param('sectionKey') sectionKey: string) {
    return this.lifecycle.listVersions(sectionKey);
  }

  @Post('sections/:sectionKey/restore/:version')
  @RequirePermissions(ADMIN_PERMISSIONS.MARKET_GOVERNANCE_WRITE)
  restoreSectionVersion(
    @Param('sectionKey') sectionKey: string,
    @Param('version', ParseIntPipe) version: number,
    @Body() dto: MarketSectionReasonDto,
    @Req() req: AdminRequest,
  ) {
    return this.lifecycle.restore(
      sectionKey,
      version,
      dto,
      this.getActorId(req),
      req,
    );
  }

  @Get('suggestions/blocks')
  @RequirePermissions(ADMIN_PERMISSIONS.MARKET_GOVERNANCE_READ)
  listSuggestionBlocks() {
    return this.service.listSuggestionBlocks();
  }

  @Post('suggestions/blocks')
  @RequirePermissions(ADMIN_PERMISSIONS.MARKET_SUGGESTIONS_WRITE)
  createSuggestionBlock(
    @Body() dto: CreateMarketSuggestionBlockConfigDto,
    @Req() req: AdminRequest,
  ) {
    return this.service.createSuggestionBlock(dto, this.getActorId(req), req);
  }

  @Patch('suggestions/blocks/:blockKey')
  @RequirePermissions(ADMIN_PERMISSIONS.MARKET_SUGGESTIONS_WRITE)
  patchSuggestionBlock(
    @Param('blockKey') blockKey: string,
    @Body() dto: PatchMarketSuggestionBlockConfigDto,
    @Req() req: AdminRequest,
  ) {
    return this.service.patchSuggestionBlock(
      blockKey,
      dto,
      this.getActorId(req),
      req,
    );
  }

  @Get('audit-logs')
  @RequirePermissions(ADMIN_PERMISSIONS.MARKET_GOVERNANCE_READ)
  listAuditLogs(@Query() query: AdminMarketGovernanceAuditQueryDto) {
    return this.service.listAuditLogs(query);
  }

  @Get('release-status')
  @RequirePermissions(ADMIN_PERMISSIONS.MARKET_GOVERNANCE_READ)
  getReleaseStatus() {
    return this.service.getReleaseStatus();
  }

  private getActorId(req: AdminRequest) {
    const actorId = req.user?.sub ?? req.user?.id;
    if (!actorId) {
      throw new Error('Authenticated admin request is missing actor ID');
    }
    return actorId;
  }
}
