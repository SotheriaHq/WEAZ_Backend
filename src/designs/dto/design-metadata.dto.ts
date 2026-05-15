import { FileType, CollectionType, CollectionVisibility } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Min,
  ValidateNested,
} from 'class-validator';

const normalizeSizingMode = ({ value }: { value: unknown }) =>
  value === 'RTW_PLUS_CUSTOM' ? 'RTW_PLUS_FITTINGS' : value;

export class DesignFileSpecDto {
  @IsString()
  @IsNotEmpty()
  name: string;

  @IsString()
  @IsNotEmpty()
  type: string;

  @IsNumber()
  size: number;

  @IsOptional()
  @IsEnum(FileType)
  fileType?: FileType;
}

export class CompleteDesignUploadDto {
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

export class DesignMetadataDto {
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
  @IsEnum(CollectionType)
  audience?: CollectionType;

  @IsOptional()
  @IsUUID('4')
  categoryId?: string;

  @IsOptional()
  @IsUUID('4')
  subCategoryId?: string;

  @IsOptional()
  @IsUUID('4')
  @Transform(({ value, obj }) => value ?? obj?.subCategoryId)
  categoryTypeId?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @Type(() => String)
  tags?: string[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => DesignFileSpecDto)
  files?: DesignFileSpecDto[];

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

  @IsOptional()
  @IsBoolean()
  draftOnly?: boolean;

  @IsOptional()
  @IsBoolean()
  shouldPublish?: boolean;

  @IsOptional()
  @IsString()
  action?: 'publish' | 'draft';

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

  @IsOptional()
  @IsString()
  coverMediaId?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  minPrice?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  maxPrice?: number;
}
