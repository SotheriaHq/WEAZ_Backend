import { IsString, IsOptional, IsInt, Min, Max, Matches } from 'class-validator';

export class UpsertCategoryDto {
  @IsString()
  @Matches(/^[A-Za-z0-9 ]{2,48}$/)
  name!: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10000)
  order?: number;
}
