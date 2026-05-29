import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import {
  MarketSignalSurface,
  MarketSignalTargetType,
  MarketSignalType,
  MarketSuppressionType,
  Prisma,
  UserContentSuppression,
} from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import {
  CreateMarketSuppressionDto,
  MARKET_SIGNAL_MAX_REASON_LENGTH,
  MARKET_SIGNAL_MAX_SECTION_KEY_LENGTH,
  MARKET_SIGNAL_MAX_TARGET_ID_LENGTH,
  MarketSuppressionQueryDto,
} from './dto/market-signal.dto';
import { MarketSignalAggregationService } from './market-signal-aggregation.service';
import { MarketSignalIdentity } from './market-signal.service';

export interface MarketSuppressionScope {
  targetKeys: Set<string>;
  brandIds: Set<string>;
  categoryIds: Set<string>;
  sectionKeys: Set<string>;
  suggestionBlockKeys: Set<string>;
}

type NormalizedMarketSuppression = {
  targetId: string | null;
  brandId: string | null;
  categoryId: string | null;
  sectionKey: string | null;
  suggestionBlockKey: string | null;
  reason: string | null;
  expiresAt: Date | null;
};

@Injectable()
export class MarketSuppressionService {
  private readonly logger = new Logger(MarketSuppressionService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Optional()
    private readonly aggregationService?: MarketSignalAggregationService,
  ) {}

  async createSuppression(
    dto: CreateMarketSuppressionDto,
    identity: MarketSignalIdentity,
  ) {
    const owner = this.resolveOwner(identity, dto.anonymousSessionId);
    const normalized = this.normalizeSuppression(dto);
    const existing = await this.findExistingSuppression(
      owner,
      dto.targetType,
      dto.suppressionType,
      normalized,
    );

    if (existing) {
      return existing;
    }

    const suppression = await this.prisma.userContentSuppression.create({
      data: {
        userId: owner.userId,
        anonymousSessionId: owner.anonymousSessionId,
        targetType: dto.targetType,
        targetId: normalized.targetId,
        brandId: normalized.brandId,
        categoryId: normalized.categoryId,
        sectionKey: normalized.sectionKey,
        suggestionBlockKey: normalized.suggestionBlockKey,
        suppressionType: dto.suppressionType,
        reason: normalized.reason,
        expiresAt: normalized.expiresAt,
      },
    });

    await this.aggregateSuppression(owner, suppression);
    return suppression;
  }

  private async findExistingSuppression(
    owner: { userId: string | null; anonymousSessionId: string | null },
    targetType: MarketSignalTargetType,
    suppressionType: MarketSuppressionType,
    normalized: NormalizedMarketSuppression,
  ) {
    const ownerWhere: Prisma.UserContentSuppressionWhereInput[] = [];
    if (owner.userId) ownerWhere.push({ userId: owner.userId });
    if (owner.anonymousSessionId) {
      ownerWhere.push({ anonymousSessionId: owner.anonymousSessionId });
    }
    if (!ownerWhere.length) return null;

    return this.prisma.userContentSuppression.findFirst({
      where: {
        AND: [
          { OR: ownerWhere },
          this.activeWhere(),
          {
            targetType,
            targetId: normalized.targetId,
            brandId: normalized.brandId,
            categoryId: normalized.categoryId,
            sectionKey: normalized.sectionKey,
            suggestionBlockKey: normalized.suggestionBlockKey,
            suppressionType,
          },
        ],
      },
    });
  }

  async listSuppressions(
    identity: MarketSignalIdentity,
    query?: MarketSuppressionQueryDto,
  ) {
    const where = this.buildOwnerWhere(identity, query?.anonymousSessionId);
    if (!where.length) {
      throw new BadRequestException(
        'Authentication or anonymousSessionId is required',
      );
    }

    return this.prisma.userContentSuppression.findMany({
      where: {
        AND: [{ OR: where }, this.activeWhere()],
      },
      orderBy: [{ createdAt: 'desc' }],
      take: 100,
    });
  }

