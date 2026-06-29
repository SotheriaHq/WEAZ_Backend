import { Prisma, ProfileVisibility } from '@prisma/client';

export const canonicalUserProfileFileSelect =
  Prisma.validator<Prisma.FileUploadSelect>()({
    id: true,
    s3Key: true,
    s3Url: true,
    fileName: true,
    originalName: true,
    processingStatus: true,
    originalDeletedAt: true,
    createdAt: true,
    updatedAt: true,
  });

export const canonicalUserProfileSelect =
  Prisma.validator<Prisma.UserProfileSelect>()({
    firstName: true,
    lastName: true,
    phoneNumber: true,
    address: true,
    profileImage: true,
    profileImageId: true,
    profilePhotoUpdatedAt: true,
    updatedAt: true,
    profileImageFile: {
      select: canonicalUserProfileFileSelect,
    },
    bannerImage: true,
    bannerImageId: true,
    bannerImageFile: {
      select: canonicalUserProfileFileSelect,
    },
    profileVisibility: true,
  });

export type CanonicalUserProfile = Prisma.UserProfileGetPayload<{
  select: typeof canonicalUserProfileSelect;
}>;

export type SelectedProfileFile = Prisma.FileUploadGetPayload<{
  select: typeof canonicalUserProfileFileSelect;
}> | null;

export type UserProfileSource = {
  firstName?: string | null;
  lastName?: string | null;
  phoneNumber?: string | null;
  address?: string | null;
  profileImage?: string | null;
  profileImageId?: string | null;
  profilePhotoUpdatedAt?: Date | string | null;
  updatedAt?: Date | string | null;
  profileImageFile?: SelectedProfileFile;
  bannerImage?: string | null;
  bannerImageId?: string | null;
  bannerImageFile?: SelectedProfileFile;
  profileVisibility?: ProfileVisibility | null;
  userProfile?: CanonicalUserProfile | null;
};

type RequiredProfileField = 'firstName' | 'lastName';
type NullableProfileField = 'phoneNumber' | 'address';
type MediaKind = 'profile' | 'banner';
export type RejectedProfileMediaUrlReason =
  | 'temporary-client-url'
  | 'signed-display-url';

export type ResolvedProfileMedia = {
  url: string | null;
  fileId: string | null;
  file: SelectedProfileFile;
};

export function resolveRequiredProfileField(
  user: UserProfileSource,
  field: RequiredProfileField,
): string {
  return user.userProfile?.[field] ?? '';
}

export function resolveNullableProfileField(
  user: UserProfileSource,
  field: NullableProfileField,
): string | null {
  return user.userProfile?.[field] ?? null;
}

function filledString(value?: string | null): string | null {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized.length > 0 ? normalized : null;
}

export function getRejectedProfileMediaUrlReason(
  value?: string | null,
): RejectedProfileMediaUrlReason | null {
  const normalized = filledString(value);
  if (!normalized) return null;

  if (/^(blob|data):/i.test(normalized)) {
    return 'temporary-client-url';
  }

  try {
    const parsed = new URL(normalized);
    const hasSignedParams = Boolean(
      parsed.searchParams.get('X-Amz-Signature') ||
        parsed.searchParams.get('Signature') ||
        parsed.searchParams.get('Expires') ||
        parsed.searchParams.get('expires') ||
        parsed.searchParams.get('token'),
    );
    return hasSignedParams ? 'signed-display-url' : null;
  } catch {
    return null;
  }
}

export function normalizeProfileMediaUrlForPersistence(
  value?: string | null,
): string | null | undefined {
  if (value === undefined) return undefined;
  return filledString(value);
}

function resolveProfileMedia(
  user: UserProfileSource,
  kind: MediaKind,
): ResolvedProfileMedia {
  const profile = user.userProfile ?? null;
  const urlField = kind === 'profile' ? 'profileImage' : 'bannerImage';
  const idField = kind === 'profile' ? 'profileImageId' : 'bannerImageId';
  const fileField = kind === 'profile' ? 'profileImageFile' : 'bannerImageFile';

  const canonicalId = profile?.[idField] ?? null;
  const canonicalFile = profile?.[fileField] ?? null;
  const file = canonicalFile ?? null;

  return {
    url: filledString(profile?.[urlField]) ?? filledString(file?.s3Url),
    fileId: canonicalId ?? file?.id ?? null,
    file,
  };
}

export function resolveProfileImage(
  user: UserProfileSource,
): ResolvedProfileMedia {
  return resolveProfileMedia(user, 'profile');
}

export function resolveBannerImage(
  user: UserProfileSource,
): ResolvedProfileMedia {
  return resolveProfileMedia(user, 'banner');
}

export function resolveProfileVisibility(
  user: UserProfileSource,
): ProfileVisibility {
  return user.userProfile?.profileVisibility ?? ProfileVisibility.UNLOCKED;
}
