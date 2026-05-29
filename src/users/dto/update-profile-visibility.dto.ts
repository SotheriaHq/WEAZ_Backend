import { IsEnum } from 'class-validator';
import { ProfileVisibility } from '@prisma/client';

export class UpdateProfileVisibilityDto {
  @IsEnum(ProfileVisibility)
  profileVisibility: ProfileVisibility;
}
