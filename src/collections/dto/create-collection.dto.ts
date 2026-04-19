import { FileType, CollectionVisibility, CollectionType } from '@prisma/client';
import { Type, Transform } from 'class-transformer';
import {
  IsString,
  IsOptional,
  IsArray,
  ValidateNested,
  IsNotEmpty,
  IsNumber,
  IsEnum,
  ArrayMinSize,
  ArrayMaxSize,
  IsBoolean,
  Min,
  IsUUID,
  IsIn,
} from 'class-validator';

const normalizeSizingMode = ({ value }: { value: unknown }) =>
  value === 'RTW_PLUS_CUSTOM' ? 'RTW_PLUS_FITTINGS' : value;

export class FileSpecDto {
  @IsString()
  @IsNotEmpty()
  name: string;

  @IsString()
  @IsNotEmpty()
  type: string; // MIME type

  @IsNumber()
  size: number;

  @IsOptional()
  @IsEnum(FileType)
  fileType?: FileType; // POST_IMAGE, POST_VIDEO, etc.
}

export class CreateCollectionDto {
  @IsOptional()
  @IsString()
  mode?: 'existing' | 'new-individual' | 'new-template' | 'bulk';

  @IsOptional()
  @IsBoolean()
  draftOnly?: boolean;

  @IsString()
  @IsOptional()
  title?: string;

  @IsString()
  @IsOptional()
  description?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  minPrice?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  maxPrice?: number;

  @IsOptional()
  @IsBoolean()
  isAvailableInStore?: boolean;

  // Visibility: PUBLIC or PRIVATE (default PUBLIC)
  @IsOptional()
  @IsEnum(CollectionVisibility)
  visibility?: CollectionVisibility;

  // Category (required; users must select from approved categories)
  @IsOptional()
  @IsUUID('4')
  categoryId?: string;

  // Sub-category (required for publish flows)
  @IsOptional()
  @IsUUID('4')
  @Transform(({ value, obj }) => value ?? obj?.subCategoryId)
  categoryTypeId?: string;

  // Alias for categoryTypeId (accepted for backward/forward compatibility)
  @IsOptional()
  @IsUUID('4')
  subCategoryId?: string;

  // Type: MALE, FEMALE, EVERYBODY
  @IsOptional()
  @IsEnum(CollectionType)
  type?: CollectionType;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @Type(() => String)
  tags?: string[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => FileSpecDto)
  files?: FileSpecDto[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  filterValueIds?: string[];

  @IsOptional()
  @Transform(normalizeSizingMode)
  @IsIn(['NONE', 'RTW', 'CUSTOM', 'RTW_PLUS_FITTINGS'])
  sizingMode?: 'NONE' | 'RTW' | 'CUSTOM' | 'RTW_PLUS_FITTINGS';

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  rtwSizes?: string[];

  @IsOptional()
  @IsString()
  rtwSizeSystem?: string;

  @IsOptional()
  @IsIn(['PREDEFINED', 'FREEFORM', 'MIXED'])
  rtwSizeType?: 'PREDEFINED' | 'FREEFORM' | 'MIXED';

  @IsOptional()
  @IsIn(['MEN', 'WOMEN', 'UNISEX'])
  customGender?: 'MEN' | 'WOMEN' | 'UNISEX';

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  customMeasurementKeys?: string[];

  @IsOptional()
  @IsBoolean()
  customOrderEnabled?: boolean;

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
}

export class CompleteUploadDto {
  @IsString()
  @IsNotEmpty()
  fileId: string;

  @IsString()
  @IsNotEmpty()
  s3Key: string;

  @IsNumber()
  actualSize: number;

  @IsString()
  @IsNotEmpty()
  actualMimeType: string;
}

export class CollectionMetadataDto {
  @IsOptional()
  @IsString()
  title?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsEnum(CollectionVisibility)
  visibility?: CollectionVisibility;

  @IsOptional()
  @IsEnum(CollectionType)
  type?: CollectionType;

  @IsOptional()
  @IsUUID('4')
  categoryId?: string;

  @IsOptional()
  @IsUUID('4')
  @Transform(({ value, obj }) => value ?? obj?.subCategoryId)
  categoryTypeId?: string;

  // Alias for categoryTypeId (accepted for backward/forward compatibility)
  @IsOptional()
  @IsUUID('4')
  subCategoryId?: string;

  @IsOptional()
  @IsString()
  coverMediaId?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  @IsOptional()
  @IsBoolean()
  isAvailableInStore?: boolean;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  filterValueIds?: string[];

  @IsOptional()
  @Transform(normalizeSizingMode)
  @IsIn(['NONE', 'RTW', 'CUSTOM', 'RTW_PLUS_FITTINGS'])
  sizingMode?: 'NONE' | 'RTW' | 'CUSTOM' | 'RTW_PLUS_FITTINGS';

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  rtwSizes?: string[];

  @IsOptional()
  @IsString()
  rtwSizeSystem?: string;

  @IsOptional()
  @IsIn(['PREDEFINED', 'FREEFORM', 'MIXED'])
  rtwSizeType?: 'PREDEFINED' | 'FREEFORM' | 'MIXED';

  @IsOptional()
  @IsIn(['MEN', 'WOMEN', 'UNISEX'])
  customGender?: 'MEN' | 'WOMEN' | 'UNISEX';

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  customMeasurementKeys?: string[];

  @IsOptional()
  @IsBoolean()
  customOrderEnabled?: boolean;

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
}

export class FinalizeCollectionDto {
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CompleteUploadDto)
  completions?: CompleteUploadDto[];

  @IsOptional()
  @IsBoolean()
  shouldPublish?: boolean;

  @IsOptional()
  @IsString()
  action?: 'publish' | 'draft';

  @IsOptional()
  @ValidateNested()
  @Type(() => CollectionMetadataDto)
  collectionMetadata?: CollectionMetadataDto;

  @IsOptional()
  @IsString()
  coverMediaId?: string;

  @IsOptional()
  @IsString()
  draftSessionToken?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  draftVersion?: number;

  @IsOptional()
  @IsNumber()
  coverIndex?: number;
}
