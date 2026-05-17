import { ApiProperty } from '@nestjs/swagger';
import {
  BrandMemberRole,
  BrandMemberStatus,
  BrandVerificationStatus,
  PasswordCredentialStatus,
} from '@prisma/client';
import { THEME_PREFERENCES, type ThemePreference } from 'src/common/theme.contract';

export class AuthProfileImageFileDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  s3Url: string;

  @ApiProperty()
  fileName: string;

  @ApiProperty()
  originalName: string;

  @ApiProperty()
  createdAt: string;
  @ApiProperty()
  updatedAt: string;
}

export class AuthBrandMembershipDto {
  @ApiProperty()
  brandId: string;

  @ApiProperty()
  brandName: string;

  @ApiProperty({ enum: BrandMemberRole })
  role: BrandMemberRole;

  @ApiProperty({ enum: BrandMemberStatus })
  status: BrandMemberStatus;

  @ApiProperty()
  isOwner: boolean;
}

export class AuthUserResponseDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  username: string;

  @ApiProperty()
  email: string;

  @ApiProperty()
  firstName: string;

  @ApiProperty()
  lastName: string;
  @ApiProperty({ enum: ['SuperAdmin', 'Admin', 'User'] })
  role: 'SuperAdmin' | 'Admin' | 'User';

  @ApiProperty({ enum: ['BRAND', 'REGULAR'] })
  type: 'BRAND' | 'REGULAR';

  @ApiProperty({ required: false, nullable: true })
  phoneNumber: string | null;

  @ApiProperty({ required: false, nullable: true })
  address: string | null;

  @ApiProperty({ required: false, nullable: true })
  brandFullName: string | null;

  @ApiProperty({ required: false, nullable: true })
  brandDescription: string | null;

  @ApiProperty({ required: false, nullable: true })
  brandCountry: string | null;

  @ApiProperty({ required: false, nullable: true })
  brandState: string | null;

  @ApiProperty({ required: false, nullable: true })
  brandCity: string | null;

  @ApiProperty({ required: false, isArray: true, type: String })
  brandTags: string[];

  @ApiProperty({ required: false, nullable: true })
  brandBusinessType: string | null;

  @ApiProperty({ required: false, nullable: true })
  socialInstagram: string | null;

  @ApiProperty({ required: false, nullable: true })
  socialFacebook: string | null;

  @ApiProperty({ required: false, nullable: true })
  socialTwitter: string | null;

  @ApiProperty({ required: false, nullable: true })
  socialWebsite: string | null;

  @ApiProperty({ required: false, nullable: true })
  cacNumber: string | null;

  @ApiProperty({ required: false, nullable: true })
  tin: string | null;

  @ApiProperty({ required: false, nullable: true })
  ceoNin: string | null;

  @ApiProperty({ required: false, nullable: true })
  ceoFirstName: string | null;

  @ApiProperty({ required: false, nullable: true })
  ceoLastName: string | null;

  @ApiProperty({ required: false, nullable: true })
  companyLocation: string | null;
  @ApiProperty({ required: false, nullable: true })
  profileImage: string | null;

  @ApiProperty({ required: false, nullable: true })
  profileImageId: string | null;

  @ApiProperty({
    required: false,
    nullable: true,
    type: () => AuthProfileImageFileDto,
  })
  profileImageFile: AuthProfileImageFileDto | null;

  @ApiProperty({ required: false, nullable: true })
  bannerImage: string | null;

  @ApiProperty({ required: false, nullable: true })
  bannerImageId: string | null;

  @ApiProperty({
    required: false,
    nullable: true,
    type: () => AuthProfileImageFileDto,
  })
  bannerImageFile: AuthProfileImageFileDto | null;

  @ApiProperty()
  isEmailVerified: boolean;

  @ApiProperty({ enum: PasswordCredentialStatus })
  passwordCredentialStatus: PasswordCredentialStatus;

  @ApiProperty({
    required: false,
    nullable: true,
    description:
      'Brand store id (Brand.id) for BRAND users; null for regular users',
  })
  storeId: string | null;

  @ApiProperty({
    required: false,
    isArray: true,
    type: () => AuthBrandMembershipDto,
    description:
      'Brand memberships visible to the authenticated account. Includes inactive statuses for account awareness.',
  })
  brandMemberships?: AuthBrandMembershipDto[];

  @ApiProperty({
    required: false,
    nullable: true,
    description:
      'Primary active Brand.id for brand-scoped operations; null when no active brand membership exists.',
  })
  activeBrandId?: string | null;

  @ApiProperty({ required: false, nullable: true, enum: BrandVerificationStatus })
  verificationStatus?: BrandVerificationStatus | null;

  @ApiProperty({ required: false })
  isVerifiedBrand?: boolean;

  @ApiProperty({ required: false })
  verificationBadgeVisible?: boolean;

  @ApiProperty({ required: false, nullable: true })
  verifiedExplanationUrl?: string | null;

  @ApiProperty()
  isActive: string;

  @ApiProperty({ enum: THEME_PREFERENCES })
  themePreference: ThemePreference;

  @ApiProperty({ required: false, nullable: true })
  status?: string | null;

  @ApiProperty({ required: false })
  mustResetPassword?: boolean;

  @ApiProperty()
  createdAt: string;

  @ApiProperty()
  updatedAt: string;
}
export class AuthTokensResponseDto {
  @ApiProperty({ type: () => AuthUserResponseDto })
  user: AuthUserResponseDto;

  @ApiProperty({ required: false, nullable: true })
  accessToken?: string | null;

  @ApiProperty({ required: false, nullable: true })
  refreshToken?: string | null;

  @ApiProperty({ required: false })
  message?: string;
}
export class AuthProfileResponseDto {
  @ApiProperty({ type: () => AuthUserResponseDto })
  user: AuthUserResponseDto;
}
export interface AuthJwtClaims {
  sub: string;
  username: string;
  role: 'SuperAdmin' | 'Admin' | 'User';
  type: 'BRAND' | 'REGULAR';
  email: string;
  firstName: string;
  lastName: string;
  authVersion: number;
  permissions?: string[];
}
