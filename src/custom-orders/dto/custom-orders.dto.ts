import { Type } from 'class-transformer';
import {
  CustomOrderExtensionResponseStatus,
  CustomOrderExtensionTargetType,
  CustomOrderIssueType,
  CustomOrderProgressStage,
  CustomOrderStatus,
} from '@prisma/client';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export type CustomOrderChartFamily =
  | 'UK'
  | 'US'
  | 'NIGERIA'
  | 'ASIA'
  | 'HYBRID_UK_NIGERIA'
  | 'HYBRID_US_NIGERIA';
export type CustomOrderResolverPolicy =
  | 'PRIMARY_ONLY'
  | 'MAX_OF_BOTH'
  | 'WEIGHTED_AVERAGE_TO_NEAREST_BAND';

export class CustomOrderPricePreviewDto {
  @IsUUID()
  configurationId: string;

  @IsOptional()
  @IsUUID()
  configurationVersionId?: string;

  @IsObject()
  measurementValues: Record<string, number>;

  @IsOptional()
  @IsBoolean()
  rushSelected?: boolean;

  @IsOptional()
  @IsObject()
  shippingAddress?: Record<string, unknown>;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  idempotencyKey?: string;

  @IsOptional()
  @IsString()
  pricingChartFamily?: CustomOrderChartFamily;

  @IsOptional()
  @IsString()
  displayChartFamily?: CustomOrderChartFamily;

  @IsOptional()
  @IsString()
  resolverPolicy?: CustomOrderResolverPolicy;
}

export class CreateCustomOrderDto {
  @IsUUID()
  checkoutIntentId: string;

  @IsUUID()
  configurationId: string;

  @IsOptional()
  @IsUUID()
  configurationVersionId?: string;

  @IsObject()
  measurementValues: Record<string, number>;

  @IsBoolean()
  rushSelected: boolean;

  @IsObject()
  shippingAddress: Record<string, unknown>;

  @IsObject()
  contactInfo: Record<string, unknown>;

  @IsString()
  @Length(3, 120)
  customerName: string;

  @IsString()
  @MaxLength(120)
  idempotencyKey: string;

  @IsOptional()
  @IsBoolean()
  noDirectMatchAcknowledged?: boolean;
}

export class UpdateDisplayChartPreferenceDto {
  @IsString()
  displayChartFamily: CustomOrderChartFamily;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  updatedAtMs?: number;
}

export class CreateExceptionReviewRequestDto {
  @IsString()
  @MinLength(5)
  @MaxLength(500)
  reason: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  requestedQuoteTotal?: string;
}

export class VerifyCustomOrderPaymentDto {
  @IsString()
  reference: string;

  @IsString()
  gateway: string;

  @IsOptional()
  @IsString()
  otp?: string;

  @IsOptional()
  @IsString()
  statusHint?: string;
}

export class ConfirmCustomOrderDeliveryDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class ReportCustomOrderIssueDto {
  @IsEnum(CustomOrderIssueType)
  issueType: CustomOrderIssueType;

  @IsString()
  @MinLength(10)
  @MaxLength(2000)
  description: string;

  @IsOptional()
  @IsObject()
  evidenceJson?: Record<string, unknown>;
}

export class RespondToCustomOrderDisputeDto {
  // The brand's single, structured response to an admin-adjudicated dispute.
  // Brands may submit this exactly once; it is read-only to them afterward.
  @IsString()
  @MinLength(5)
  @MaxLength(2000)
  response: string;
}

export class UpdateCustomOrderMeasurementsDto {
  @IsObject()
  measurementValues: Record<string, number>;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class RespondToCustomOrderExtensionDto {
  @IsEnum(CustomOrderExtensionResponseStatus)
  response: CustomOrderExtensionResponseStatus;

  @IsOptional()
  @IsInt()
  @Min(1)
  // Policy cap: no single grant exceeds three days (EXTENSION_POLICY).
  @Max(3)
  counterDays?: number;

  /**
   * Optional on purpose. Requiring a reason to decline is a way of discouraging
   * declining, and the shopper already has the harder job in this exchange.
   */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class AcceptCustomOrderDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class UpdateCustomOrderProgressStageDto {
  @IsEnum(CustomOrderProgressStage)
  stage: CustomOrderProgressStage;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}

export class CreateCustomOrderExtensionRequestDto {
  @IsEnum(CustomOrderExtensionTargetType)
  targetType: CustomOrderExtensionTargetType;

  @IsInt()
  @Min(1)
  // Policy cap: three days per request, six per order, two requests maximum.
  // The remaining budget is re-checked in `assertExtensionRequestAllowed`.
  @Max(3)
  requestedExtraDays: number;

  @IsString()
  @MinLength(5)
  @MaxLength(1000)
  reason: string;
}

export class BrandRespondToCustomOrderExtensionCounterDto {
  @IsEnum(CustomOrderExtensionResponseStatus)
  response: CustomOrderExtensionResponseStatus;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class UpdateCustomOrderLifecycleStatusDto {
  @IsEnum(CustomOrderStatus)
  status: CustomOrderStatus;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class QueryCustomOrdersDto {
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
  q?: string;
}
