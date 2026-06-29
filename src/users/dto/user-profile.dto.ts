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

export type ProfilePhotoViewStateDto = {
  ownerId: string;
  profilePhotoUpdatedAt: string | null;
  viewed: boolean;
  hasUnviewedUpdate: boolean;
  canMarkViewed: boolean;
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
  profilePhotoUpdatedAt?: string | null;

  @IsOptional()
  profilePhotoViewState?: ProfilePhotoViewStateDto;

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

export class PublicUserProfileResponseDto {
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

  @IsString()
  @IsOptional()
  profilePhotoUpdatedAt?: string | null;

  @IsOptional()
  profilePhotoViewState?: ProfilePhotoViewStateDto;

  @IsString()
  @IsOptional()
  bannerImage?: string;

  @IsString()
  @IsOptional()
  bannerImageId?: string;

  @IsEnum(ProfileVisibility)
  profileVisibility: ProfileVisibility;

  @IsEnum(UserType)
  type: UserType;

  @IsString()
  @IsOptional()
  createdAt?: string;

  constructor(partial: Partial<PublicUserProfileResponseDto>) {
    Object.assign(this, partial);
  }
}
