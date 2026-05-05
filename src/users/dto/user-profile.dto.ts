import { IsEnum, IsIn, IsOptional, IsString, IsUUID } from 'class-validator';
import { ProfileVisibility, UserType } from '@prisma/client';
import {
  THEME_PREFERENCES,
  type ThemePreference,
} from 'src/common/theme.contract';

type UserProfileFileDto = {
  id?: string | null;
  s3Url?: string | null;
};

export class UserProfileResponseDto {
  @IsUUID()
  id: string;

  @IsString()
  username: string;

  @IsString()
  firstName: string;

  @IsString()
  lastName: string;

  @IsString()
  @IsOptional()
  profileImage?: string;

  @IsString()
  @IsOptional()
  profileImageId?: string;

  @IsOptional()
  profileImageFile?: UserProfileFileDto | null;

  @IsString()
  @IsOptional()
  bannerImage?: string;

  @IsString()
  @IsOptional()
  bannerImageId?: string;

  @IsOptional()
  bannerImageFile?: UserProfileFileDto | null;

  @IsString()
  @IsOptional()
  address?: string;

  @IsEnum(ProfileVisibility)
  profileVisibility: ProfileVisibility;

  @IsEnum(UserType)
  type: UserType;

  @IsString()
  @IsOptional()
  location?: string;

  @IsString()
  @IsOptional()
  createdAt?: string;

  @IsIn(THEME_PREFERENCES)
  @IsOptional()
  themePreference?: ThemePreference;

  constructor(partial: Partial<UserProfileResponseDto>) {
    Object.assign(this, partial);
  }
}
