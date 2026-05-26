import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { AdminAuditAction } from '@prisma/client';
import {
  MARKET_GOVERNANCE_LIMITS,
  SUPPORTED_FORMULA_STATUSES,
  SUPPORTED_MARKET_SECTION_KEYS,
  SUPPORTED_SUGGESTION_CONTEXTS,
  SUPPORTED_SUGGESTION_SOURCE_TYPES,
  SUPPORTED_SUGGESTION_TARGET_TYPES,
} from 'src/market/market-governance-config.service';

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,79}$/;

export class AdminMarketGovernanceReasonDto {
  @IsOptional()
  @IsString()
  @MaxLength(MARKET_GOVERNANCE_LIMITS.reasonMax)
  reason?: string;
}

export class PatchMarketSectionConfigDto extends AdminMarketGovernanceReasonDto {
  @IsOptional()
  @IsString()
  @MaxLength(MARKET_GOVERNANCE_LIMITS.sectionTitleMax)
  title?: string;

  @IsOptional()
  @IsString()
  @MaxLength(MARKET_GOVERNANCE_LIMITS.sectionSubtitleMax)
  subtitle?: string;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(MARKET_GOVERNANCE_LIMITS.displayOrderMin)
  @Max(MARKET_GOVERNANCE_LIMITS.displayOrderMax)
  displayOrder?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(MARKET_GOVERNANCE_LIMITS.previewItemLimitMin)
  @Max(MARKET_GOVERNANCE_LIMITS.previewItemLimitMax)
  previewItemLimit?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(MARKET_GOVERNANCE_LIMITS.detailPageLimitMin)
  @Max(MARKET_GOVERNANCE_LIMITS.detailPageLimitMax)
  detailPageLimit?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(MARKET_GOVERNANCE_LIMITS.minimumItemsMin)
  @Max(MARKET_GOVERNANCE_LIMITS.minimumItemsMax)
  minimumItems?: number;

  @IsOptional()
  @IsBoolean()
  viewAllEnabled?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  fallbackMode?: string;

  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}

export class CreateMarketRankingProfileDto extends AdminMarketGovernanceReasonDto {
  @IsString()
  @MaxLength(MARKET_GOVERNANCE_LIMITS.profileKeyMax)
  @Matches(SLUG_PATTERN)
  profileKey!: string;

  @IsString()
  @MaxLength(MARKET_GOVERNANCE_LIMITS.nameMax)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(MARKET_GOVERNANCE_LIMITS.descriptionMax)
  description?: string;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsBoolean()
  shadowMode?: boolean;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsIn(SUPPORTED_MARKET_SECTION_KEYS as unknown as string[], { each: true })
  sectionKeys?: string[];

  @IsOptional()
  @IsString()
  formulaVersionId?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(MARKET_GOVERNANCE_LIMITS.explorationPercentMin)
  @Max(MARKET_GOVERNANCE_LIMITS.explorationPercentMax)
  explorationPercent?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(MARKET_GOVERNANCE_LIMITS.brandMaxShareMin)
  @Max(MARKET_GOVERNANCE_LIMITS.brandMaxShareMax)
  brandMaxShare?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(MARKET_GOVERNANCE_LIMITS.aggregateTimeoutMsMin)
  @Max(MARKET_GOVERNANCE_LIMITS.aggregateTimeoutMsMax)
  aggregateTimeoutMs?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(MARKET_GOVERNANCE_LIMITS.rolloutPercentMin)
  @Max(MARKET_GOVERNANCE_LIMITS.rolloutPercentMax)
  rolloutPercent?: number;

  @IsOptional()
  @IsBoolean()
  fallbackDeterministic?: boolean;

  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}

export class PatchMarketRankingProfileDto extends AdminMarketGovernanceReasonDto {
  @IsOptional()
  @IsString()
  @MaxLength(MARKET_GOVERNANCE_LIMITS.nameMax)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(MARKET_GOVERNANCE_LIMITS.descriptionMax)
  description?: string;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsBoolean()
  shadowMode?: boolean;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsIn(SUPPORTED_MARKET_SECTION_KEYS as unknown as string[], { each: true })
  sectionKeys?: string[];

