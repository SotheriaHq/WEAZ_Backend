import { IsEnum, IsOptional, IsString, IsUUID } from 'class-validator';
import type { MeasurementProblem } from '../measurement-integrity';
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
  /**
   * Measurements withheld from the computation because they cannot describe a
   * body, each named and explained. Non-empty means the shopper has something
   * to correct — a client should surface these against the offending field
   * rather than only reporting the absence of a size.
   */
  measurementProblems?: MeasurementProblem[];
  /**
   * True when the measurement that DESIGNATES this garment's size (chest for a
   * top, waist for a bottom) is missing or untrusted. No size is emitted in
   * that case: a guess assembled from trim measurements is worse than silence.
   */
  primaryMeasurementUnavailable?: boolean;
  /**
   * True when the primary girths that designate this garment vote more than
   * three size steps apart. A size is still emitted (the primary-gated row);
   * the warning names the two measurements. Lengths never set this flag.
   */
  measurementsDisagree?: boolean;
  normalizedMeasurements?: Record<string, number>;
  userFitPreference?: FitPreference | string | null;
  productFitType?: FitType | null;
  fabricStretch?: FabricStretch | null;
}
