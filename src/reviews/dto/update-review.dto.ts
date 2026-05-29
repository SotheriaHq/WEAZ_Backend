import {
  IsInt,
  Min,
  Max,
  IsString,
  IsOptional,
  IsArray,
  IsEnum,
  MaxLength,
  MinLength,
  ArrayMaxSize,
  IsUUID,
} from 'class-validator';
import { ReviewSatisfaction } from '@prisma/client';

export class UpdateProductReviewDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(5)
  rating?: number;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  title?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(5000)
  content?: string;

  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  @ArrayMaxSize(4)
  mediaIds?: string[];
}

export class UpdateReviewDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(5)
  rating?: number;

  @IsOptional()
  @IsEnum(ReviewSatisfaction)
  satisfaction?: ReviewSatisfaction;

  @IsOptional()
  @IsString()
  @MaxLength(5000)
  reviewText?: string;
}