  async deleteSuppression(
    id: string,
    identity: MarketSignalIdentity,
    query?: MarketSuppressionQueryDto,
  ) {
    const where = this.buildOwnerWhere(identity, query?.anonymousSessionId);
    if (!where.length) {
      throw new BadRequestException(
        'Authentication or anonymousSessionId is required',
      );
    }

    const result = await this.prisma.userContentSuppression.deleteMany({
      where: {
        id,
        OR: where,
      },
    });

    if (result.count === 0) {
      throw new NotFoundException('Suppression not found');
    }

    return { deleted: true, id };
  }

  async getSuppressionScope(identity: MarketSignalIdentity) {
    const where = this.buildOwnerWhere(
      {
        userId: identity.userId,
        anonymousSessionId: identity.anonymousSessionId,
      },
      identity.anonymousSessionId ?? undefined,
    );

    const scope: MarketSuppressionScope = {
      targetKeys: new Set(),
      brandIds: new Set(),
      categoryIds: new Set(),
      sectionKeys: new Set(),
      suggestionBlockKeys: new Set(),
    };

    if (!where.length) return scope;

    const suppressions = await this.prisma.userContentSuppression.findMany({
      where: {
        AND: [{ OR: where }, this.activeWhere()],
      },
      select: {
        targetType: true,
        targetId: true,
        brandId: true,
        categoryId: true,
        sectionKey: true,
        suggestionBlockKey: true,
        suppressionType: true,
      },
      take: 500,
    });

    for (const suppression of suppressions) {
      this.addSuppressionToScope(scope, suppression);
    }

    return scope;
  }

  private addSuppressionToScope(
    scope: MarketSuppressionScope,
    suppression: Pick<
      UserContentSuppression,
      | 'targetType'
      | 'targetId'
      | 'brandId'
      | 'categoryId'
      | 'sectionKey'
      | 'suggestionBlockKey'
      | 'suppressionType'
    >,
  ) {
    if (suppression.targetId) {
      scope.targetKeys.add(
        this.targetKey(suppression.targetType, suppression.targetId),
      );
    }

    if (
      suppression.targetType === MarketSignalTargetType.BRAND ||
      suppression.suppressionType === MarketSuppressionType.HIDE_BRAND
    ) {
      const brandId = suppression.brandId ?? suppression.targetId;
      if (brandId) scope.brandIds.add(brandId);
    }

    if (
      suppression.targetType === MarketSignalTargetType.CATEGORY ||
      suppression.suppressionType === MarketSuppressionType.HIDE_CATEGORY
    ) {
      const categoryId = suppression.categoryId ?? suppression.targetId;
      if (categoryId) scope.categoryIds.add(categoryId);
    }

    if (
      suppression.targetType === MarketSignalTargetType.SECTION ||
      suppression.suppressionType === MarketSuppressionType.HIDE_SECTION
    ) {
      const sectionKey = suppression.sectionKey ?? suppression.targetId;
      if (sectionKey) scope.sectionKeys.add(sectionKey);
    }

    if (
      suppression.targetType === MarketSignalTargetType.SUGGESTION_BLOCK ||
      suppression.suppressionType ===
        MarketSuppressionType.HIDE_SUGGESTION_BLOCK
    ) {
      const blockKey = suppression.suggestionBlockKey ?? suppression.targetId;
      if (blockKey) scope.suggestionBlockKeys.add(blockKey);
    }
  }

  targetKey(targetType: MarketSignalTargetType | string, targetId: string) {
    return `${targetType}:${targetId}`;
  }

