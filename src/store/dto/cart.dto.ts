import {
  IsString,
  IsNumber,
  IsOptional,
  Min,
  Max,
  IsArray,
  IsObject,
  IsIn,
} from 'class-validator';
import { Type } from 'class-transformer';

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
  @IsIn(['NONE', 'RTW', 'CUSTOM', 'RTW_PLUS_CUSTOM'])
  sizingMode?: 'NONE' | 'RTW' | 'CUSTOM' | 'RTW_PLUS_CUSTOM';

  @IsOptional()
  @IsObject()
  sizeFitData?: Record<string, any>;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  requiredMeasurementKeys?: string[];
}

export class UpdateCartItemDto {
  @IsNumber()
  @Min(1)
  @Max(99)
  @Type(() => Number)
  quantity: number;
}
