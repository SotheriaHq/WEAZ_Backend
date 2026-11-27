import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AdminAuditAction, Prisma } from '@prisma/client';
import { Request } from 'express';
import { PrismaService } from 'src/prisma/prisma.service';
import { AdminAuditService } from '../services/admin-audit.service';
import { lockClassicRails } from './market-section-lifecycle';
import { MarketRankingConfigService } from 'src/market/market-ranking-config.service';
import {
  MarketGovernanceConfigService,
  MARKET_SECTION_CODE_DEFAULTS,
  SUPPORTED_MARKET_SECTION_KEYS,
  SUPPORTED_SUGGESTION_CONTEXTS,
  SUPPORTED_SUGGESTION_SOURCE_TYPES,
  SUPPORTED_SUGGESTION_TARGET_TYPES,
  SupportedMarketSectionKey,
} from 'src/market/market-governance-config.service';
import {
  AdminMarketGovernanceAuditQueryDto,
  CreateMarketSectionConfigDto,
  CreateMarketSuggestionBlockConfigDto,
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

    const existing = await this.prisma.marketSectionConfig.findUnique({
      where: { sectionKey: normalizedKey },
    });
    if (existing?.publishedVersionId) {
      // The served row must equal its published snapshot (database trigger).
      throw new ConflictException({
        code: 'SECTION_PUBLISHED',
        message: 'Published sections change through draft and publish.',
      });
    }
    const defaultConfig = this.getSectionDefaultOrNull(normalizedKey);
    const nowData = defaultConfig
      ? this.buildSectionCreateData(normalizedKey, defaultConfig, dto, actorId)
      : this.buildExistingCustomSectionCreateData(
          normalizedKey,
          existing,
          dto,
          actorId,
        );
    const updateData = this.buildSectionUpdateData(dto, actorId);

    return this.prisma.$transaction(async (tx) => {
      await this.assertPrimarySectionRemainsEnabled(tx, normalizedKey, dto);
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
    const sectionStatus =
      await this.marketGovernanceConfig.getSectionConfigsWithFallback();

    return {
      rankingEnabled: rankingConfig.enabled,
      rankingDefaultDisabled: true,
      deterministicFallbackEnabled: rankingConfig.fallbackDeterministic,
      shadowMode: rankingConfig.shadowMode,
      configReadStatus: sectionStatus.configReadStatus,
      productionReady: false,
      phase14Required: true,
    };
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

  /** Runs inside the write, before the row lock, under the shared rails lock. */
  private async assertPrimarySectionRemainsEnabled(
    tx: Prisma.TransactionClient,
    sectionKey: string,
    dto: PatchMarketSectionConfigDto,
  ) {
    const wouldDisable =
      dto.enabled === false ||
      dto.status === 'PAUSED' ||
      dto.status === 'ARCHIVED';
    if (!wouldDisable) return;
    await lockClassicRails(tx);
    const current =
      await this.marketGovernanceConfig.getSectionConfigsWithFallback(tx);
    const next = current.items.map((config) =>
      config.sectionKey === sectionKey
        ? {
            ...config,
            enabled: dto.enabled ?? config.enabled,
            status: (dto.status ?? config.status) as typeof config.status,
          }
        : config,
    );
    if (!next.some((config) => config.enabled && config.status === 'ACTIVE')) {
      throw new BadRequestException(
        'At least one active market section must remain enabled',
      );
    }
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
    existing: {
      title: string;
      subtitle: string | null;
      enabled: boolean;
      status: string;
      sourceType: string;
      rankingProfileKey: string | null;
      displayOrder: number;
      previewItemLimit: number;
      detailPageLimit: number;
      minimumItems: number;
      viewAllEnabled: boolean;
      viewAllLabel: string | null;
      fallbackMode: string;
      fallbackSectionKey: string | null;
      guestEnabled: boolean;
      requiresAuth: boolean;
      newBrandReservedRatio: number;
      metadata: Prisma.JsonValue | null;
      createdById: string | null;
    } | null,
    dto: PatchMarketSectionConfigDto,
    actorId: string,
  ): Prisma.MarketSectionConfigCreateInput {
    const title = dto.title ?? existing?.title;
    const sourceType = dto.sourceType ?? existing?.sourceType;
    if (!title || !sourceType) {
      throw new NotFoundException('Market section config not found');
    }

    return {
      sectionKey,
      title: this.cleanRequiredText(title, 'title'),
      subtitle:
        dto.subtitle !== undefined
          ? this.cleanOptionalText(dto.subtitle)
          : existing?.subtitle,
      enabled: dto.enabled ?? existing?.enabled ?? true,
      status: (dto.status ?? existing?.status ?? 'ACTIVE') as any,
      sourceType: sourceType as any,
      rankingProfileKey:
        dto.rankingProfileKey !== undefined
          ? this.cleanOptionalText(dto.rankingProfileKey)
          : (existing?.rankingProfileKey ?? 'deterministic-v1'),
      displayOrder: dto.displayOrder ?? existing?.displayOrder ?? 100,
      previewItemLimit: dto.previewItemLimit ?? existing?.previewItemLimit ?? 8,
      detailPageLimit: dto.detailPageLimit ?? existing?.detailPageLimit ?? 24,
      minimumItems: dto.minimumItems ?? existing?.minimumItems ?? 1,
      viewAllEnabled: dto.viewAllEnabled ?? existing?.viewAllEnabled ?? true,
      viewAllLabel:
        dto.viewAllLabel !== undefined
          ? this.cleanOptionalText(dto.viewAllLabel)
          : existing?.viewAllLabel,
      fallbackMode:
        dto.fallbackMode !== undefined
          ? (this.cleanOptionalText(dto.fallbackMode) ?? 'SOURCE_TEMPLATE')
          : (existing?.fallbackMode ?? 'SOURCE_TEMPLATE'),
      fallbackSectionKey:
        dto.fallbackSectionKey !== undefined
          ? this.cleanOptionalText(dto.fallbackSectionKey)
          : existing?.fallbackSectionKey,
      guestEnabled: dto.guestEnabled ?? existing?.guestEnabled ?? true,
      requiresAuth: dto.requiresAuth ?? existing?.requiresAuth ?? false,
      newBrandReservedRatio:
        dto.newBrandReservedRatio ?? existing?.newBrandReservedRatio ?? 0,
      metadata:
        dto.metadata !== undefined
          ? jsonOrNull(dto.metadata)
          : jsonOrNull(existing?.metadata as Record<string, unknown> | null),
      createdById: existing?.createdById ?? actorId,
      updatedById: actorId,
    };
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
