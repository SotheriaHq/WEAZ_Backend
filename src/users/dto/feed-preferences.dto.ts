import { PersonalizationResetType } from '@prisma/client';
import {
  IsBoolean,
  IsEnum,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

export class ResetFeedPreferencesDto {
  @IsEnum(PersonalizationResetType)
  resetType!: PersonalizationResetType;

  @IsOptional()
  @IsString()
  @MaxLength(240)
  reason?: string;
}

export class UpdateMarketPreferencesDto {
  @IsOptional()
  @IsBoolean()
  personalization?: boolean;

  @IsOptional()
  @IsBoolean()
  regionalOptIn?: boolean;

  /** Only `true` is accepted: the 18+ confirmation is one-way (L5). */
  @IsOptional()
  @IsIn([true])
  confirmAdult?: true;
}
