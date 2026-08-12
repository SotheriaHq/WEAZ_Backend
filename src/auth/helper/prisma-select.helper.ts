import {
  BrandMemberRole,
  BrandMemberStatus,
  PasswordCredentialStatus,
  Prisma,
} from '@prisma/client';
import {
  AuthJwtClaims,
  AuthProfileImageFileDto,
  AuthUserResponseDto,
} from '../dto/auth-response.dto';
import { getBrandVerificationTruth } from 'src/brand-verification/verification-truth.util';
import { normalizeThemePreference } from 'src/common/theme.contract';
import {
  canonicalUserProfileSelect,
  resolveBannerImage,
  resolveNullableProfileField,
  resolveProfileImage,
  resolveRequiredProfileField,
  type SelectedProfileFile,
} from 'src/common/user-profile-source.helper';
import {
  canonicalBrandProfileSelect,
  normalizeBrandProfileForAuthResponse,
} from 'src/common/brand-profile-source.helper';

export const authUserSelect = Prisma.validator<Prisma.UserSelect>()({
  id: true,
  username: true,
  role: true,
  type: true,
  email: true,
  status: true,
  brand: {
    select: canonicalBrandProfileSelect,
  },
  brandMemberships: {
    select: {
      brandId: true,
      role: true,
      status: true,
      brand: {
        select: {
          id: true,
          name: true,
        },
      },
    },
    orderBy: [{ createdAt: 'asc' }],
  },
  adminPermissionGrants: {
    select: { permissionCode: true },
  },
  isEmailVerified: true,
  passwordCredentialStatus: true,
  isActive: true,
  themePreference: true,
  mustResetPassword: true,
  authVersion: true,
  createdAt: true,
  updatedAt: true,
  userProfile: {
    select: canonicalUserProfileSelect,
  },
});
/**
 * The minimum a JWT needs. `buildAuthTokenPayload` reads eight scalars plus the
 * admin permission codes; the session guards on refresh read `status`, `role`
 * and `mustResetPassword`. Nothing else.
 *
 * `authUserSelect` — brand profile, brand memberships with their brand joins,
 * user profile with both image-file joins — is the shape of a LOGIN RESPONSE.
 * Using it to mint a token made every refresh (once per client per 15 minutes,
 * the highest-volume authenticated call there is) pay for five joins whose
 * result was thrown away.
 */
export const authTokenClaimsSelect = Prisma.validator<Prisma.UserSelect>()({
  id: true,
  username: true,
  role: true,
  type: true,
  email: true,
  status: true,
  mustResetPassword: true,
  authVersion: true,
  adminPermissionGrants: {
    select: { permissionCode: true },
  },
  userProfile: {
    select: { firstName: true, lastName: true },
  },
});
export type AuthTokenClaimsUser = Prisma.UserGetPayload<{
  select: typeof authTokenClaimsSelect;
}>;

export const profileUserSelect = Prisma.validator<Prisma.UserSelect>()({
  ...authUserSelect,
  // profileImageFile: {
  //   select: canonicalUserProfileFileSelect,
  // },
  // bannerImageFile: {
  //   select: canonicalUserProfileFileSelect,
  // },
});
export type AuthUser = Prisma.UserGetPayload<{ select: typeof authUserSelect }>;
export type ProfileUser = Prisma.UserGetPayload<{
  select: typeof profileUserSelect;
}>;
const mapFileUploadToDto = (
  file: SelectedProfileFile | undefined,
): AuthProfileImageFileDto | null => {
  if (!file) {
    return null;
  }

  return {
    id: file.id,
    s3Url: file.s3Url,
    fileName: file.fileName,
    originalName: file.originalName,
    createdAt: file.createdAt.toISOString(),
    updatedAt: file.updatedAt.toISOString(),
  };
};

const mapBrandMemberships = (
  memberships: Array<{
    brandId: string;
    role: BrandMemberRole;
    status: BrandMemberStatus;
    brand?: { id: string; name: string } | null;
  }> = [],
) =>
  memberships.map((membership) => ({
    brandId: membership.brandId,
    brandName: membership.brand?.name ?? '',
    role: membership.role,
    status: membership.status,
    isOwner: membership.role === BrandMemberRole.OWNER,
  }));

const resolveActiveBrandId = (
  user: AuthUser | ProfileUser,
  memberships: ReturnType<typeof mapBrandMemberships>,
): string | null => {
  if (user.brand?.id) {
    return user.brand.id;
  }

  const activeOwner = memberships.find(
    (membership) =>
      membership.status === BrandMemberStatus.ACTIVE &&
      membership.role === BrandMemberRole.OWNER,
  );
  if (activeOwner) {
    return activeOwner.brandId;
  }

  return (
    memberships.find(
      (membership) => membership.status === BrandMemberStatus.ACTIVE,
    )?.brandId ?? null
  );
};

