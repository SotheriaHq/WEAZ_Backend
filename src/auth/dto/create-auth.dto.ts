import {
  IsString,
  IsEmail,
  IsOptional,
  IsEnum,
  MinLength,
  Matches,
  IsNotEmpty,
} from 'class-validator';
import { UserType } from '@prisma/client';
import { PASSWORD_POLICY_MIN_LENGTH } from '../helper/password-policy.helper';

export class CreateUserDto {
  // Owner names are required during signup for both regular and brand users.
  // Additional brand-specific validation lives in the auth service for clearer feedback.
  @IsNotEmpty({ message: 'First name is required' })
  @IsString({ message: 'First name must be a string' })
  @Matches(/^[a-zA-Z\s-]+$/, {
    message: 'First name can only contain letters, spaces, or hyphens',
  })
  firstName?: string;

  @IsNotEmpty({ message: 'Last name is required' })
  @IsString({ message: 'Last name must be a string' })
  @Matches(/^[a-zA-Z\s-]+$/, {
    message: 'Last name can only contain letters, spaces, or hyphens',
  })
  lastName?: string;

  @IsNotEmpty({ message: 'Email is required' })
  @IsEmail({}, { message: 'Please provide a valid email address' })
  email: string;

  @IsNotEmpty({ message: 'Password is required' })
  @IsString({ message: 'Password must be a string' })
  @MinLength(PASSWORD_POLICY_MIN_LENGTH, {
    message: `Password must be at least ${PASSWORD_POLICY_MIN_LENGTH} characters long`,
  })
  // Uncomment these for stronger password requirements
  // @Matches(/[A-Z]/, { message: 'Password must contain at least one uppercase letter' })
  // @Matches(/[!@#$%^&*(),.?":{}|<>]/, { message: 'Password must contain at least one special character' })
  password: string;

  // phoneNumber removed - not required

  @IsOptional()
  @IsString({ message: 'Brand full name must be a string' })
  brandFullName?: string;

  profileImage?: string;

  @IsOptional()
  @IsEnum(UserType, { message: 'User type must be either BRAND or REGULAR' })
  type?: UserType;
}
