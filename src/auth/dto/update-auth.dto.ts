import {
  IsEmail,
  IsEnum,
  IsOptional,
  IsString,
  Matches,
} from 'class-validator';
import { UserType } from '@prisma/client';

/**
 * Admin-safe user update DTO.
 * Intentionally excludes `password` and `role` to prevent unsafe mass assignment.
 */
export class UpdateAuthDto {
  @IsOptional()
  @IsString()
  username?: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsString()
  phoneNumber?: string;

  @IsOptional()
  @IsString()
  address?: string;

  @IsOptional()
  @IsString()
  @Matches(/^[a-zA-Z\s-]+$/, {
    message: 'First name can only contain letters, spaces, or hyphens',
  })
  firstName?: string;

  @IsOptional()
  @IsString()
  @Matches(/^[a-zA-Z\s-]+$/, {
    message: 'Last name can only contain letters, spaces, or hyphens',
  })
  lastName?: string;

  @IsOptional()
  @IsString()
  brandFullName?: string;

  @IsOptional()
  @IsEnum(UserType, { message: 'User type must be either BRAND or REGULAR' })
  type?: UserType;

  @IsOptional()
  @IsString()
  isActive?: string;
}
