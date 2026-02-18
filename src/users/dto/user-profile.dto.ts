import { IsEnum, IsOptional, IsString, IsUUID } from 'class-validator';
import { ProfileVisibility, UserType } from '@prisma/client';

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
  bannerImage?: string;

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

  constructor(partial: Partial<UserProfileResponseDto>) {
    Object.assign(this, partial);
  }
}