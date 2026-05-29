import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsDateString,
  IsEnum,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import {
  MarketSignalSurface,
  MarketSignalTargetType,
  MarketSignalType,
  MarketSuppressionType,
} from '@prisma/client';

export const MARKET_SIGNAL_MAX_BATCH_EVENTS = 50;
export const MARKET_SIGNAL_MAX_METADATA_BYTES = 2048;
export const MARKET_SIGNAL_MAX_SECTION_KEY_LENGTH = 80;
export const MARKET_SIGNAL_MAX_TARGET_ID_LENGTH = 128;
export const MARKET_SIGNAL_MAX_SCREEN_CONTEXT_LENGTH = 120;
export const MARKET_SIGNAL_MAX_REASON_LENGTH = 240;

export class MarketSignalEventDto {
  @IsString()
  @MaxLength(MARKET_SIGNAL_MAX_TARGET_ID_LENGTH)
  clientEventId!: string;

  @IsEnum(MarketSignalTargetType)
  targetType!: MarketSignalTargetType;

  @IsString()
  @MaxLength(MARKET_SIGNAL_MAX_TARGET_ID_LENGTH)
  targetId!: string;

  @IsEnum(MarketSignalType)
  signalType!: MarketSignalType;

  @IsEnum(MarketSignalSurface)
  surface!: MarketSignalSurface;

  @IsOptional()
  @IsNumber()
  value?: number;

  @IsOptional()
  @IsString()
  @MaxLength(MARKET_SIGNAL_MAX_SECTION_KEY_LENGTH)
  sectionKey?: string;

  @IsOptional()
  @IsString()
  @MaxLength(MARKET_SIGNAL_MAX_SECTION_KEY_LENGTH)
  suggestionBlockKey?: string;

  @IsOptional()
  @IsString()
  @MaxLength(MARKET_SIGNAL_MAX_SCREEN_CONTEXT_LENGTH)
  screenContext?: string;

  @IsOptional()
  @IsString()
  @MaxLength(MARKET_SIGNAL_MAX_TARGET_ID_LENGTH)
  sessionId?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  position?: number;

  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}

export class MarketSignalBatchDto {
  @IsOptional()
  @IsString()
  @MaxLength(MARKET_SIGNAL_MAX_TARGET_ID_LENGTH)
  batchId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(MARKET_SIGNAL_MAX_TARGET_ID_LENGTH)
  anonymousSessionId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(MARKET_SIGNAL_MAX_TARGET_ID_LENGTH)
  sessionId?: string;

  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(MARKET_SIGNAL_MAX_BATCH_EVENTS)
  @ValidateNested({ each: true })
  @Type(() => MarketSignalEventDto)
  events!: MarketSignalEventDto[];
}

export class CreateMarketSuppressionDto {
  @IsOptional()
  @IsString()
  @MaxLength(MARKET_SIGNAL_MAX_TARGET_ID_LENGTH)
  anonymousSessionId?: string;

  @IsEnum(MarketSignalTargetType)
  targetType!: MarketSignalTargetType;

  @IsOptional()
  @IsString()
  @MaxLength(MARKET_SIGNAL_MAX_TARGET_ID_LENGTH)
  targetId?: string;

  @IsOptional()
  @IsUUID()
  brandId?: string;

  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(MARKET_SIGNAL_MAX_SECTION_KEY_LENGTH)
  sectionKey?: string;

  @IsOptional()
  @IsString()
  @MaxLength(MARKET_SIGNAL_MAX_SECTION_KEY_LENGTH)
  suggestionBlockKey?: string;

  @IsEnum(MarketSuppressionType)
  suppressionType!: MarketSuppressionType;

  @IsOptional()
  @IsString()
  @MaxLength(MARKET_SIGNAL_MAX_REASON_LENGTH)
  reason?: string;

  @IsOptional()
  @IsDateString()
  expiresAt?: string;
}

export class MarketSuppressionQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(MARKET_SIGNAL_MAX_TARGET_ID_LENGTH)
  anonymousSessionId?: string;
}
