import { ApiProperty } from '@nestjs/swagger';
import { IsIn } from 'class-validator';
import {
  THEME_PREFERENCES,
  type ThemePreference,
} from 'src/common/theme.contract';

export class UpdateUserPreferencesDto {
  @ApiProperty({ enum: THEME_PREFERENCES })
  @IsIn(THEME_PREFERENCES, {
    message: 'themePreference must be one of: light, dark, system',
  })
  themePreference: ThemePreference;
}
