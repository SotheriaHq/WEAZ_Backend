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
      { userId: identity.userId, anonymousSessionId: identity.anonymousSessionId },
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

  private normalizeSuppression(dto: CreateMarketSuppressionDto) {
    const targetId = this.clean(dto.targetId);
    const sectionKey =
      this.clean(dto.sectionKey) ??
      (dto.targetType === MarketSignalTargetType.SECTION ? targetId : null);
    const suggestionBlockKey =
      this.clean(dto.suggestionBlockKey) ??
      (dto.targetType === MarketSignalTargetType.SUGGESTION_BLOCK
        ? targetId
        : null);
    const brandId = this.clean(dto.brandId);
    const categoryId = this.clean(dto.categoryId);

    if (!targetId && !brandId && !categoryId && !sectionKey && !suggestionBlockKey) {
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
      reason: this.clean(dto.reason),
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
              suppression.suppressionType === MarketSuppressionType.NOT_INTERESTED
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
    const userId = this.clean(identity.userId);
    if (userId) {
      return { userId, anonymousSessionId: null };
    }

    const anonymousSessionId = this.clean(
      identity.anonymousSessionId ?? dtoAnonymous,
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
    const userId = this.clean(identity.userId);
    const anonymousSessionId = this.clean(
      queryAnonymous ?? identity.anonymousSessionId,
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
}
