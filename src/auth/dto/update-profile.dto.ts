import {
  IsOptional,
  IsString,
  IsEmail,
  IsNotEmpty,
  Matches,
} from 'class-validator';

export class UpdateProfileDto {
  @IsOptional()
  @IsString()
  username?: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  profileImage?: string;

  @IsOptional()
  @IsString({ message: 'Phone number must be a string' })
  phoneNumber?: string;

  @IsOptional()
  @IsString({ message: 'Address must be a string' })
  address?: string;

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

  // Add other profile fields as needed, but do NOT include password
}
