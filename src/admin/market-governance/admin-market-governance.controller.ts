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
import { Role } from '@prisma/client';
import { Request } from 'express';
import { Roles } from 'src/auth/decorator/roles.decorator';
import { JwtAuthGuard } from 'src/auth/guard/jwt-auth.guard';
import { RolesGuard } from 'src/auth/guard/role.guard';
import { ADMIN_PERMISSIONS } from '../constants/permissions';
import { RequirePermissions } from '../decorators/require-permissions.decorator';
import { AdminPermissionGuard } from '../guards/admin-permission.guard';
import { AdminMarketGovernanceService } from './admin-market-governance.service';
import {
  AdminMarketGovernanceAuditQueryDto,
  CreateMarketRankingFormulaDto,
  CreateMarketRankingProfileDto,
  CreateMarketSuggestionBlockConfigDto,
  MarketGovernanceRollbackDto,
  PatchMarketRankingProfileDto,
  PatchMarketSectionConfigDto,
  PatchMarketSuggestionBlockConfigDto,
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
  constructor(private readonly service: AdminMarketGovernanceService) {}

  @Get('sections')
  @RequirePermissions(ADMIN_PERMISSIONS.MARKET_GOVERNANCE_READ)
  listSections() {
    return this.service.listSections();
  }

  @Patch('sections/:sectionKey')
  @RequirePermissions(ADMIN_PERMISSIONS.MARKET_GOVERNANCE_WRITE)
  patchSection(
    @Param('sectionKey') sectionKey: string,
    @Body() dto: PatchMarketSectionConfigDto,
    @Req() req: AdminRequest,
  ) {
    return this.service.patchSection(sectionKey, dto, this.getActorId(req), req);
  }

  @Get('ranking/profiles')
  @RequirePermissions(ADMIN_PERMISSIONS.MARKET_GOVERNANCE_READ)
  listRankingProfiles() {
    return this.service.listRankingProfiles();
  }

  @Post('ranking/profiles')
  @RequirePermissions(ADMIN_PERMISSIONS.MARKET_GOVERNANCE_WRITE)
  createRankingProfile(
    @Body() dto: CreateMarketRankingProfileDto,
    @Req() req: AdminRequest,
  ) {
    return this.service.createRankingProfile(dto, this.getActorId(req), req);
  }

  @Patch('ranking/profiles/:profileKey')
  @RequirePermissions(ADMIN_PERMISSIONS.MARKET_GOVERNANCE_WRITE)
  patchRankingProfile(
    @Param('profileKey') profileKey: string,
    @Body() dto: PatchMarketRankingProfileDto,
    @Req() req: AdminRequest,
  ) {
    return this.service.patchRankingProfile(
      profileKey,
      dto,
      this.getActorId(req),
      req,
    );
  }

  @Get('ranking/formulas')
  @RequirePermissions(ADMIN_PERMISSIONS.MARKET_GOVERNANCE_READ)
  listRankingFormulas() {
    return this.service.listRankingFormulas();
  }

  @Post('ranking/formulas')
  @RequirePermissions(ADMIN_PERMISSIONS.MARKET_RANKING_FORMULA_WRITE)
  createRankingFormula(
    @Body() dto: CreateMarketRankingFormulaDto,
    @Req() req: AdminRequest,
  ) {
    return this.service.createRankingFormula(dto, this.getActorId(req), req);
  }

  @Post('ranking/rollback')
  @RequirePermissions(ADMIN_PERMISSIONS.MARKET_RANKING_ROLLBACK)
  rollbackRanking(
    @Body() dto: MarketGovernanceRollbackDto,
    @Req() req: AdminRequest,
  ) {
    return this.service.rollbackRanking(dto, this.getActorId(req), req);
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

  @Post('rehearse-rollback')
  @RequirePermissions(ADMIN_PERMISSIONS.MARKET_GOVERNANCE_RELEASE)
  rehearseRollback() {
    return this.service.rehearseRollback();
  }

  private getActorId(req: AdminRequest) {
    const actorId = req.user?.sub ?? req.user?.id;
    if (!actorId) {
      throw new Error('Authenticated admin request is missing actor ID');
    }
    return actorId;
  }
}
