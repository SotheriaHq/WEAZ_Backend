import {
  canonicalUserProfileSelect,
  resolveProfileImage,
  resolveRequiredProfileField,
} from 'src/common/user-profile-source.helper';

export const adminUserDisplaySelect = {
  id: true,
  email: true,
  username: true,
  role: true,
  type: true,
  status: true,
  userProfile: { select: canonicalUserProfileSelect },
} as const;

export function mapAdminUserDisplay<T extends { userProfile?: unknown } | null>(
  user: T,
) {
  if (!user) return user;
  const { userProfile, ...rest } = user as any;
  const profileImage = resolveProfileImage({ userProfile: userProfile as any });
  return {
    ...rest,
    firstName: resolveRequiredProfileField(
      { userProfile: userProfile as any },
      'firstName',
    ),
    lastName: resolveRequiredProfileField(
      { userProfile: userProfile as any },
      'lastName',
    ),
    profileImage: profileImage.url,
    profileImageId: profileImage.fileId,
    profileImageFile: profileImage.file,
  };
}
