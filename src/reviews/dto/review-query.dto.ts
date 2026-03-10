import {
    IsOptional,
    IsString,
    IsInt,
    Min,
    Max,
    IsEnum,
} from 'class-validator';
import { Type } from 'class-transformer';

export enum ReviewSortOption {
    NEWEST = 'newest',
    HIGHEST_RATING = 'highest_rating',
    LOWEST_RATING = 'lowest_rating',
    MOST_HELPFUL = 'most_helpful',
}

export enum ReviewFilterOption {
    ALL = 'all',
    STAR_1 = '1',
    STAR_2 = '2',
    STAR_3 = '3',
    STAR_4 = '4',
    STAR_5 = '5',
    WITH_MEDIA = 'with_media',
}

export class ReviewQueryDto {
    @IsOptional()
    @IsString()
    cursor?: string;

    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(1)
    @Max(50)
    limit?: number = 20;

    @IsOptional()
    @IsEnum(ReviewSortOption)
    sort?: ReviewSortOption = ReviewSortOption.NEWEST;

    @IsOptional()
    @IsEnum(ReviewFilterOption)
    filter?: ReviewFilterOption = ReviewFilterOption.ALL;
}
