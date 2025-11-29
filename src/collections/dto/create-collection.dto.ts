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
  @IsString()
  @IsNotEmpty()
  title: string;

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
  @IsNotEmpty()
  categoryId!: string;

  // Type: MALE, FEMALE, EVERYBODY
  @IsEnum(CollectionType)
  type: CollectionType;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(10)
  @IsString({ each: true })
  @Type(() => String)
  tags: string[];

  @IsArray()
  @ValidateNested({ each: true })
  @ArrayMinSize(1)
  @Type(() => FileSpecDto)
  files: FileSpecDto[];
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

export class FinalizeCollectionDto {
  @IsArray()
  @ValidateNested({ each: true })
  @ArrayMinSize(1)
  @Type(() => CompleteUploadDto)
  completions: CompleteUploadDto[];

  @IsOptional()
  @IsBoolean()
  shouldPublish?: boolean;
}
