import { PersonalizationResetType } from '@prisma/client';
import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';

export class ResetFeedPreferencesDto {
  @IsEnum(PersonalizationResetType)
  resetType!: PersonalizationResetType;

  @IsOptional()
  @IsString()
  @MaxLength(240)
  reason?: string;
}
