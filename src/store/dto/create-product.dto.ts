import { IsString, IsOptional, IsNumber, IsArray, IsBoolean, IsDateString, Min, IsEnum } from 'class-validator';
import { Type } from 'class-transformer';

export enum ProductGender {
  MALE = 'MALE',
  FEMALE = 'FEMALE',
  EVERYBODY = 'EVERYBODY',
}

export class CreateProductDto {
  @IsString()
  collectionId: string;

  @IsString()
  name: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsNumber()
  @Min(0)
  @Type(() => Number)
  price: number;

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
  colorImages?: Record<string, string>;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  images?: string[];

  @IsOptional()
  @IsString()
  thumbnail?: string;

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
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  @IsOptional()
  @IsEnum(ProductGender)
  gender?: ProductGender;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsBoolean()
  isFeatured?: boolean;
}

import { PartialType } from '@nestjs/mapped-types';

export class UpdateProductDto extends PartialType(CreateProductDto) {}
