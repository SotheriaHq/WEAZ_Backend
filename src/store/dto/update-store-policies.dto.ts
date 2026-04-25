import {
  IsArray,
  IsBoolean,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  ValidateIf,
} from 'class-validator';

export class UpdateStorePoliciesDto {
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  shippingRegions?: string[];

  @IsOptional()
  @IsString()
  processingTime?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  shippingMethods?: string[];

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsNumber()
  freeShippingThreshold?: number | null;

  @IsOptional()
  @IsBoolean()
  returnsAccepted?: boolean;

  @IsOptional()
  @IsString()
  returnWindow?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  returnConditions?: string[];

  @IsOptional()
  @IsString()
  refundMethod?: string;

  @IsOptional()
  @IsString()
  responseTimeSla?: string;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsObject()
  sizeChart?: Record<string, any> | null;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsObject()
  shippingRules?: Record<string, any> | null;
}
