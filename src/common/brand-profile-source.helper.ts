import { BrandVerificationStatus, Prisma } from '@prisma/client';

export const canonicalBrandFileSelect =
  Prisma.validator<Prisma.FileUploadSelect>()({
    id: true,
    s3Url: true,
    fileName: true,
    originalName: true,
    createdAt: true,
    updatedAt: true,
  });

export const canonicalBrandProfileSelect =
  Prisma.validator<Prisma.BrandSelect>()({
    id: true,
    name: true,
    description: true,
    logo: true,
    banner: true,
    tags: true,
    country: true,
    state: true,
    city: true,
    businessType: true,
    companyLocation: true,
    socialInstagram: true,
    socialFacebook: true,
    socialTwitter: true,
    socialWebsite: true,
    cacNumber: true,
    tin: true,
    ceoNin: true,
    ceoFirstName: true,
    ceoLastName: true,
    industriNumber: true,
    isStoreOpen: true,
    verificationStatus: true,
    avgRating: true,
    totalReviews: true,
  });

export type CanonicalBrandProfile = Prisma.BrandGetPayload<{
  select: typeof canonicalBrandProfileSelect;
}>;

type LegacyBrandProfileSource = {
  brandFullName?: string | null;
  brandDescription?: string | null;
  brandCountry?: string | null;
  brandState?: string | null;
  brandCity?: string | null;
  brandTags?: string[] | null;
  brandBusinessType?: string | null;
  socialInstagram?: string | null;
  socialFacebook?: string | null;
  socialTwitter?: string | null;
  socialWebsite?: string | null;
  cacNumber?: string | null;
  tin?: string | null;
  ceoNin?: string | null;
  ceoFirstName?: string | null;
  ceoLastName?: string | null;
  companyLocation?: string | null;
  industriNumber?: string | null;
  brand?: Partial<CanonicalBrandProfile> | null;
  userProfile?: {
    firstName?: string | null;
    lastName?: string | null;
    address?: string | null;
  } | null;
};

type RequiredBrandField = 'brandFullName';
type NullableBrandField =
  | 'brandDescription'
  | 'brandCountry'
  | 'brandState'
  | 'brandCity'
  | 'brandBusinessType'
  | 'socialInstagram'
  | 'socialFacebook'
  | 'socialTwitter'
  | 'socialWebsite'
  | 'cacNumber'
  | 'tin'
  | 'ceoNin'
  | 'ceoFirstName'
  | 'ceoLastName'
  | 'companyLocation'
  | 'industriNumber';

const brandFieldMap: Record<
  RequiredBrandField | NullableBrandField,
  keyof CanonicalBrandProfile
> = {
  brandFullName: 'name',
  brandDescription: 'description',
  brandCountry: 'country',
  brandState: 'state',
  brandCity: 'city',
  brandBusinessType: 'businessType',
  socialInstagram: 'socialInstagram',
  socialFacebook: 'socialFacebook',
  socialTwitter: 'socialTwitter',
  socialWebsite: 'socialWebsite',
  cacNumber: 'cacNumber',
  tin: 'tin',
  ceoNin: 'ceoNin',
  ceoFirstName: 'ceoFirstName',
  ceoLastName: 'ceoLastName',
  companyLocation: 'companyLocation',
  industriNumber: 'industriNumber',
};

