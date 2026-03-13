import { Type } from 'class-transformer';
import {
  CustomOrderRetentionHoldType,
  CustomFabricRuleBasisStatus,
  CustomOrderDisputeResolution,
  CustomOrderDisputeStatus,
  CustomOrderProgressStage,
  CustomOrderStatus,
} from '@prisma/client';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class ReviewCustomFabricRuleBasisDto {
  @IsEnum(CustomFabricRuleBasisStatus)
  status: CustomFabricRuleBasisStatus;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  moderationNotes?: string;
}

export class QueryAdminCustomOrdersDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @IsOptional()
  @IsEnum(CustomOrderStatus)
  status?: CustomOrderStatus;

  @IsOptional()
  @IsEnum(CustomOrderProgressStage)
  stage?: CustomOrderProgressStage;

  @IsOptional()
  @IsString()
  brandId?: string;

  @IsOptional()
  @IsString()
  q?: string;
}

export class QueryStaleCustomOrdersDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @IsOptional()
  @IsString()
  brandId?: string;

  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  escalatedOnly?: boolean;
}

export class QueryCustomOrderDisputesDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @IsOptional()
  @IsEnum(CustomOrderDisputeStatus)
  status?: CustomOrderDisputeStatus;
}

export class QueryCustomOrderLedgerAllocationsDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @IsOptional()
  @IsString()
  customOrderId?: string;

  @IsOptional()
  @IsString()
  brandId?: string;

  @IsOptional()
  @IsString()
  payoutId?: string;
}

export class QueryCustomOrderRiskDashboardDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(90)
  days?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(25)
  limit?: number;

  @IsOptional()
  @IsString()
  brandId?: string;
}

export class QueryCustomOrderRefundReviewsDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @IsOptional()
  @IsString()
  brandId?: string;

  @IsOptional()
  @IsString()
  q?: string;

  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  includeSettled?: boolean;
}

export class UpdateCustomOrderDisputeDto {
  @IsOptional()
  @IsEnum(CustomOrderDisputeStatus)
  status?: CustomOrderDisputeStatus;

  @IsOptional()
  @IsEnum(CustomOrderDisputeResolution)
  resolution?: CustomOrderDisputeResolution;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  adminNotes?: string;

  @IsOptional()
  @IsString()
  assignedAdminId?: string;
}

export class AdminCustomOrderReminderDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class FlagCustomOrderRiskDto {
  @IsString()
  @MinLength(3)
  @MaxLength(120)
  reason: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}

export class EscalateCustomOrderRefundReviewDto {
  @IsString()
  @MinLength(3)
  @MaxLength(120)
  reason: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}

export class UpdateCustomOrderRetentionHoldDto {
  @IsBoolean()
  clear: boolean;

  @IsOptional()
  @IsEnum(CustomOrderRetentionHoldType)
  holdType?: CustomOrderRetentionHoldType;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  reason?: string;

  @IsOptional()
  @Type(() => Date)
  holdUntil?: Date;
}
