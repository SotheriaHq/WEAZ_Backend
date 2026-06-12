import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AdminAuditAction, Prisma } from '@prisma/client';
import { Request } from 'express';
import { PrismaService } from 'src/prisma/prisma.service';
import { AdminAuditService } from '../services/admin-audit.service';
import { MarketRankingConfigService } from 'src/market/market-ranking-config.service';
import {
  ALLOWED_FORMULA_WEIGHT_KEYS,
  MarketGovernanceConfigService,
  MARKET_SECTION_CODE_DEFAULTS,
  SUPPORTED_FORMULA_STATUSES,
  SUPPORTED_MARKET_SECTION_KEYS,
  SUPPORTED_SUGGESTION_CONTEXTS,
  SUPPORTED_SUGGESTION_SOURCE_TYPES,
  SUPPORTED_SUGGESTION_TARGET_TYPES,
  SupportedMarketSectionKey,
} from 'src/market/market-governance-config.service';
import {
  AdminMarketGovernanceAuditQueryDto,
  CreateMarketSectionConfigDto,
  CreateMarketRankingFormulaDto,
  CreateMarketRankingProfileDto,
  CreateMarketSuggestionBlockConfigDto,
  MarketGovernanceRollbackDto,
  PatchMarketRankingProfileDto,
  PatchMarketSectionConfigDto,
  PatchMarketSuggestionBlockConfigDto,
} from './dto/admin-market-governance.dto';

const MARKET_GOVERNANCE_AUDIT_ACTIONS = [
  AdminAuditAction.ADMIN_MARKET_SECTION_CONFIG_UPDATE,
  AdminAuditAction.ADMIN_MARKET_RANKING_PROFILE_CREATE,
  AdminAuditAction.ADMIN_MARKET_RANKING_PROFILE_UPDATE,
  AdminAuditAction.ADMIN_MARKET_RANKING_FORMULA_CREATE,
  AdminAuditAction.ADMIN_MARKET_RANKING_FORMULA_ACTIVATE,
  AdminAuditAction.ADMIN_MARKET_RANKING_ROLLBACK,
  AdminAuditAction.ADMIN_MARKET_SUGGESTION_BLOCK_CREATE,
  AdminAuditAction.ADMIN_MARKET_SUGGESTION_BLOCK_UPDATE,
  AdminAuditAction.ADMIN_MARKET_RELEASE_CONTROL_UPDATE,
] satisfies AdminAuditAction[];

const jsonOrNull = (
  value: Record<string, unknown> | unknown[] | null | undefined,
): Prisma.InputJsonValue | typeof Prisma.JsonNull | undefined => {
  if (value === undefined) return undefined;
  if (value === null) return Prisma.JsonNull;
  return value as Prisma.InputJsonValue;
};

