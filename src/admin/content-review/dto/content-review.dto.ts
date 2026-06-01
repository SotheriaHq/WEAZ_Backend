import {
  BrandContentReviewMode,
  BrandTrustTier,
  ContentEntityType,
  ContentReportReasonCode,
  ContentReportStatus,
  ContentReportTargetType,
  ContentReviewReasonCode,
  ContentSubmissionStatus,
} from '@prisma/client';
import { Transform } from 'class-transformer';
import {
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';

export class ContentReviewQueryDto {
  @IsOptional()
  @IsEnum(ContentSubmissionStatus)
  status?: ContentSubmissionStatus;

  @IsOptional()
  @IsEnum(ContentEntityType)
  entityType?: ContentEntityType;

  @IsOptional()
  @IsUUID()
  brandId?: string;

  @IsOptional()
  @IsEnum(BrandTrustTier)
  trustTier?: BrandTrustTier;

  @IsOptional()
  @IsEnum(BrandContentReviewMode)
  reviewMode?: BrandContentReviewMode;

  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  q?: string;

  @IsOptional()
  @IsString()
  cursor?: string;

  @IsOptional()
  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(1)
  @Max(100)
  take?: number;
}

export class ContentReviewDecisionDto {
  @IsOptional()
  @IsEnum(ContentReviewReasonCode)
  reasonCode?: ContentReviewReasonCode;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  reasonNote?: string;
}

export class ContentReportQueryDto {
  @IsOptional()
  @IsEnum(ContentReportStatus)
  status?: ContentReportStatus;

  @IsOptional()
  @IsEnum(ContentReportTargetType)
  targetType?: ContentReportTargetType;

  @IsOptional()
  @IsUUID()
  targetId?: string;

  @IsOptional()
  @IsUUID()
  mediaId?: string;

  @IsOptional()
  @IsEnum(ContentReportReasonCode)
  reasonCode?: ContentReportReasonCode;

  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;

  @IsOptional()
  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(1)
  @Max(100)
  take?: number;
}

export class ContentReportCreateDto {
  @IsEnum(ContentReportTargetType)
  targetType!: ContentReportTargetType;

  @IsUUID()
  targetId!: string;

  @IsOptional()
  @IsUUID()
  mediaId?: string;

  @IsEnum(ContentReportReasonCode)
  reasonCode!: ContentReportReasonCode;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}

export class ContentReportResolutionDto {
  @IsEnum(ContentReportStatus)
  status!: ContentReportStatus;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  @ValidateIf((dto) => dto.status !== ContentReportStatus.DISMISSED)
  resolution?: string;
}

export class BrandTrustOverrideDto {
  @IsOptional()
  @IsEnum(BrandTrustTier)
  trustTier?: BrandTrustTier;

  @IsOptional()
  @IsEnum(BrandContentReviewMode)
  reviewMode?: BrandContentReviewMode;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  reason?: string;
}
