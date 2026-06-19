import { PartialType } from '@nestjs/mapped-types';
import {
  CustomOrderSourceType,
  FabricSourcingMode,
  Gender,
} from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsNumber,
  IsPositive,
  IsNumberString,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

export class CreateCustomFabricRuleDto {
  @IsInt()
  @Min(1)
  priority: number;

  @IsObject()
  conditionsJson: Record<string, unknown>;

  @IsNumberString()
  outputYards: string;

  @IsOptional()
  @IsBoolean()
  isFallback?: boolean;
}

export class CustomOrderConfigurationSizeExtraYardDto {
  @IsString()
  @Length(1, 60)
  sizeLabel: string;

  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  extraYards: number;
}

export class CreateCustomOrderConfigurationDto {
  @IsEnum(CustomOrderSourceType)
  sourceType: CustomOrderSourceType;

  @IsUUID()
  sourceId: string;

  @IsOptional()
  @IsString()
  @Length(3, 120)
  title?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  buyerInstructionText?: string;

  @IsArray()
  @IsString({ each: true })
  requiredMeasurementKeys: string[];

  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  requiredFreeformPointIds?: string[];

  @IsOptional()
  @Transform(({ value }) => {
    if (typeof value !== 'string') {
      return value;
    }
    const normalized = value.trim();
    return normalized.length > 0 ? normalized : undefined;
  })
  @IsUUID()
  fabricRuleBasisId?: string;

  @IsNumberString()
  baseProductionCharge: string;

  @IsNumberString()
  fabricCostPerYard: string;

  @IsBoolean()
  rushEnabled: boolean;

  @IsOptional()
  @IsNumberString()
  rushFee?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(3)
  rushProductionLeadDays?: number;

  @IsInt()
  @Min(1)
  @Max(7)
  productionLeadDays: number;

  @IsInt()
  @Min(2)
  @Max(14)
  deliveryMinDays: number;

  @IsInt()
  @Min(2)
  @Max(14)
  deliveryMaxDays: number;

  @IsString()
  @MaxLength(100)
  deliveryScope: string;

  @IsString()
  @MaxLength(1500)
  revisionPolicy: string;

  @IsString()
  @MaxLength(1500)
  returnPolicy: string;

  @IsString()
  @MaxLength(1500)
  defectPolicy: string;

  @IsEnum(FabricSourcingMode)
  fabricSourcingMode: FabricSourcingMode;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  averageBaseYards?: number;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CustomOrderConfigurationSizeExtraYardDto)
  sizeExtraYards?: CustomOrderConfigurationSizeExtraYardDto[];

  @ValidateNested({ each: true })
  @Type(() => CreateCustomFabricRuleDto)
  rules: CreateCustomFabricRuleDto[];
}

export class UpdateCustomOrderConfigurationDto extends PartialType(
  CreateCustomOrderConfigurationDto,
) {}

export class QueryVisibleCustomOrderConfigurationsDto {
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
  @Type(() => Boolean)
  @IsBoolean()
  isActive?: boolean;
}

export class CreateCustomFabricRuleBasisDto {
  @IsString()
  @Length(3, 120)
  label: string;

  @IsArray()
  @IsString({ each: true })
  measurementKeys: string[];

  @IsOptional()
  @IsEnum(Gender)
  gender?: Gender;
}

export class QueryCustomFabricRuleBasesDto {
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  includeBrandOnly?: boolean;
}
