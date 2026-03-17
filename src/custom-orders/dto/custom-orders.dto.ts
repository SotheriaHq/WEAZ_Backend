import { Type } from 'class-transformer';
import {
  CustomOrderExtensionResponseStatus,
  CustomOrderExtensionTargetType,
  CustomOrderIssueType,
  CustomOrderProgressStage,
  CustomOrderStatus,
  PaymentMethod,
} from '@prisma/client';
import {
  IsBoolean,
  IsEmail,
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

export type CustomOrderChartFamily = 'UK' | 'US' | 'NIGERIA' | 'ASIA' | 'HYBRID_UK_NIGERIA';
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

export class InitializeCustomOrderPaymentDto {
  @IsEnum(PaymentMethod)
  paymentMethod: PaymentMethod;

  @IsEmail()
  email: string;

  @IsOptional()
  @IsString()
  callbackUrl?: string;

  @IsOptional()
  @IsObject()
  paymentData?: Record<string, unknown>;

  @IsString()
  @MaxLength(120)
  idempotencyKey: string;
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

export class CancelCustomOrderDto {
  @IsString()
  @MinLength(3)
  @MaxLength(300)
  reason: string;
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
  @Max(7)
  counterDays?: number;
}

export class AcceptCustomOrderDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class RejectCustomOrderDto {
  @IsString()
  @MinLength(5)
  @MaxLength(500)
  reason: string;
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
  @Max(7)
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