  @IsOptional()
  @IsString()
  formulaVersionId?: string | null;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(MARKET_GOVERNANCE_LIMITS.explorationPercentMin)
  @Max(MARKET_GOVERNANCE_LIMITS.explorationPercentMax)
  explorationPercent?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(MARKET_GOVERNANCE_LIMITS.brandMaxShareMin)
  @Max(MARKET_GOVERNANCE_LIMITS.brandMaxShareMax)
  brandMaxShare?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(MARKET_GOVERNANCE_LIMITS.aggregateTimeoutMsMin)
  @Max(MARKET_GOVERNANCE_LIMITS.aggregateTimeoutMsMax)
  aggregateTimeoutMs?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(MARKET_GOVERNANCE_LIMITS.rolloutPercentMin)
  @Max(MARKET_GOVERNANCE_LIMITS.rolloutPercentMax)
  rolloutPercent?: number;

  @IsOptional()
  @IsBoolean()
  fallbackDeterministic?: boolean;

  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}

export class CreateMarketRankingFormulaDto extends AdminMarketGovernanceReasonDto {
  @IsString()
  @MaxLength(MARKET_GOVERNANCE_LIMITS.versionKeyMax)
  @Matches(SLUG_PATTERN)
  versionKey!: string;

  @IsString()
  @MaxLength(MARKET_GOVERNANCE_LIMITS.nameMax)
  name!: string;

  @IsOptional()
  @IsIn(SUPPORTED_FORMULA_STATUSES as unknown as string[])
  status?: string;

  @IsObject()
  weights!: Record<string, unknown>;

  @IsOptional()
  @IsObject()
  bounds?: Record<string, unknown>;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}

export class CreateMarketSuggestionBlockConfigDto extends AdminMarketGovernanceReasonDto {
  @IsString()
  @MaxLength(MARKET_GOVERNANCE_LIMITS.suggestionBlockKeyMax)
  @Matches(/^[a-z0-9][a-z0-9-]{0,119}$/)
  blockKey!: string;

  @IsIn(SUPPORTED_SUGGESTION_CONTEXTS as unknown as string[])
  context!: string;

  @IsIn(SUPPORTED_SUGGESTION_TARGET_TYPES as unknown as string[])
  targetType!: string;

  @IsString()
  @MaxLength(MARKET_GOVERNANCE_LIMITS.nameMax)
  title!: string;

  @IsOptional()
  @IsString()
  @MaxLength(MARKET_GOVERNANCE_LIMITS.sectionSubtitleMax)
  subtitle?: string;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(MARKET_GOVERNANCE_LIMITS.displayOrderMin)
  @Max(MARKET_GOVERNANCE_LIMITS.displayOrderMax)
  displayOrder?: number;

  @IsIn(SUPPORTED_SUGGESTION_SOURCE_TYPES as unknown as string[])
  sourceType!: string;

  @IsOptional()
  @IsIn(SUPPORTED_SUGGESTION_SOURCE_TYPES as unknown as string[])
  fallbackSourceType?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(MARKET_GOVERNANCE_LIMITS.suggestionItemLimitMin)
  @Max(MARKET_GOVERNANCE_LIMITS.suggestionItemLimitMax)
  itemLimit?: number;

  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}

export class PatchMarketSuggestionBlockConfigDto extends AdminMarketGovernanceReasonDto {
  @IsOptional()
  @IsIn(SUPPORTED_SUGGESTION_CONTEXTS as unknown as string[])
  context?: string;

  @IsOptional()
  @IsIn(SUPPORTED_SUGGESTION_TARGET_TYPES as unknown as string[])
  targetType?: string;

  @IsOptional()
  @IsString()
  @MaxLength(MARKET_GOVERNANCE_LIMITS.nameMax)
  title?: string;

  @IsOptional()
  @IsString()
  @MaxLength(MARKET_GOVERNANCE_LIMITS.sectionSubtitleMax)
  subtitle?: string;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(MARKET_GOVERNANCE_LIMITS.displayOrderMin)
  @Max(MARKET_GOVERNANCE_LIMITS.displayOrderMax)
  displayOrder?: number;

  @IsOptional()
  @IsIn(SUPPORTED_SUGGESTION_SOURCE_TYPES as unknown as string[])
  sourceType?: string;

  @IsOptional()
  @IsIn(SUPPORTED_SUGGESTION_SOURCE_TYPES as unknown as string[])
  fallbackSourceType?: string | null;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(MARKET_GOVERNANCE_LIMITS.suggestionItemLimitMin)
  @Max(MARKET_GOVERNANCE_LIMITS.suggestionItemLimitMax)
  itemLimit?: number;

  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}

export class AdminMarketGovernanceAuditQueryDto {
  @IsOptional()
  @IsString()
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @IsOptional()
  @IsIn(Object.values(AdminAuditAction))
  action?: AdminAuditAction;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  targetType?: string;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  targetId?: string;
}

export class MarketGovernanceRollbackDto extends AdminMarketGovernanceReasonDto {}
