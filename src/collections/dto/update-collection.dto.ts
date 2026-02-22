import {
  IsArray,
  IsDateString,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  IsBoolean,
  Min,
} from 'class-validator';
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
  categoryTypeId?: string | null;

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
