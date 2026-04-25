import { IsString, IsOptional, Matches, MaxLength } from 'class-validator';

export class SubmitCategorySuggestionDto {
  @IsString()
  @Matches(/^[A-Za-z0-9 ]{2,48}$/)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;
}