  private normalizeSuppression(
    dto: CreateMarketSuppressionDto,
  ): NormalizedMarketSuppression {
    const targetId = this.cleanToken(
      dto.targetId,
      'targetId',
      MARKET_SIGNAL_MAX_TARGET_ID_LENGTH,
    );
    const sectionKey =
      this.cleanToken(
        dto.sectionKey,
        'sectionKey',
        MARKET_SIGNAL_MAX_SECTION_KEY_LENGTH,
      ) ??
      (dto.targetType === MarketSignalTargetType.SECTION ? targetId : null);
    const suggestionBlockKey =
      this.cleanToken(
        dto.suggestionBlockKey,
        'suggestionBlockKey',
        MARKET_SIGNAL_MAX_SECTION_KEY_LENGTH,
      ) ??
      (dto.targetType === MarketSignalTargetType.SUGGESTION_BLOCK
        ? targetId
        : null);
    const brandId = this.cleanToken(
      dto.brandId,
      'brandId',
      MARKET_SIGNAL_MAX_TARGET_ID_LENGTH,
    );
    const categoryId = this.cleanToken(
      dto.categoryId,
      'categoryId',
      MARKET_SIGNAL_MAX_TARGET_ID_LENGTH,
    );

    if (
      !targetId &&
      !brandId &&
      !categoryId &&
      !sectionKey &&
      !suggestionBlockKey
    ) {
      throw new BadRequestException(
        'At least one suppression target is required',
      );
    }

    return {
      targetId,
      brandId,
      categoryId,
      sectionKey,
      suggestionBlockKey,
      reason: this.cleanToken(
        dto.reason,
        'reason',
        MARKET_SIGNAL_MAX_REASON_LENGTH,
      ),
      expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : null,
    };
  }

  private async aggregateSuppression(
    owner: { userId: string | null; anonymousSessionId: string | null },
    suppression: UserContentSuppression,
  ) {
    if (!this.aggregationService) return;

    const targetId =
      suppression.targetId ??
      suppression.brandId ??
      suppression.categoryId ??
      suppression.sectionKey ??
      suppression.suggestionBlockKey;
    if (!targetId) return;

    try {
      await this.aggregationService.aggregateBatch(
        [
          {
            targetType: suppression.targetType,
            targetId,
            signalType:
              suppression.suppressionType ===
              MarketSuppressionType.NOT_INTERESTED
                ? MarketSignalType.NOT_INTERESTED
                : MarketSignalType.HIDE,
            surface: MarketSignalSurface.MARKET_HOME,
            sectionKey: suppression.sectionKey,
            suggestionBlockKey: suppression.suggestionBlockKey,
          },
        ],
        owner,
      );
    } catch (error) {
      this.logger.warn(
        `Suppression aggregation failed; suppression was retained: ${
          (error as any)?.message || error
        }`,
      );
    }
  }

  private resolveOwner(identity: MarketSignalIdentity, dtoAnonymous?: string) {
    const userId = this.cleanToken(
      identity.userId,
      'userId',
      MARKET_SIGNAL_MAX_TARGET_ID_LENGTH,
    );
    if (userId) {
      return { userId, anonymousSessionId: null };
    }

    const anonymousSessionId = this.cleanToken(
      identity.anonymousSessionId ?? dtoAnonymous,
      'anonymousSessionId',
      MARKET_SIGNAL_MAX_TARGET_ID_LENGTH,
    );
    if (!anonymousSessionId) {
      throw new BadRequestException(
        'anonymousSessionId is required for guest suppressions',
      );
    }
    return { userId: null, anonymousSessionId };
  }

  private buildOwnerWhere(
    identity: MarketSignalIdentity,
    queryAnonymous?: string | null,
  ): Prisma.UserContentSuppressionWhereInput[] {
    const userId = this.cleanToken(
      identity.userId,
      'userId',
      MARKET_SIGNAL_MAX_TARGET_ID_LENGTH,
    );
    const anonymousSessionId = this.cleanToken(
      queryAnonymous ?? identity.anonymousSessionId,
      'anonymousSessionId',
      MARKET_SIGNAL_MAX_TARGET_ID_LENGTH,
    );
    const where: Prisma.UserContentSuppressionWhereInput[] = [];

    if (userId) return [{ userId }];
    if (anonymousSessionId) where.push({ anonymousSessionId });

    return where;
  }

  private activeWhere(): Prisma.UserContentSuppressionWhereInput {
    return {
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
    };
  }

  private clean(value: unknown) {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  private cleanToken(value: unknown, field: string, maxLength: number) {
    const cleaned = this.clean(value);
    if (!cleaned) return null;
    if (cleaned.length > maxLength) {
      throw new BadRequestException(
        `${field} cannot exceed ${maxLength} characters`,
      );
    }
    if (/[\u0000-\u001F\u007F]/.test(cleaned)) {
      throw new BadRequestException(`${field} contains unsupported characters`);
    }
    return cleaned;
  }
}
