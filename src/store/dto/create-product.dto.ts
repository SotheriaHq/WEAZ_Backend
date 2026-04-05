import {
  IsString,
  IsOptional,
  IsNumber,
  IsArray,
  ArrayMaxSize,
  IsBoolean,
  IsDateString,
  Min,
  IsEnum,
  MaxLength,
  ValidateNested,
  IsInt,
  IsUUID,
  IsIn,
  IsNotEmpty,
} from 'class-validator';
import { Type, Transform } from 'class-transformer';

export enum ProductGender {
  MALE = 'MALE',
  FEMALE = 'FEMALE',
  EVERYBODY = 'EVERYBODY',
}

const normalizeSizingMode = ({ value, obj }: { value: unknown; obj?: Record<string, unknown> }) => {
  if (value === 'RTW_PLUS_CUSTOM') {
    if (obj && typeof obj === 'object') {
      obj.sizingModeDeprecatedAliasUsed = true;
    }
    return 'RTW_PLUS_FITTINGS';
  }
  return value;
};

export class ProductVariantDto {
  @IsOptional()
  @IsString()
  @MaxLength(40)
  size?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  color?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  sku?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  price?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Type(() => Number)
  stock?: number;

  @IsOptional()
  @IsString()
  @MaxLength(16)
  colorHex?: string;
}

export class CreateProductDto {
  @IsOptional()
  @IsUUID('4')
  collectionId?: string;

  @IsOptional()
  @IsUUID('4')
  @Transform(({ value, obj }) => value ?? obj?.subCategoryId)
  categoryTypeId?: string;

  @IsOptional()
  @IsUUID('4')
  subCategoryId?: string;

  @IsOptional()
  @IsUUID('4')
  categoryId?: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  slug?: string;

  @IsOptional()
  @IsString()
  @MaxLength(5000)
  description?: string;

  @IsOptional()
  @IsString()
  @MaxLength(10)
  currency?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  price?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  salePrice?: number;

  @IsOptional()
  @IsDateString()
  saleStartAt?: string;

  @IsOptional()
  @IsDateString()
  saleEndAt?: string;

  // Product details
  @IsOptional()
  @IsString()
  @MaxLength(100)
  sku?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  weight?: number;

  @IsOptional()
  @IsString()
  weightUnit?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  materials?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  careInstructions?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  costPerItem?: number;

  // Variants
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ProductVariantDto)
  variants?: ProductVariantDto[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  sizes?: string[];

  @IsOptional()
  sizeStock?: Record<string, number>;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  colors?: string[];

  @IsOptional()
  @Transform(normalizeSizingMode)
  @IsIn(['NONE', 'RTW', 'CUSTOM', 'RTW_PLUS_FITTINGS'])
  sizingMode?: 'NONE' | 'RTW' | 'CUSTOM' | 'RTW_PLUS_FITTINGS';

  @IsOptional()
  @IsBoolean()
  sizingModeDeprecatedAliasUsed?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  rtwSizeSystem?: string;

  @IsOptional()
  @IsIn(['PREDEFINED', 'FREEFORM', 'MIXED'])
  rtwSizeType?: 'PREDEFINED' | 'FREEFORM' | 'MIXED';

  @IsOptional()
  @IsBoolean()
  rtwLinkedToInventory?: boolean;

  @IsOptional()
  @IsIn(['MEN', 'WOMEN', 'UNISEX'])
  customGender?: 'MEN' | 'WOMEN' | 'UNISEX';

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
  fitPreference?: 'SLIM' | 'REGULAR' | 'LOOSE' | 'OVERSIZED';

  @IsOptional()
  @IsIn(['ADULT', 'CHILD'])
  targetAgeGroup?: 'ADULT' | 'CHILD';

  @IsOptional()
  colorImages?: Record<string, string>;

  @IsOptional()
  colorHexCodes?: Record<string, string>;

  // Media
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(6)
  @IsString({ each: true })
  images?: string[];

  @IsOptional()
  @IsString()
  thumbnail?: string;

  // Inventory
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  totalStock?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  lowStockThreshold?: number;

  @IsOptional()
  @IsBoolean()
  trackInventory?: boolean;

  @IsOptional()
  @IsBoolean()
  allowBackorders?: boolean;

  @IsOptional()
  @IsBoolean()
  standardCheckoutEnabled?: boolean;

  @IsOptional()
  @IsBoolean()
  customOrderEnabled?: boolean;

  // Metadata
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  filterValueIds?: string[];

  @IsOptional()
  @IsEnum(ProductGender)
  gender?: ProductGender;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  // isFeatured removed — featuring is now admin-only via FeaturedItem table

  @IsOptional()
  @IsBoolean()
  isPhysicalProduct?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(10)
  customsRegion?: string;

  // Policies
  @IsOptional()
  @IsBoolean()
  returnsEligible?: boolean;

  // SEO
  @IsOptional()
  @IsString()
  @MaxLength(70)
  metaTitle?: string;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  metaDescription?: string;

  // Scheduling
  @IsOptional()
  @IsDateString()
  publishAt?: string;
}

import { PartialType } from '@nestjs/mapped-types';

export class UpdateProductDto extends PartialType(CreateProductDto) {}