function filled(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function resolveRequiredBrandField(
  user: LegacyBrandProfileSource,
  field: RequiredBrandField,
): string {
  const brandField = brandFieldMap[field];
  return filled(user.brand?.[brandField]) ?? '';
}

export function resolveNullableBrandField(
  user: LegacyBrandProfileSource,
  field: NullableBrandField,
): string | null {
  const brandField = brandFieldMap[field];
  return filled(user.brand?.[brandField]) ?? null;
}

export function resolveBrandTags(user: LegacyBrandProfileSource): string[] {
  const brandTags = user.brand?.tags;
  if (Array.isArray(brandTags) && brandTags.length > 0) {
    return brandTags;
  }
  return [];
}

export function resolveBrandSocialLinks(user: LegacyBrandProfileSource): {
  instagram: string | null;
  facebook: string | null;
  twitter: string | null;
  website: string | null;
} {
  return {
    instagram: resolveNullableBrandField(user, 'socialInstagram'),
    facebook: resolveNullableBrandField(user, 'socialFacebook'),
    twitter: resolveNullableBrandField(user, 'socialTwitter'),
    website: resolveNullableBrandField(user, 'socialWebsite'),
  };
}

export function resolveBrandVerificationFields(
  user: LegacyBrandProfileSource,
): {
  cacNumber: string | null;
  tin: string | null;
  ceoNin: string | null;
  ceoFirstName: string | null;
  ceoLastName: string | null;
  companyLocation: string | null;
  industriNumber: string | null;
} {
  return {
    cacNumber: resolveNullableBrandField(user, 'cacNumber'),
    tin: resolveNullableBrandField(user, 'tin'),
    ceoNin: resolveNullableBrandField(user, 'ceoNin'),
    ceoFirstName: resolveNullableBrandField(user, 'ceoFirstName'),
    ceoLastName: resolveNullableBrandField(user, 'ceoLastName'),
    companyLocation: resolveNullableBrandField(user, 'companyLocation'),
    industriNumber: resolveNullableBrandField(user, 'industriNumber'),
  };
}

export function normalizeBrandProfileForAuthResponse(
  user: LegacyBrandProfileSource,
) {
  const socialLinks = resolveBrandSocialLinks(user);
  const verificationFields = resolveBrandVerificationFields(user);

  return {
    brandFullName: resolveRequiredBrandField(user, 'brandFullName') || null,
    brandDescription: resolveNullableBrandField(user, 'brandDescription'),
    brandCountry: resolveNullableBrandField(user, 'brandCountry'),
    brandState: resolveNullableBrandField(user, 'brandState'),
    brandCity: resolveNullableBrandField(user, 'brandCity'),
    brandTags: resolveBrandTags(user),
    brandBusinessType: resolveNullableBrandField(user, 'brandBusinessType'),
    socialInstagram: socialLinks.instagram,
    socialFacebook: socialLinks.facebook,
    socialTwitter: socialLinks.twitter,
    socialWebsite: socialLinks.website,
    cacNumber: verificationFields.cacNumber,
    tin: verificationFields.tin,
    ceoNin: verificationFields.ceoNin,
    ceoFirstName: verificationFields.ceoFirstName,
    ceoLastName: verificationFields.ceoLastName,
    companyLocation: verificationFields.companyLocation,
  };
}

export function normalizeBrandProfileForBrandResponse(
  user: LegacyBrandProfileSource & {
    username?: string | null;
  },
) {
  const brandFullName =
    resolveRequiredBrandField(user, 'brandFullName') ||
    [user.userProfile?.firstName, user.userProfile?.lastName]
      .filter(Boolean)
      .join(' ')
      .trim() ||
    user.username ||
    'Brand';
  const country = resolveNullableBrandField(user, 'brandCountry');
  const state = resolveNullableBrandField(user, 'brandState');
  const city = resolveNullableBrandField(user, 'brandCity');
  const computedLocation = [city, state, country]
    .filter((part): part is string => Boolean(part))
    .join(', ');

  return {
    brandFullName,
    description: resolveNullableBrandField(user, 'brandDescription'),
    country,
    state,
    city,
    location:
      computedLocation ||
      resolveNullableBrandField(user, 'companyLocation') ||
      filled(user.userProfile?.address) ||
      null,
    businessType: resolveNullableBrandField(user, 'brandBusinessType'),
    tags: resolveBrandTags(user),
    socialLinks: resolveBrandSocialLinks(user),
    verificationFields: resolveBrandVerificationFields(user),
    verificationStatus:
      user.brand?.verificationStatus ?? BrandVerificationStatus.NOT_SUBMITTED,
  };
}
