import { FileType, CollectionVisibility, CollectionType } from '@prisma/client';
import { Type } from 'class-transformer';
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
} from 'class-validator';

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
  @IsString()
  @IsOptional()
  categoryId?: string;

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
  @IsString()
  categoryId?: string;

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
  @IsNumber()
  coverIndex?: number;
}
