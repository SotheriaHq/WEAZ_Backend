import {
    IsUUID,
    IsInt,
    Min,
    Max,
    IsString,
    IsOptional,
    IsArray,
    MaxLength,
    MinLength,
    ArrayMaxSize,
} from 'class-validator';

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
