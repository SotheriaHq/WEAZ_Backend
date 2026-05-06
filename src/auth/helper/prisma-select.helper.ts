import { Prisma } from '@prisma/client';
import {
  AuthJwtClaims,
  AuthProfileImageFileDto,
  AuthUserResponseDto,
} from '../dto/auth-response.dto';
import { getBrandVerificationTruth } from 'src/brand-verification/verification-truth.util';
import { normalizeThemePreference } from 'src/common/theme.contract';

type SelectedFileUpload = {
  id: string;
  s3Url: string;
  fileName: string | null;
  originalName: string | null;
  createdAt: Date;
  updatedAt: Date;
} | null;

const userProfileSelect = Prisma.validator<Prisma.UserProfileSelect>()({
  firstName: true,
  lastName: true,
  phoneNumber: true,
  address: true,
  profileImage: true,
  profileImageId: true,
  profileImageFile: {
    select: {
      id: true,
      s3Url: true,
      fileName: true,
      originalName: true,
      createdAt: true,
      updatedAt: true,
    },
  },
  bannerImage: true,
  bannerImageId: true,
  bannerImageFile: {
    select: {
      id: true,
      s3Url: true,
      fileName: true,
      originalName: true,
      createdAt: true,
      updatedAt: true,
    },
  },
  profileVisibility: true,
});

export const authUserSelect = Prisma.validator<Prisma.UserSelect>()({
  id: true,
  username: true,
  role: true,
  type: true,
  firstName: true,
  lastName: true,
  email: true,
  status: true,
  brand: {
    select: {
      id: true,
      name: true,
      isStoreOpen: true,
      verificationStatus: true,
    },
  },
  adminPermissionGrants: {
    select: { permissionCode: true },
  },
  phoneNumber: true,
  address: true,
  brandFullName: true,
  brandDescription: true,
  brandCountry: true,
  brandState: true,
  brandCity: true,
  brandTags: true,
  brandBusinessType: true,
  socialInstagram: true,
  socialFacebook: true,
  socialTwitter: true,
  socialWebsite: true,
  cacNumber: true,
  tin: true,
  ceoNin: true,
  ceoFirstName: true,
  ceoLastName: true,
  companyLocation: true,
  profileImage: true,
  profileImageId: true,
  bannerImage: true,
  bannerImageId: true,
  isEmailVerified: true,
  isActive: true,
  themePreference: true,
  mustResetPassword: true,
  authVersion: true,
  createdAt: true,
  updatedAt: true,
  userProfile: {
    select: userProfileSelect,
  },
});
export const profileUserSelect = Prisma.validator<Prisma.UserSelect>()({
  ...authUserSelect,
  profileImageFile: {
    select: {
      id: true,
      s3Url: true,
      fileName: true,
      originalName: true,
      createdAt: true,
      updatedAt: true,
    },
  },
  bannerImageFile: {
    select: {
      id: true,
      s3Url: true,
      fileName: true,
      originalName: true,
      createdAt: true,
      updatedAt: true,
    },
  },
});
export type AuthUser = Prisma.UserGetPayload<{ select: typeof authUserSelect }>;
export type ProfileUser = Prisma.UserGetPayload<{
  select: typeof profileUserSelect;
}>;
const mapFileUploadToDto = (
  file: SelectedFileUpload | undefined,
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
export const toAuthUserResponse = (
  user: AuthUser | ProfileUser,
): AuthUserResponseDto => {
  const profile = (user as any).userProfile ?? null;
  const verificationTruth = getBrandVerificationTruth({
    verificationStatus: user.brand?.verificationStatus,
    isStoreOpen: user.brand?.isStoreOpen,
    ownerStatus: (user as any).status ?? null,
  });

  return {
    id: user.id,
    username: user.username,
    email: user.email,
    firstName: profile?.firstName ?? user.firstName,
    lastName: profile?.lastName ?? user.lastName,
    role: user.role,
    type: user.type,
    phoneNumber: profile?.phoneNumber ?? user.phoneNumber ?? null,
    address: profile?.address ?? user.address ?? null,
    brandFullName: user.brandFullName ?? null,
    brandDescription: user.brandDescription ?? null,
    brandCountry: user.brandCountry ?? null,
    brandState: user.brandState ?? null,
    brandCity: user.brandCity ?? null,
    brandTags: user.brandTags ?? [],
    brandBusinessType: user.brandBusinessType ?? null,
    socialInstagram: user.socialInstagram ?? null,
    socialFacebook: user.socialFacebook ?? null,
    socialTwitter: user.socialTwitter ?? null,
    socialWebsite: user.socialWebsite ?? null,
    cacNumber: user.cacNumber ?? null,
    tin: user.tin ?? null,
    ceoNin: user.ceoNin ?? null,
    ceoFirstName: user.ceoFirstName ?? null,
    ceoLastName: user.ceoLastName ?? null,
    companyLocation: user.companyLocation ?? null,
    profileImage: profile?.profileImage ?? user.profileImage ?? null,
    profileImageId: profile?.profileImageId ?? user.profileImageId ?? null,
    profileImageFile:
      profile?.profileImageFile
        ? mapFileUploadToDto(profile.profileImageFile)
        : 'profileImageFile' in user
        ? mapFileUploadToDto((user as ProfileUser).profileImageFile)
        : null,
    bannerImage: profile?.bannerImage ?? user.bannerImage ?? null,
    bannerImageId: profile?.bannerImageId ?? user.bannerImageId ?? null,
    bannerImageFile:
      profile?.bannerImageFile
        ? mapFileUploadToDto(profile.bannerImageFile)
        : 'bannerImageFile' in user
        ? mapFileUploadToDto((user as ProfileUser).bannerImageFile ?? null)
        : null,
    isEmailVerified: user.isEmailVerified,
    storeId: user.brand?.id ?? null,
    verificationStatus: user.brand?.verificationStatus ?? null,
    isVerifiedBrand: verificationTruth.isVerifiedBrand,
    verificationBadgeVisible: verificationTruth.verificationBadgeVisible,
    verifiedExplanationUrl: verificationTruth.verifiedExplanationUrl,
    isActive: user.isActive,
    themePreference: normalizeThemePreference((user as any).themePreference),
    status: (user as any).status ?? null,
    mustResetPassword: (user as any).mustResetPassword ?? false,
    createdAt: user.createdAt.toISOString(),
    updatedAt: user.updatedAt.toISOString(),
  };
};
export const toAuthUsersResponse = (
  users: Array<AuthUser | ProfileUser>,
): AuthUserResponseDto[] => users.map((user) => toAuthUserResponse(user));
export const buildAuthTokenPayload = (user: AuthUser): AuthJwtClaims => {
  const base: AuthJwtClaims = {
    sub: user.id,
    username: user.username,
    role: user.role,
    type: user.type,
    email: user.email,
    firstName: user.firstName,
    lastName: user.lastName,
    authVersion: (user as any).authVersion ?? 0,
  };

  // Embed admin permissions in JWT for zero-DB-query guard checks
  if (user.role === 'SuperAdmin' || user.role === 'Admin') {
    base.permissions = (user as any).adminPermissionGrants?.map(
      (g: { permissionCode: string }) => g.permissionCode,
    ) ?? [];
  }

  return base;
};
