import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import type {
  MarketSectionItemDto,
  MarketSectionLayout,
  MarketSectionSourceType,
} from './market-section.dto';

export enum MarketSuggestionContext {
  PRODUCT_DETAIL = 'PRODUCT_DETAIL',
  COLLECTION_DETAIL = 'COLLECTION_DETAIL',
  BRAND_DETAIL = 'BRAND_DETAIL',
  BRAND_STORE = 'BRAND_STORE',
  SEARCH_EMPTY = 'SEARCH_EMPTY',
  MARKET_SECTION_DETAIL = 'MARKET_SECTION_DETAIL',
  WISHLIST = 'WISHLIST',
}

export enum MarketSuggestionTargetType {
  PRODUCT = 'PRODUCT',
  COLLECTION = 'COLLECTION',
  BRAND = 'BRAND',
  CATEGORY = 'CATEGORY',
  SECTION = 'SECTION',
  QUERY = 'QUERY',
}

export type MarketSuggestionLayout =
  | MarketSectionLayout
  | 'COMPACT_RAIL'
  | 'MIXED_GRID';

export type MarketSuggestionSourceType = MarketSectionSourceType;

export const MARKET_SUGGESTION_DEFAULT_LIMIT = 8;
export const MARKET_SUGGESTION_MAX_LIMIT = 12;
export const MARKET_SUGGESTION_MAX_CURSOR_LENGTH = 160;
export const MARKET_SUGGESTION_MAX_QUERY_LENGTH = 120;
export const MARKET_SUGGESTION_MAX_TARGET_ID_LENGTH = 128;
export const MARKET_SUGGESTION_MAX_SECTION_KEY_LENGTH = 80;

export class MarketSuggestionQueryDto {
  @IsEnum(MarketSuggestionContext)
  context!: MarketSuggestionContext;

  @IsOptional()
  @IsEnum(MarketSuggestionTargetType)
  targetType?: MarketSuggestionTargetType;

  @IsOptional()
  @IsString()
  @MaxLength(MARKET_SUGGESTION_MAX_TARGET_ID_LENGTH)
  targetId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(MARKET_SUGGESTION_MAX_SECTION_KEY_LENGTH)
  sectionKey?: string;

  @IsOptional()
  @IsString()
  @MaxLength(MARKET_SUGGESTION_MAX_QUERY_LENGTH)
  query?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  limit?: number;

  @IsOptional()
  @IsString()
  @MaxLength(MARKET_SUGGESTION_MAX_CURSOR_LENGTH)
  cursor?: string;

  @IsOptional()
  @IsString()
  @MaxLength(MARKET_SUGGESTION_MAX_TARGET_ID_LENGTH)
  anonymousSessionId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  excludeIds?: string;
}

export interface MarketSuggestionPaginationDto {
  limit: number;
  hasNextPage: boolean;
  nextCursor: string | null;
}

export interface MarketSuggestionBlockMetadataDto {
  strategy: string;
  fallbackUsed: boolean;
  fallbackReason: string | null;
  personalization: 'disabled';
  ranking: 'deterministic-v1';
}

export interface MarketSuggestionResponseMetadataDto {
  version: 'phase11b.v1' | 'phase3.foundation.v1';
  personalization: 'disabled';
  cachePolicy: 'private-no-store';
  fallbackUsed: boolean;
  fallbackReason: string | null;
  contextsDeferred: MarketSuggestionContext[];
}

export interface MarketSuggestionBlockDto {
  blockKey: string;
  title: string;
  subtitle: string | null;
  reason: string | null;
  layout: MarketSuggestionLayout;
  sourceType: MarketSuggestionSourceType;
  items: MarketSuggestionItemDto[];
  pagination: MarketSuggestionPaginationDto;
  metadata: MarketSuggestionBlockMetadataDto;
}

export type MarketSuggestionItemDto = MarketSectionItemDto;

export interface MarketSuggestionResponseDto {
  generatedAt: string;
  context: MarketSuggestionContext;
  targetType: MarketSuggestionTargetType | null;
  targetId: string | null;
  sectionKey: string | null;
  query: string | null;
  blocks: MarketSuggestionBlockDto[];
  metadata: MarketSuggestionResponseMetadataDto;
}
