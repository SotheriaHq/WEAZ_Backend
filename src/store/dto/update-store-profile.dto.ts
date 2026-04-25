import {
  IsArray,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

export class UpdateStoreProfileDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  tagline?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  @IsOptional()
  @IsString()
  @MaxLength(254)
  contactEmail?: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  socialInstagram?: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  socialTwitter?: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  socialTiktok?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  socialWebsite?: string;
}
