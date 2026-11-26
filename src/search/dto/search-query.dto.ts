import {
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class SearchQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  q?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;

  @IsOptional()
  @IsString()
  type?: string;

  @IsOptional()
  @IsUUID()
  brandId?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;

  /** Product order; read only while SEARCH_LEXICON_V1 is on. */
  @IsOptional()
  @IsString()
  @MaxLength(20)
  sort?: string;

  /** Canonical catalogue filter encoding, e.g. `color=red&size=42`. */
  @IsOptional()
  @IsString()
  @MaxLength(8192)
  filters?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1)
  includeFacets?: string;
}
