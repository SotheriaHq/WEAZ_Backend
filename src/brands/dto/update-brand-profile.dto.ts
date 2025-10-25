import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  MaxLength,
} from 'class-validator';

const NAME_REGEX = /^[a-zA-Z\s-]+$/;

export class UpdateBrandProfileDto {
  @ApiPropertyOptional({
    description: 'Brand display name',
    maxLength: 120,
  })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  brandFullName?: string;

  @ApiPropertyOptional({
    description: 'Short description about the brand',
  })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  brandDescription?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Matches(NAME_REGEX, {
    message: 'Country can only contain letters, spaces, or hyphens',
  })
  brandCountry?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Matches(NAME_REGEX, {
    message: 'State can only contain letters, spaces, or hyphens',
  })
  brandState?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Matches(NAME_REGEX, {
    message: 'City can only contain letters, spaces, or hyphens',
  })
  brandCity?: string;

  @ApiPropertyOptional({
    isArray: true,
    type: String,
    description: 'Selected brand tags (up to 3)',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(6)
  @IsString({ each: true })
  brandTags?: string[];

  @ApiPropertyOptional({
    description: 'Instagram profile URL',
  })
  @IsOptional()
  @IsUrl({}, { message: 'Instagram URL must be a valid URL' })
  socialInstagram?: string;

  @ApiPropertyOptional({
    description: 'Facebook page URL',
  })
  @IsOptional()
  @IsUrl({}, { message: 'Facebook URL must be a valid URL' })
  socialFacebook?: string;

  @ApiPropertyOptional({
    description: 'Twitter/X profile URL',
  })
  @IsOptional()
  @IsUrl({}, { message: 'Twitter URL must be a valid URL' })
  socialTwitter?: string;

  @ApiPropertyOptional({
    description: 'Website URL',
  })
  @IsOptional()
  @IsUrl({}, { message: 'Website URL must be a valid URL' })
  socialWebsite?: string;

  @ApiPropertyOptional({
    description: 'Primary contact phone number',
  })
  @IsOptional()
  @IsString()
  @MaxLength(30)
  phoneNumber?: string;

  @ApiPropertyOptional({
    description: 'Business type label',
  })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  businessType?: string;
}
