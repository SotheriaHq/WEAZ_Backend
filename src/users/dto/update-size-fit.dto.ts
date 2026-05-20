import {
  IsEnum,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';

export enum LengthUnitDto {
  CM = 'CM',
  IN = 'IN',
}

export enum WeightUnitDto {
  KG = 'KG',
  LBS = 'LBS',
}

export enum FitPreferenceDto {
  SLIM = 'SLIM',
  REGULAR = 'REGULAR',
  LOOSE = 'LOOSE',
  OVERSIZED = 'OVERSIZED',
}

export enum SizingRegionDto {
  NG_WEST_AFRICA = 'NG_WEST_AFRICA',
  UK = 'UK',
  US = 'US',
  EU = 'EU',
  INTERNATIONAL = 'INTERNATIONAL',
}

export enum AutoSizeRecommendationModeDto {
  ON = 'ON',
  OFF = 'OFF',
  ASK_EVERY_TIME = 'ASK_EVERY_TIME',
}

export class UpdateSizeFitDto {
  @IsOptional()
  @IsObject()
  measurements?: Record<string, unknown>;

  @IsOptional()
  @IsString()
  notes?: string;

  @IsOptional()
  @IsInt()
  @Min(14)
  @Max(90)
  requireUpdateEveryDays?: number;

  @IsOptional()
  @IsString()
  label?: string;

  @IsOptional()
  @IsEnum(LengthUnitDto)
  preferredLengthUnit?: LengthUnitDto;

  @IsOptional()
  @IsEnum(WeightUnitDto)
  preferredWeightUnit?: WeightUnitDto;

  @IsOptional()
  @IsEnum(FitPreferenceDto)
  fitPreference?: FitPreferenceDto;

  @IsOptional()
  @IsEnum(SizingRegionDto)
  preferredSizingRegion?: SizingRegionDto;

  @IsOptional()
  @IsEnum(AutoSizeRecommendationModeDto)
  autoSizeRecommendation?: AutoSizeRecommendationModeDto;

  @IsOptional()
  @IsInt()
  @Min(0)
  version?: number;
}
