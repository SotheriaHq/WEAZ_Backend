export type LegacyUserCreateCompatibilityInput = {
  firstName?: string | null;
  lastName?: string | null;
  profileImage?: string | null;
  brandFullName?: string | null;
  industriNumber?: string | null;
};

export function writeLegacyUserCompatibilityFields(
  input: LegacyUserCreateCompatibilityInput,
) {
  return {
    firstName: input.firstName ?? '',
    lastName: input.lastName ?? '',
    profileImage: input.profileImage ?? null,
    brandFullName: input.brandFullName ?? null,
    industriNumber: input.industriNumber ?? null,
  };
}

export function writeLegacyUserAnonymizationFields(userId: string) {
  return {
    email: `deleted-${userId.slice(0, 8)}@erased.local`,
    username: `deleted-${userId.slice(0, 8)}`,
    password: '',
    firstName: 'Deleted',
    lastName: 'User',
    phoneNumber: null,
    profileImage: null,
    bannerImage: null,
    address: null,
    brandFullName: null,
    brandDescription: null,
    companyLocation: null,
  };
}
