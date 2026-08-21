import {
  IsArray,
  IsBoolean,
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

  /**
   * Publish `contactEmail` on the public brand profile.
   *
   * Only the brand can set this — there is deliberately no admin path. It is
   * accepted on the owner-authenticated store-profile update and nowhere else.
   */
  @IsOptional()
  @IsBoolean()
  contactEmailPublic?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  socialInstagram?: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  socialFacebook?: string;

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