@Injectable()
export class AdminMarketGovernanceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AdminAuditService,
    private readonly marketGovernanceConfig: MarketGovernanceConfigService,
    private readonly rankingConfigService: MarketRankingConfigService,
  ) {}

  listSections() {
    return this.marketGovernanceConfig.getSectionConfigsWithFallback();
  }

  async createSection(
    dto: CreateMarketSectionConfigDto,
    actorId: string,
    req: Request,
  ) {
    const sectionKey = this.normalizeSlug(dto.sectionKey, 'sectionKey');
    const existing = await this.prisma.marketSectionConfig.findUnique({
      where: { sectionKey },
    });
    if (existing || this.getSectionDefaultOrNull(sectionKey)) {
      throw new BadRequestException('Market section key already exists');
    }

    return this.prisma.$transaction(async (tx) => {
      const created = await tx.marketSectionConfig.create({
        data: this.buildCustomSectionCreateData(sectionKey, dto, actorId),
      });

      await this.auditService.logInTransaction(
        tx,
        {
          actorUserId: actorId,
          action: AdminAuditAction.ADMIN_MARKET_SECTION_CONFIG_UPDATE,
          targetType: 'MarketSectionConfig',
          targetId: sectionKey,
          previousState: undefined,
          newState: this.toPlain(created),
          metadata: { reason: this.cleanReason(dto.reason), mode: 'create' },
        },
        req,
      );

      return created;
    });
  }

  async patchSection(
    sectionKey: string,
    dto: PatchMarketSectionConfigDto,
    actorId: string,
    req: Request,
  ) {
    const normalizedKey = await this.requireKnownSectionKey(sectionKey);
    await this.assertPrimarySectionRemainsEnabled(normalizedKey, dto);

    const existing = await this.prisma.marketSectionConfig.findUnique({
      where: { sectionKey: normalizedKey },
    });
    const defaultConfig = this.getSectionDefaultOrNull(normalizedKey);
    const nowData = defaultConfig
      ? this.buildSectionCreateData(normalizedKey, defaultConfig, dto, actorId)
      : this.buildExistingCustomSectionCreateData(normalizedKey, dto, actorId);
    const updateData = this.buildSectionUpdateData(dto, actorId);

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.marketSectionConfig.upsert({
        where: { sectionKey: normalizedKey },
        create: nowData,
        update: updateData,
      });

      await this.auditService.logInTransaction(
        tx,
        {
          actorUserId: actorId,
          action: AdminAuditAction.ADMIN_MARKET_SECTION_CONFIG_UPDATE,
          targetType: 'MarketSectionConfig',
          targetId: normalizedKey,
          previousState: existing ? this.toPlain(existing) : undefined,
          newState: this.toPlain(updated),
          metadata: { reason: this.cleanReason(dto.reason) },
        },
        req,
      );

      return updated;
    });
  }

  listRankingProfiles() {
    return this.prisma.marketRankingProfile.findMany({
      orderBy: [{ updatedAt: 'desc' }, { profileKey: 'asc' }],
      include: { formulaVersion: true },
    });
  }

  async createRankingProfile(
    dto: CreateMarketRankingProfileDto,
    actorId: string,
    req: Request,
  ) {
    await this.assertRankingProfileInput(dto);
    const sectionKeys = this.normalizeSectionKeys(dto.sectionKeys);
    const profileKey = this.normalizeSlug(dto.profileKey, 'profileKey');

    return this.prisma.$transaction(async (tx) => {
      const created = await tx.marketRankingProfile.create({
        data: {
          profileKey,
          name: this.cleanRequiredText(dto.name, 'name'),
          description: this.cleanOptionalText(dto.description),
          enabled: dto.enabled ?? false,
          shadowMode: dto.shadowMode ?? true,
          sectionKeys: sectionKeys as Prisma.InputJsonValue,
          formulaVersion: dto.formulaVersionId
            ? { connect: { id: dto.formulaVersionId } }
            : undefined,
          explorationPercent: dto.explorationPercent ?? 10,
          brandMaxShare: dto.brandMaxShare ?? 35,
          aggregateTimeoutMs: dto.aggregateTimeoutMs ?? 150,
          rolloutPercent: dto.rolloutPercent ?? 0,
          fallbackDeterministic: dto.fallbackDeterministic ?? true,
          metadata: jsonOrNull(dto.metadata),
          createdById: actorId,
          updatedById: actorId,
        },
      });

      await this.auditService.logInTransaction(
        tx,
        {
          actorUserId: actorId,
          action: AdminAuditAction.ADMIN_MARKET_RANKING_PROFILE_CREATE,
          targetType: 'MarketRankingProfile',
          targetId: profileKey,
          previousState: undefined,
          newState: this.toPlain(created),
          metadata: { reason: this.cleanReason(dto.reason) },
        },
        req,
      );

      return created;
    });
  }

  async patchRankingProfile(
    profileKey: string,
    dto: PatchMarketRankingProfileDto,
    actorId: string,
    req: Request,
  ) {
    const normalizedKey = this.normalizeSlug(profileKey, 'profileKey');
    const existing = await this.prisma.marketRankingProfile.findUnique({
      where: { profileKey: normalizedKey },
    });
    if (!existing) {
      throw new NotFoundException('Market ranking profile not found');
    }

    await this.assertRankingProfileInput(dto);
    const updateData = this.buildRankingProfileUpdateData(dto, actorId);

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.marketRankingProfile.update({
        where: { profileKey: normalizedKey },
        data: updateData,
      });

      await this.auditService.logInTransaction(
        tx,
        {
          actorUserId: actorId,
          action: AdminAuditAction.ADMIN_MARKET_RANKING_PROFILE_UPDATE,
          targetType: 'MarketRankingProfile',
          targetId: normalizedKey,
          previousState: this.toPlain(existing),
          newState: this.toPlain(updated),
          metadata: { reason: this.cleanReason(dto.reason) },
        },
        req,
      );

      return updated;
    });
  }

  listRankingFormulas() {
    return this.prisma.marketRankingFormulaVersion.findMany({
      orderBy: [{ createdAt: 'desc' }, { versionKey: 'asc' }],
    });
  }

  async createRankingFormula(
    dto: CreateMarketRankingFormulaDto,
    actorId: string,
    req: Request,
  ) {
    const versionKey = this.normalizeSlug(dto.versionKey, 'versionKey');
    const status = dto.status ?? 'DRAFT';
    if (!SUPPORTED_FORMULA_STATUSES.includes(status as any)) {
      throw new BadRequestException('Unsupported formula status');
    }
    const weights = this.validateFormulaWeights(dto.weights);
    const bounds = dto.bounds ? this.validateFormulaBounds(dto.bounds) : null;
    const now = new Date();

    return this.prisma.$transaction(async (tx) => {
      let previousActive: Array<{ id: string; versionKey: string }> = [];
      if (status === 'ACTIVE') {
        previousActive = await tx.marketRankingFormulaVersion.findMany({
          where: { status: 'ACTIVE' },
          select: { id: true, versionKey: true },
        });
        await tx.marketRankingFormulaVersion.updateMany({
          where: { status: 'ACTIVE' },
          data: { status: 'DEPRECATED', deprecatedAt: now },
        });
      }

      const created = await tx.marketRankingFormulaVersion.create({
        data: {
          versionKey,
          name: this.cleanRequiredText(dto.name, 'name'),
          status,
          weights: weights as Prisma.InputJsonValue,
          bounds: bounds ? (bounds as Prisma.InputJsonValue) : Prisma.JsonNull,
          notes: this.cleanOptionalText(dto.notes),
          createdById: actorId,
          activatedAt: status === 'ACTIVE' ? now : null,
        },
      });

      await this.auditService.logInTransaction(
        tx,
        {
          actorUserId: actorId,
          action:
            status === 'ACTIVE'
              ? AdminAuditAction.ADMIN_MARKET_RANKING_FORMULA_ACTIVATE
              : AdminAuditAction.ADMIN_MARKET_RANKING_FORMULA_CREATE,
          targetType: 'MarketRankingFormulaVersion',
          targetId: versionKey,
          previousState: { previousActive },
          newState: this.toPlain(created),
          metadata: { reason: this.cleanReason(dto.reason) },
        },
        req,
      );

      return created;
    });
  }

  async listSuggestionBlocks() {
    return this.marketGovernanceConfig.getSuggestionBlockConfigsWithFallback();
  }

  async createSuggestionBlock(
    dto: CreateMarketSuggestionBlockConfigDto,
    actorId: string,
    req: Request,
  ) {
    this.assertSuggestionInput(dto);
    const blockKey = this.normalizeSlug(dto.blockKey, 'blockKey');

    return this.prisma.$transaction(async (tx) => {
      const created = await tx.marketSuggestionBlockConfig.create({
        data: {
          blockKey,
          context: dto.context,
          targetType: dto.targetType,
          title: this.cleanRequiredText(dto.title, 'title'),
          subtitle: this.cleanOptionalText(dto.subtitle),
          enabled: dto.enabled ?? true,
          displayOrder: dto.displayOrder ?? 0,
          sourceType: dto.sourceType,
          fallbackSourceType: dto.fallbackSourceType ?? null,
          itemLimit: dto.itemLimit ?? 8,
          metadata: jsonOrNull(dto.metadata),
          createdById: actorId,
          updatedById: actorId,
        },
      });

      await this.auditService.logInTransaction(
        tx,
        {
          actorUserId: actorId,
          action: AdminAuditAction.ADMIN_MARKET_SUGGESTION_BLOCK_CREATE,
          targetType: 'MarketSuggestionBlockConfig',
          targetId: blockKey,
          previousState: undefined,
          newState: this.toPlain(created),
          metadata: { reason: this.cleanReason(dto.reason) },
        },
        req,
      );

      return created;
    });
  }

  async patchSuggestionBlock(
    blockKey: string,
    dto: PatchMarketSuggestionBlockConfigDto,
    actorId: string,
    req: Request,
  ) {
    const normalizedKey = this.normalizeSlug(blockKey, 'blockKey');
    this.assertSuggestionInput(dto);
    const existing = await this.prisma.marketSuggestionBlockConfig.findUnique({
      where: { blockKey: normalizedKey },
    });
    if (!existing) {
      throw new NotFoundException('Market suggestion block config not found');
    }

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.marketSuggestionBlockConfig.update({
        where: { blockKey: normalizedKey },
        data: this.buildSuggestionBlockUpdateData(dto, actorId),
      });

      await this.auditService.logInTransaction(
        tx,
        {
          actorUserId: actorId,
          action: AdminAuditAction.ADMIN_MARKET_SUGGESTION_BLOCK_UPDATE,
          targetType: 'MarketSuggestionBlockConfig',
          targetId: normalizedKey,
          previousState: this.toPlain(existing),
          newState: this.toPlain(updated),
          metadata: { reason: this.cleanReason(dto.reason) },
        },
        req,
      );

      return updated;
    });
  }

  async listAuditLogs(query: AdminMarketGovernanceAuditQueryDto) {
    const take = Math.min(Math.max(query.limit ?? 50, 1), 100);
    const where: Prisma.AdminAuditLogWhereInput = {
      action: query.action
        ? query.action
        : { in: MARKET_GOVERNANCE_AUDIT_ACTIONS },
    };

    if (
      query.action &&
      !(MARKET_GOVERNANCE_AUDIT_ACTIONS as AdminAuditAction[]).includes(
        query.action,
      )
    ) {
      throw new BadRequestException(
        'Unsupported market governance audit action',
      );
    }
    if (query.targetType) where.targetType = query.targetType;
    if (query.targetId) where.targetId = query.targetId;

    const items = await this.prisma.adminAuditLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: take + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    });

    const hasMore = items.length > take;
    const results = hasMore ? items.slice(0, take) : items;

    return {
      items: results,
      nextCursor: hasMore ? results[results.length - 1]?.id : null,
    };
  }

  async getReleaseStatus() {
    const rankingConfig = this.rankingConfigService.getConfig();
    const [
      activeRankingProfile,
      activeFormulaVersion,
      lastRollback,
      sectionStatus,
    ] = await Promise.all([
      this.prisma.marketRankingProfile.findFirst({
        where: { enabled: true },
        orderBy: [{ updatedAt: 'desc' }],
        include: { formulaVersion: true },
      }),
      this.prisma.marketRankingFormulaVersion.findFirst({
        where: { status: 'ACTIVE' },
        orderBy: [{ activatedAt: 'desc' }, { createdAt: 'desc' }],
      }),
      this.prisma.adminAuditLog.findFirst({
        where: { action: AdminAuditAction.ADMIN_MARKET_RANKING_ROLLBACK },
        orderBy: { createdAt: 'desc' },
      }),
      this.marketGovernanceConfig.getSectionConfigsWithFallback(),
    ]);

    return {
      rankingEnabled: rankingConfig.enabled,
      rankingDefaultDisabled: true,
      deterministicFallbackEnabled: rankingConfig.fallbackDeterministic,
      shadowMode: rankingConfig.shadowMode,
      activeRankingProfile,
      activeFormulaVersion,
      configReadStatus: sectionStatus.configReadStatus,
      lastRollback,
      productionReady: false,
      phase14Required: true,
    };
  }

  async rollbackRanking(
    dto: MarketGovernanceRollbackDto,
    actorId: string,
    req: Request,
  ) {
    const active = await this.prisma.marketRankingFormulaVersion.findFirst({
      where: { status: 'ACTIVE' },
      orderBy: [{ activatedAt: 'desc' }, { createdAt: 'desc' }],
    });
    const previous = await this.prisma.marketRankingFormulaVersion.findFirst({
      where: {
        status: 'DEPRECATED',
        ...(active ? { id: { not: active.id } } : {}),
      },
      orderBy: [{ deprecatedAt: 'desc' }, { createdAt: 'desc' }],
    });

    if (!active || !previous) {
      throw new BadRequestException(
        'Ranking rollback requires an active formula and a prior deprecated formula',
      );
    }

    const now = new Date();
    return this.prisma.$transaction(async (tx) => {
      const rolledBack = await tx.marketRankingFormulaVersion.update({
        where: { id: active.id },
        data: { status: 'ROLLED_BACK', deprecatedAt: now },
      });
      const restored = await tx.marketRankingFormulaVersion.update({
        where: { id: previous.id },
        data: { status: 'ACTIVE', activatedAt: now, deprecatedAt: null },
      });

      await this.auditService.logInTransaction(
        tx,
        {
          actorUserId: actorId,
          action: AdminAuditAction.ADMIN_MARKET_RANKING_ROLLBACK,
          targetType: 'MarketRankingFormulaVersion',
          targetId: restored.versionKey,
          previousState: {
            activeFormulaVersion: this.toPlain(active),
            priorFormulaVersion: this.toPlain(previous),
          },
          newState: {
            restoredFormulaVersion: this.toPlain(restored),
            rolledBackFormulaVersion: this.toPlain(rolledBack),
            rankingProfileRollback: 'not-supported-without-profile-history',
          },
          metadata: { reason: this.cleanReason(dto.reason) },
        },
        req,
      );

      return {
        rolledBack: true,
        restoredFormulaVersion: restored,
        rolledBackFormulaVersion: rolledBack,
        rankingProfileRollback: 'not-supported-without-profile-history',
        historyPreserved: true,
      };
    });
  }

  async rehearseRollback() {
    const [active, previous] = await Promise.all([
      this.prisma.marketRankingFormulaVersion.findFirst({
        where: { status: 'ACTIVE' },
        orderBy: [{ activatedAt: 'desc' }, { createdAt: 'desc' }],
      }),
      this.prisma.marketRankingFormulaVersion.findFirst({
        where: { status: 'DEPRECATED' },
        orderBy: [{ deprecatedAt: 'desc' }, { createdAt: 'desc' }],
      }),
    ]);

    return {
      rehearsalOnly: true,
      mutatesConfig: false,
      deterministicFallbackAvailable: true,
      canRollbackFormula: Boolean(
        active && previous && active.id !== previous.id,
      ),
      activeFormulaVersion: active,
      candidatePriorFormulaVersion:
        active && previous && active.id !== previous.id ? previous : null,
      rankingProfileRollback: 'not-supported-without-profile-history',
      wouldMutate: [],
    };
  }

  private requireSupportedSectionKey(key: string): SupportedMarketSectionKey {
    const normalized = this.normalizeSlug(key, 'sectionKey');
    if (!SUPPORTED_MARKET_SECTION_KEYS.includes(normalized as any)) {
      throw new BadRequestException('Unsupported market section key');
    }
    return normalized as SupportedMarketSectionKey;
  }

  private async requireKnownSectionKey(key: string): Promise<string> {
    const normalized = this.normalizeSlug(key, 'sectionKey');
    if (SUPPORTED_MARKET_SECTION_KEYS.includes(normalized as any)) {
      return normalized;
    }
    const existing = await this.prisma.marketSectionConfig.findUnique({
      where: { sectionKey: normalized },
      select: { sectionKey: true },
    });
    if (!existing) {
      throw new NotFoundException('Market section config not found');
    }
    return normalized;
  }

  private getSectionDefault(key: SupportedMarketSectionKey) {
    const defaultConfig = this.getSectionDefaultOrNull(key);
    if (!defaultConfig) {
      throw new BadRequestException('Unsupported market section key');
    }
    return defaultConfig;
  }

  private getSectionDefaultOrNull(key: string) {
    return MARKET_SECTION_CODE_DEFAULTS.find(
      (config) => config.sectionKey === key,
    );
  }

  private async assertPrimarySectionRemainsEnabled(
    sectionKey: string,
    dto: PatchMarketSectionConfigDto,
  ) {
    const wouldDisable =
      dto.enabled === false ||
      dto.status === 'PAUSED' ||
      dto.status === 'ARCHIVED';
    if (!wouldDisable) return;
    const current =
      await this.marketGovernanceConfig.getSectionConfigsWithFallback();
    const next = current.items.map((config) =>
      config.sectionKey === sectionKey
        ? {
            ...config,
            enabled: dto.enabled ?? config.enabled,
            status: (dto.status ?? config.status) as typeof config.status,
          }
        : config,
    );
    if (
      !next.some((config) => config.enabled && config.status === 'ACTIVE')
    ) {
      throw new BadRequestException(
        'At least one active market section must remain enabled',
      );
    }
  }

  private async assertRankingProfileInput(
    dto: CreateMarketRankingProfileDto | PatchMarketRankingProfileDto,
  ) {
    if (dto.fallbackDeterministic === false) {
      throw new BadRequestException(
        'Deterministic fallback cannot be disabled',
      );
    }
    if ((dto.rolloutPercent ?? 0) > 0) {
      throw new BadRequestException(
        'Ranking rollout percent must remain 0 before Phase 14',
      );
    }
    this.normalizeSectionKeys(dto.sectionKeys);
    if (dto.formulaVersionId) {
      const formula = await this.prisma.marketRankingFormulaVersion.findUnique({
        where: { id: dto.formulaVersionId },
        select: { id: true },
      });
      if (!formula) {
        throw new BadRequestException('Formula version does not exist');
      }
    }
  }

  private normalizeSectionKeys(sectionKeys?: string[]) {
    const seen = new Set<string>();
    for (const key of sectionKeys ?? []) {
      const normalized = this.requireSupportedSectionKey(key);
      seen.add(normalized);
    }
    return Array.from(seen);
  }

  private assertSuggestionInput(
    dto: Partial<
      CreateMarketSuggestionBlockConfigDto & PatchMarketSuggestionBlockConfigDto
    >,
  ) {
    if (
      dto.context !== undefined &&
      !SUPPORTED_SUGGESTION_CONTEXTS.includes(dto.context as any)
    ) {
      throw new BadRequestException('Unsupported suggestion context');
    }
    if (
      dto.targetType !== undefined &&
      !SUPPORTED_SUGGESTION_TARGET_TYPES.includes(dto.targetType as any)
    ) {
      throw new BadRequestException('Unsupported suggestion target type');
    }
    if (
      dto.sourceType !== undefined &&
      !SUPPORTED_SUGGESTION_SOURCE_TYPES.includes(dto.sourceType as any)
    ) {
      throw new BadRequestException('Unsupported suggestion source type');
    }
    if (
      dto.fallbackSourceType !== undefined &&
      dto.fallbackSourceType !== null &&
      !SUPPORTED_SUGGESTION_SOURCE_TYPES.includes(dto.fallbackSourceType as any)
    ) {
      throw new BadRequestException(
        'Unsupported suggestion fallback source type',
      );
    }
  }

  private validateFormulaWeights(weights: Record<string, unknown>) {
    if (!weights || typeof weights !== 'object' || Array.isArray(weights)) {
      throw new BadRequestException('Formula weights must be an object');
    }

    const normalized: Record<string, number> = {};
    for (const [key, value] of Object.entries(weights)) {
      if (!ALLOWED_FORMULA_WEIGHT_KEYS.includes(key as any)) {
        throw new BadRequestException(`Unsupported formula weight: ${key}`);
      }
      const numeric = Number(value);
      if (!Number.isFinite(numeric) || numeric < 0 || numeric > 1) {
        throw new BadRequestException(
          `Formula weight ${key} must be between 0 and 1`,
        );
      }
      normalized[key] = numeric;
    }

    if (Object.keys(normalized).length === 0) {
      throw new BadRequestException('Formula weights cannot be empty');
    }

    return normalized;
  }

  private validateFormulaBounds(bounds: Record<string, unknown>) {
    if (!bounds || typeof bounds !== 'object' || Array.isArray(bounds)) {
      throw new BadRequestException('Formula bounds must be an object');
    }
    return bounds;
  }

  private buildSectionCreateData(
    sectionKey: string,
    defaultConfig: (typeof MARKET_SECTION_CODE_DEFAULTS)[number],
    dto: PatchMarketSectionConfigDto,
    actorId: string,
  ): Prisma.MarketSectionConfigCreateInput {
    return {
      sectionKey,
      title: this.cleanOptionalText(dto.title) ?? defaultConfig.title,
      subtitle:
        dto.subtitle !== undefined
          ? this.cleanOptionalText(dto.subtitle)
          : defaultConfig.subtitle,
      enabled: dto.enabled ?? defaultConfig.enabled,
      status: (dto.status ?? defaultConfig.status) as any,
      sourceType: (dto.sourceType ?? defaultConfig.sourceType) as any,
      rankingProfileKey:
        dto.rankingProfileKey !== undefined
          ? this.cleanOptionalText(dto.rankingProfileKey)
          : defaultConfig.rankingProfileKey,
      displayOrder: dto.displayOrder ?? defaultConfig.displayOrder,
      previewItemLimit: dto.previewItemLimit ?? defaultConfig.previewItemLimit,
      detailPageLimit: dto.detailPageLimit ?? defaultConfig.detailPageLimit,
      minimumItems: dto.minimumItems ?? defaultConfig.minimumItems,
      viewAllEnabled: dto.viewAllEnabled ?? defaultConfig.viewAllEnabled,
      viewAllLabel:
        dto.viewAllLabel !== undefined
          ? this.cleanOptionalText(dto.viewAllLabel)
          : defaultConfig.viewAllLabel,
      fallbackMode:
        this.cleanOptionalText(dto.fallbackMode) ?? defaultConfig.fallbackMode,
      fallbackSectionKey:
        dto.fallbackSectionKey !== undefined
          ? this.cleanOptionalText(dto.fallbackSectionKey)
          : defaultConfig.fallbackSectionKey,
      guestEnabled: dto.guestEnabled ?? defaultConfig.guestEnabled,
      requiresAuth: dto.requiresAuth ?? defaultConfig.requiresAuth,
      newBrandReservedRatio:
        dto.newBrandReservedRatio ?? defaultConfig.newBrandReservedRatio,
      metadata: jsonOrNull(dto.metadata),
      createdById: actorId,
      updatedById: actorId,
    };
  }

  private buildCustomSectionCreateData(
    sectionKey: string,
    dto: CreateMarketSectionConfigDto,
    actorId: string,
  ): Prisma.MarketSectionConfigCreateInput {
    const sourceType = dto.sourceType as any;
    return {
      sectionKey,
      title: this.cleanRequiredText(dto.title, 'title'),
      subtitle: this.cleanOptionalText(dto.subtitle),
      enabled: dto.enabled ?? true,
      status: (dto.status ?? 'ACTIVE') as any,
      sourceType,
      rankingProfileKey:
        dto.rankingProfileKey !== undefined
          ? this.cleanOptionalText(dto.rankingProfileKey)
          : 'deterministic-v1',
      displayOrder: dto.displayOrder ?? 100,
      previewItemLimit: dto.previewItemLimit ?? 8,
      detailPageLimit: dto.detailPageLimit ?? 24,
      minimumItems: dto.minimumItems ?? 1,
      viewAllEnabled: dto.viewAllEnabled ?? true,
      viewAllLabel: this.cleanOptionalText(dto.viewAllLabel),
      fallbackMode: 'SOURCE_TEMPLATE',
      fallbackSectionKey: this.cleanOptionalText(dto.fallbackSectionKey),
      guestEnabled: dto.guestEnabled ?? true,
      requiresAuth: dto.requiresAuth ?? false,
      newBrandReservedRatio: dto.newBrandReservedRatio ?? 0,
      metadata: jsonOrNull(dto.metadata),
      createdById: actorId,
      updatedById: actorId,
    };
  }

  private buildExistingCustomSectionCreateData(
    sectionKey: string,
    dto: PatchMarketSectionConfigDto,
    actorId: string,
  ): Prisma.MarketSectionConfigCreateInput {
    if (!dto.title || !dto.sourceType) {
      throw new NotFoundException('Market section config not found');
    }
    return this.buildCustomSectionCreateData(
      sectionKey,
      {
        sectionKey,
        title: dto.title,
        subtitle: dto.subtitle ?? undefined,
        enabled: dto.enabled,
        status: dto.status,
        sourceType: dto.sourceType,
        rankingProfileKey: dto.rankingProfileKey,
        displayOrder: dto.displayOrder,
        previewItemLimit: dto.previewItemLimit,
        detailPageLimit: dto.detailPageLimit,
        minimumItems: dto.minimumItems,
        viewAllEnabled: dto.viewAllEnabled,
        viewAllLabel: dto.viewAllLabel,
        fallbackSectionKey: dto.fallbackSectionKey,
        guestEnabled: dto.guestEnabled,
        requiresAuth: dto.requiresAuth,
        newBrandReservedRatio: dto.newBrandReservedRatio,
        metadata: dto.metadata,
        reason: dto.reason,
      },
      actorId,
    );
  }

  private buildSectionUpdateData(
    dto: PatchMarketSectionConfigDto,
    actorId: string,
  ): Prisma.MarketSectionConfigUpdateInput {
    const data: Prisma.MarketSectionConfigUpdateInput = {
      updatedById: actorId,
    };
    if (dto.title !== undefined)
      data.title = this.cleanRequiredText(dto.title, 'title');
    if (dto.subtitle !== undefined)
      data.subtitle = this.cleanOptionalText(dto.subtitle);
    if (dto.enabled !== undefined) data.enabled = dto.enabled;
    if (dto.status !== undefined) data.status = dto.status as any;
    if (dto.sourceType !== undefined) data.sourceType = dto.sourceType as any;
    if (dto.rankingProfileKey !== undefined) {
      data.rankingProfileKey = this.cleanOptionalText(dto.rankingProfileKey);
    }
    if (dto.displayOrder !== undefined) data.displayOrder = dto.displayOrder;
    if (dto.previewItemLimit !== undefined)
      data.previewItemLimit = dto.previewItemLimit;
    if (dto.detailPageLimit !== undefined)
      data.detailPageLimit = dto.detailPageLimit;
    if (dto.minimumItems !== undefined) data.minimumItems = dto.minimumItems;
    if (dto.viewAllEnabled !== undefined)
      data.viewAllEnabled = dto.viewAllEnabled;
    if (dto.viewAllLabel !== undefined)
      data.viewAllLabel = this.cleanOptionalText(dto.viewAllLabel);
    if (dto.fallbackMode !== undefined) {
      data.fallbackMode = this.cleanRequiredText(
        dto.fallbackMode,
        'fallbackMode',
      );
    }
    if (dto.fallbackSectionKey !== undefined) {
      data.fallbackSectionKey = this.cleanOptionalText(dto.fallbackSectionKey);
    }
    if (dto.guestEnabled !== undefined) data.guestEnabled = dto.guestEnabled;
    if (dto.requiresAuth !== undefined) data.requiresAuth = dto.requiresAuth;
    if (dto.newBrandReservedRatio !== undefined) {
      data.newBrandReservedRatio = dto.newBrandReservedRatio;
    }
    if (dto.metadata !== undefined) data.metadata = jsonOrNull(dto.metadata);
    return data;
  }

  private buildRankingProfileUpdateData(
    dto: PatchMarketRankingProfileDto,
    actorId: string,
  ): Prisma.MarketRankingProfileUpdateInput {
    const data: Prisma.MarketRankingProfileUpdateInput = {
      updatedById: actorId,
    };
    if (dto.name !== undefined)
      data.name = this.cleanRequiredText(dto.name, 'name');
    if (dto.description !== undefined) {
      data.description = this.cleanOptionalText(dto.description);
    }
    if (dto.enabled !== undefined) data.enabled = dto.enabled;
    if (dto.shadowMode !== undefined) data.shadowMode = dto.shadowMode;
    if (dto.sectionKeys !== undefined) {
      data.sectionKeys = this.normalizeSectionKeys(
        dto.sectionKeys,
      ) as Prisma.InputJsonValue;
    }
    if ('formulaVersionId' in dto) {
      data.formulaVersion = dto.formulaVersionId
        ? { connect: { id: dto.formulaVersionId } }
        : { disconnect: true };
    }
    if (dto.explorationPercent !== undefined) {
      data.explorationPercent = dto.explorationPercent;
    }
    if (dto.brandMaxShare !== undefined) data.brandMaxShare = dto.brandMaxShare;
    if (dto.aggregateTimeoutMs !== undefined) {
      data.aggregateTimeoutMs = dto.aggregateTimeoutMs;
    }
    if (dto.rolloutPercent !== undefined)
      data.rolloutPercent = dto.rolloutPercent;
    if (dto.fallbackDeterministic !== undefined) {
      data.fallbackDeterministic = dto.fallbackDeterministic;
    }
    if (dto.metadata !== undefined) data.metadata = jsonOrNull(dto.metadata);
    return data;
  }

  private buildSuggestionBlockUpdateData(
    dto: PatchMarketSuggestionBlockConfigDto,
    actorId: string,
  ): Prisma.MarketSuggestionBlockConfigUpdateInput {
    const data: Prisma.MarketSuggestionBlockConfigUpdateInput = {
      updatedById: actorId,
    };
    if (dto.context !== undefined) data.context = dto.context;
    if (dto.targetType !== undefined) data.targetType = dto.targetType;
    if (dto.title !== undefined)
      data.title = this.cleanRequiredText(dto.title, 'title');
    if (dto.subtitle !== undefined)
      data.subtitle = this.cleanOptionalText(dto.subtitle);
    if (dto.enabled !== undefined) data.enabled = dto.enabled;
    if (dto.displayOrder !== undefined) data.displayOrder = dto.displayOrder;
    if (dto.sourceType !== undefined) data.sourceType = dto.sourceType;
    if ('fallbackSourceType' in dto) {
      data.fallbackSourceType = dto.fallbackSourceType ?? null;
    }
    if (dto.itemLimit !== undefined) data.itemLimit = dto.itemLimit;
    if (dto.metadata !== undefined) data.metadata = jsonOrNull(dto.metadata);
    return data;
  }

  private normalizeSlug(value: string, field: string) {
    const normalized = String(value ?? '')
      .trim()
      .toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{0,119}$/.test(normalized)) {
      throw new BadRequestException(`Invalid ${field}`);
    }
    return normalized;
  }

  private cleanRequiredText(value: string, field: string) {
    const cleaned = String(value ?? '').trim();
    if (!cleaned) {
      throw new BadRequestException(`${field} is required`);
    }
    return cleaned;
  }

  private cleanOptionalText(value: string | undefined | null) {
    if (value === undefined) return undefined;
    const cleaned = String(value ?? '').trim();
    return cleaned.length > 0 ? cleaned : null;
  }

  private cleanReason(value: string | undefined) {
    const cleaned = this.cleanOptionalText(value);
    return cleaned ?? null;
  }

  private toPlain(value: unknown) {
    return JSON.parse(JSON.stringify(value ?? {})) as Record<string, unknown>;
  }
}
