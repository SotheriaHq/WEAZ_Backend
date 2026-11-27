import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
  IsISO8601,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
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
export const MARKET_SIGNAL_MAX_VISIBLE_MS = 3_600_000;
export const MARKET_SIGNAL_MAX_INSTANT_LENGTH = 40;
export const MARKET_SIGNAL_MAX_POLICY_VERSION_LENGTH = 40;
export const MARKET_SIGNAL_POLICY_VERSION_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9_.@:-]{0,39}$/;

// Optional telemetry instants must be complete ISO-8601 timestamps.
const STRICT_ISO = { strict: true, strictSeparator: true } as const;

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

  // Optional telemetry: absent on existing clients, always validated when sent.

  /** Device-clock instant of the interaction. */
  @IsOptional()
  @IsString()
  @MaxLength(MARKET_SIGNAL_MAX_INSTANT_LENGTH)
  @IsISO8601(STRICT_ISO)
  occurredAt?: string;

  /** Milliseconds the card was visible when the impression was recorded. */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MARKET_SIGNAL_MAX_VISIBLE_MS)
  visibleMs?: number;

  /** Feature epoch the item was served from, echoed from the server. */
  @IsOptional()
  @IsString()
  @MaxLength(MARKET_SIGNAL_MAX_INSTANT_LENGTH)
  @IsISO8601(STRICT_ISO)
  epoch?: string;

  @IsOptional()
  @IsString()
  @MaxLength(MARKET_SIGNAL_MAX_POLICY_VERSION_LENGTH)
  @Matches(MARKET_SIGNAL_POLICY_VERSION_PATTERN)
  policyVersion?: string;

  @IsOptional()
  @IsBoolean()
  explore?: boolean;
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

  /** Device-clock send instant; lets the server measure delivery delay. */
  @IsOptional()
  @IsString()
  @MaxLength(MARKET_SIGNAL_MAX_INSTANT_LENGTH)
  @IsISO8601(STRICT_ISO)
  sentAt?: string;

  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(MARKET_SIGNAL_MAX_BATCH_EVENTS)
  @ValidateNested({ each: true })
  @Type(() => MarketSignalEventDto)
  events!: MarketSignalEventDto[];
}

export class MarketSignalSingleDto extends MarketSignalEventDto {
  @IsOptional()
  @IsString()
  @MaxLength(MARKET_SIGNAL_MAX_TARGET_ID_LENGTH)
  batchId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(MARKET_SIGNAL_MAX_INSTANT_LENGTH)
  @IsISO8601(STRICT_ISO)
  sentAt?: string;

  @IsOptional()
  @IsString()
  @MaxLength(MARKET_SIGNAL_MAX_TARGET_ID_LENGTH)
  anonymousSessionId?: string;
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
