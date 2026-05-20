import { IsEnum, IsOptional, IsString, IsUUID } from 'class-validator';
import {
  FabricStretch,
  FitPreference,
  FitType,
  GarmentCategory,
  RecommendationConfidenceLabel,
  SizingRegion,
} from '@prisma/client';

export class ProductSizeRecommendationQueryDto {
  @IsOptional()
  @IsUUID('4')
  variantId?: string;

  @IsOptional()
  @IsEnum(SizingRegion)
  region?: SizingRegion;

  @IsOptional()
  @IsString()
  selectedSize?: string;
}

export interface SizeRecommendationResponseDto {
  estimatedSize: string | null;
  recommendedSize: string | null;
  displayRange: string | null;
  alternativeSize: string | null;
  confidenceScore: number;
  confidenceLabel: RecommendationConfidenceLabel;
  reasons: string[];
  warnings: string[];
  chartSource: string | null;
  chartVersion: number | null;
  chartId?: string | null;
  chartVersionId?: string | null;
  selectedRegion: SizingRegion;
  garmentCategory: GarmentCategory;
  manualOverrideAllowed: boolean;
  missingMeasurements: string[];
  usedMeasurements: string[];
  fallbackUsed: boolean;
  staleMeasurementWarning?: boolean;
  sizeChartUnavailable?: boolean;
  normalizedMeasurements?: Record<string, number>;
  userFitPreference?: FitPreference | string | null;
  productFitType?: FitType | null;
  fabricStretch?: FabricStretch | null;
}
