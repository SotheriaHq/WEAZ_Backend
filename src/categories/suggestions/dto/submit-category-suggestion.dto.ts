import { IsString, IsOptional, Matches, MaxLength } from 'class-validator';
import { TAXONOMY_PROPOSAL_NAME } from '../taxonomy-proposal-name';

export class SubmitCategorySuggestionDto {
  @IsString()
  @Matches(TAXONOMY_PROPOSAL_NAME)
  name!: string;

  @IsOptional()
  @IsString()
  @Matches(TAXONOMY_PROPOSAL_NAME)
  garmentTypeName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;
}
