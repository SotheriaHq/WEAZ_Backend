import { IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

export class SearchSuggestQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  q?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;

  @IsOptional()
  @IsUUID()
  brandId?: string;
}
