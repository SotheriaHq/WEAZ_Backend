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
