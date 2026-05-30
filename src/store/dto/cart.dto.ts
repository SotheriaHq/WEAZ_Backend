import {
  IsString,
  IsNumber,
  IsOptional,
  Min,
  Max,
  IsArray,
  IsObject,
  IsIn,
  IsBoolean,
} from 'class-validator';
import { Type, Transform } from 'class-transformer';

const normalizeSizingMode = ({ value }: { value: unknown }) =>
  value === 'RTW_PLUS_CUSTOM' ? 'RTW_PLUS_FITTINGS' : value;

export class AddToCartDto {
  @IsString()
  productId: string;

  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(99)
  @Type(() => Number)
  quantity?: number = 1;

  @IsOptional()
  @IsString()
  selectedSize?: string;

  @IsOptional()
  @IsString()
  selectedColor?: string;

  @IsOptional()
  @Transform(normalizeSizingMode)
  @IsIn(['NONE', 'RTW', 'CUSTOM', 'RTW_PLUS_FITTINGS'])
  sizingMode?: 'NONE' | 'RTW' | 'CUSTOM' | 'RTW_PLUS_FITTINGS';

  @IsOptional()
  @IsObject()
  sizeFitData?: Record<string, any>;

  @IsOptional()
  @IsObject()
  sizeRecommendationSnapshot?: Record<string, any>;

  @IsOptional()
  @IsString()
  manualOverrideReason?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  requiredMeasurementKeys?: string[];

  @IsOptional()
  @IsBoolean()
  measurementOverrideAccepted?: boolean;
}

export class UpdateCartItemDto {
  @IsNumber()
  @Min(1)
  @Max(99)
  @Type(() => Number)
  quantity: number;
}
