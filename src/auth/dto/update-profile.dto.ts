import {
  IsOptional,
  IsString,
  IsNotEmpty,
  Matches,
  IsUUID,
} from 'class-validator';

export class UpdateProfileDto {
  @IsOptional()
  @IsString()
  username?: string;

  @IsOptional()
  @IsString()
  profileImage?: string;

  @IsOptional()
  @IsUUID()
  profileImageId?: string;

  @IsOptional()
  @IsString()
  bannerImage?: string;

  @IsOptional()
  @IsUUID()
  bannerImageId?: string;

  @IsOptional()
  @IsString({ message: 'Phone number must be a string' })
  phoneNumber?: string;

  @IsOptional()
  @IsString({ message: 'Address must be a string' })
  address?: string;

  @IsOptional()
  @IsNotEmpty({ message: 'First name is required' })
  @IsString({ message: 'First name must be a string' })
  @Matches(/^[a-zA-Z\s-]+$/, {
    message: 'First name can only contain letters, spaces, or hyphens',
  })
  firstName?: string;

  @IsOptional()
  @IsNotEmpty({ message: 'Last name is required' })
  @IsString({ message: 'Last name must be a string' })
  @Matches(/^[a-zA-Z\s-]+$/, {
    message: 'Last name can only contain letters, spaces, or hyphens',
  })
  lastName?: string;

  // Add other profile fields as needed, but do NOT include password
}
