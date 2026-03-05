import {
  IsArray,
  IsDateString,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  IsBoolean,
  Min,
  IsIn,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { CollectionType, CollectionVisibility } from '@prisma/client';

export class UpdateCollectionDto {
  @IsOptional()
  @IsString()
  title?: string | null;

  @IsOptional()
  @IsString()
  description?: string | null;

  @IsOptional()
  @IsEnum(CollectionVisibility)
  visibility?: CollectionVisibility;

  @IsOptional()
  @IsEnum(CollectionType)
  type?: CollectionType;

  @IsOptional()
  @IsString()
  categoryId?: string | null;

  @IsOptional()
  @IsString()
  @Transform(({ value, obj }) => value ?? obj?.subCategoryId)
  categoryTypeId?: string | null;

  @IsOptional()
  @IsString()
  subCategoryId?: string | null;

  @IsOptional()
  @IsBoolean()
  isAvailableInStore?: boolean | null;

  @IsOptional()
  @IsNumber()
  @Min(0)
  minPrice?: number | null;

  @IsOptional()
  @IsNumber()
  @Min(0)
  maxPrice?: number | null;

  @IsOptional()
  @IsNumber()
  @Min(0)
  saleMinPrice?: number | null;

  @IsOptional()
  @IsNumber()
  @Min(0)
  saleMaxPrice?: number | null;

  @IsOptional()
  @IsDateString()
  saleStartAt?: string | null;

  @IsOptional()
  @IsDateString()
  saleEndAt?: string | null;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  filterValueIds?: string[];

  @IsOptional()
  @IsIn(['NONE', 'RTW', 'CUSTOM', 'RTW_PLUS_CUSTOM'])
  sizingMode?: 'NONE' | 'RTW' | 'CUSTOM' | 'RTW_PLUS_CUSTOM';

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  rtwSizes?: string[];

  @IsOptional()
  @IsString()
  rtwSizeSystem?: string | null;

  @IsOptional()
  @IsIn(['PREDEFINED', 'FREEFORM', 'MIXED'])
  rtwSizeType?: 'PREDEFINED' | 'FREEFORM' | 'MIXED' | null;

  @IsOptional()
  @IsIn(['MEN', 'WOMEN', 'UNISEX'])
  customGender?: 'MEN' | 'WOMEN' | 'UNISEX' | null;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  customMeasurementKeys?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  customFreeformPointIds?: string[];

  @IsOptional()
  @IsIn(['SLIM', 'REGULAR', 'LOOSE', 'OVERSIZED'])
  fitPreference?: 'SLIM' | 'REGULAR' | 'LOOSE' | 'OVERSIZED' | null;

  @IsOptional()
  @IsIn(['ADULT', 'CHILD'])
  targetAgeGroup?: 'ADULT' | 'CHILD' | null;

  @IsOptional()
  @IsString()
  coverMediaId?: string | null;

  @IsOptional()
  @IsString()
  draftSessionToken?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  draftVersion?: number;
}