export const toAuthUserResponse = (
  user: AuthUser | ProfileUser,
): AuthUserResponseDto => {
  const profileImage = resolveProfileImage(user);
  const bannerImage = resolveBannerImage(user);
  const profilePhotoUpdatedAt =
    user.userProfile?.profilePhotoUpdatedAt ??
    (profileImage.url || profileImage.fileId
      ? user.userProfile?.updatedAt
      : null);
  const brandProfile = normalizeBrandProfileForAuthResponse(user);
  const verificationTruth = getBrandVerificationTruth({
    verificationStatus: user.brand?.verificationStatus,
    isStoreOpen: user.brand?.isStoreOpen,
    ownerStatus: user.status ?? null,
  });
  const brandMemberships = mapBrandMemberships(user.brandMemberships ?? []);
  const activeBrandId = resolveActiveBrandId(user, brandMemberships);

  return {
    id: user.id,
    username: user.username,
    email: user.email,
    firstName: resolveRequiredProfileField(user, 'firstName'),
    lastName: resolveRequiredProfileField(user, 'lastName'),
    role: user.role,
    type: user.type,
    phoneNumber: resolveNullableProfileField(user, 'phoneNumber'),
    address: resolveNullableProfileField(user, 'address'),
    brandFullName: brandProfile.brandFullName,
    brandDescription: brandProfile.brandDescription,
    brandCountry: brandProfile.brandCountry,
    brandState: brandProfile.brandState,
    brandCity: brandProfile.brandCity,
    brandTags: brandProfile.brandTags,
    brandBusinessType: brandProfile.brandBusinessType,
    socialInstagram: brandProfile.socialInstagram,
    socialFacebook: brandProfile.socialFacebook,
    socialTwitter: brandProfile.socialTwitter,
    socialWebsite: brandProfile.socialWebsite,
    cacNumber: brandProfile.cacNumber,
    tin: brandProfile.tin,
    ceoNin: brandProfile.ceoNin,
    ceoFirstName: brandProfile.ceoFirstName,
    ceoLastName: brandProfile.ceoLastName,
    companyLocation: brandProfile.companyLocation,
    profileImage: profileImage.url,
    profileImageId: profileImage.fileId,
    profileImageFile: mapFileUploadToDto(profileImage.file),
    profilePhotoUpdatedAt: profilePhotoUpdatedAt?.toISOString() ?? null,
    bannerImage: bannerImage.url,
    bannerImageId: bannerImage.fileId,
    bannerImageFile: mapFileUploadToDto(bannerImage.file),
    isEmailVerified: user.isEmailVerified,
    passwordCredentialStatus:
      user.passwordCredentialStatus ?? PasswordCredentialStatus.ENABLED,
    storeId: user.brand?.id ?? null,
    brandMemberships,
    activeBrandId,
    verificationStatus: user.brand?.verificationStatus ?? null,
    isVerifiedBrand: verificationTruth.isVerifiedBrand,
    verificationBadgeVisible: verificationTruth.verificationBadgeVisible,
    verifiedExplanationUrl: verificationTruth.verifiedExplanationUrl,
    isActive: user.isActive,
    themePreference: normalizeThemePreference(user.themePreference),
    status: user.status ?? null,
    mustResetPassword: user.mustResetPassword ?? false,
    createdAt: user.createdAt.toISOString(),
    updatedAt: user.updatedAt.toISOString(),
  };
};
export const toAuthUsersResponse = (
  users: Array<AuthUser | ProfileUser>,
): AuthUserResponseDto[] => users.map((user) => toAuthUserResponse(user));
export const buildAuthTokenPayload = (
  user: AuthUser | AuthTokenClaimsUser,
): AuthJwtClaims => {
  // Read the two name fields directly rather than through
  // `resolveRequiredProfileField`, whose parameter type demands the full
  // profile projection. The claims-only select carries just these two, which is
  // the entire point of it.
  const base: AuthJwtClaims = {
    sub: user.id,
    username: user.username,
    role: user.role,
    type: user.type,
    email: user.email,
    firstName: user.userProfile?.firstName ?? '',
    lastName: user.userProfile?.lastName ?? '',
    authVersion: user.authVersion ?? 0,
  };

  // Embed admin permissions in JWT for zero-DB-query guard checks
  if (user.role === 'SuperAdmin' || user.role === 'Admin') {
    base.permissions =
      user.adminPermissionGrants?.map((grant) => grant.permissionCode) ?? [];
  }

  return base;
};
