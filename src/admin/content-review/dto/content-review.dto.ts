import {
  BrandContentReviewMode,
  BrandTrustTier,
  ContentEntityType,
  ContentReviewReasonCode,
  ContentSubmissionStatus,
} from '@prisma/client';
import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';

export class ContentReviewQueryDto {
  @IsOptional()
  @IsEnum(ContentSubmissionStatus)
  status?: ContentSubmissionStatus;

  @IsOptional()
  @IsEnum(ContentEntityType)
  entityType?: ContentEntityType;
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
