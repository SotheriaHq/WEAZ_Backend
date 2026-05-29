import {
  IsUUID,
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
} from 'class-validator';
import { ReviewSatisfaction, ReviewTargetType } from '@prisma/client';

export class CreateProductReviewDto {
  @IsUUID()
  productId: string;

  @IsUUID()
  orderItemId: string;

  @IsInt()
  @Min(1)
  @Max(5)
  rating: number;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  title?: string;

  @IsString()
  @MinLength(1)
  @MaxLength(5000)
  content: string;

  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  @ArrayMaxSize(4)
  mediaIds?: string[];
}

export class CreateReviewDto {
  @IsOptional()
  @IsUUID()
  promptId?: string;

  @IsEnum(ReviewTargetType)
  targetType: ReviewTargetType;

  @IsOptional()
  @IsUUID()
  orderId?: string;

  @IsOptional()
  @IsUUID()
  orderItemId?: string;

  @IsOptional()
  @IsUUID()
  customOrderId?: string;

  @IsOptional()
  @IsUUID()
  productId?: string;

  @IsOptional()
  @IsUUID()
  collectionId?: string;

  @IsOptional()
  @IsUUID()
  legacyCollectionId?: string;

  @IsOptional()
  @IsUUID()
  designId?: string;

  @IsOptional()
  @IsUUID()
  brandId?: string;

  @IsInt()
  @Min(1)
  @Max(5)
  rating: number;

  @IsEnum(ReviewSatisfaction)
  satisfaction: ReviewSatisfaction;

  @IsOptional()
  @IsString()
  @MaxLength(5000)
  reviewText?: string;
}
