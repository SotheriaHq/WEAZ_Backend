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

export const DESIGN_REQUIRED_MEDIA_COUNT = 4;
export const DESIGN_MAX_MEDIA_COUNT = 6;

// LEGACY_COMPAT_COLLECTION_BACKED_DESIGN:
// This file still contains design-specific collection DTO fields because
// existing clients create design-like records through collection-backed flows.
// New design code should use src/designs DTOs and the legacy adapter boundary.
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

  // LEGACY_COMPAT_COLLECTION_BACKED_DESIGN:
  // categoryId/categoryTypeId/subCategoryId/type/tags remain here for legacy
  // design creation compatibility. New design code should use Design DTOs.
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

  // LEGACY_COMPAT_COLLECTION_BACKED_DESIGN:
  // files/filterValueIds remain here for legacy design media upload and design
  // discovery-filter compatibility. New design code should use Design DTOs.
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => FileSpecDto)
  files?: FileSpecDto[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  filterValueIds?: string[];

  // LEGACY_COMPAT_COLLECTION_BACKED_DESIGN:
  // sizingMode, rtw sizes, custom-order fields, fitPreference, and
  // targetAgeGroup are design-owned concepts kept only for compatibility.
  // New design code should use Design DTOs.
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

// LEGACY_COMPAT_COLLECTION_BACKED_DESIGN:
// This metadata DTO remains only because existing clients still finalize
// design-like records through collectionMetadata. New design-facing code should
// use DesignMetadataDto and map through the legacy adapter.
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

  // LEGACY_COMPAT_COLLECTION_BACKED_DESIGN:
  // categoryId/categoryTypeId/subCategoryId/tags/filterValueIds and the
  // sizing/custom-order fields below are design-owned compatibility fields.
  // New design code should use Design DTOs.
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

  // LEGACY_COMPAT_COLLECTION_BACKED_DESIGN:
  // collectionMetadata, coverIndex, draftSessionToken, and draftVersion remain
  // because old clients finalize design-like records through collection-backed
  // routes. New design code should use FinalizeDesignUploadDto.
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
