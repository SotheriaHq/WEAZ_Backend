import { LegalDocumentKey } from '@prisma/client';

export type LegalDocumentDefinition = {
  key: LegalDocumentKey;
  title: string;
  slug: string;
  route: string;
  version: string;
  effectiveDate: string;
  owner: 'legal' | 'trust-safety' | 'payments' | 'commerce';
  requiresCounselReview: boolean;
};

export const LEGAL_VERSION = '2026.06.08-weaz-draft.1';
export const LEGAL_EFFECTIVE_DATE =
  '[LAWYER REVIEW] effective date pending counsel approval';

export const LEGAL_DOCUMENTS: Record<
  LegalDocumentKey,
  LegalDocumentDefinition
> = {
  [LegalDocumentKey.TERMS_OF_SERVICE]: {
    key: LegalDocumentKey.TERMS_OF_SERVICE,
    title: 'Terms and Conditions',
    slug: 'terms',
    route: '/terms',
    version: LEGAL_VERSION,
    effectiveDate: LEGAL_EFFECTIVE_DATE,
    owner: 'legal',
    requiresCounselReview: true,
  },
  [LegalDocumentKey.PRIVACY_POLICY]: {
    key: LegalDocumentKey.PRIVACY_POLICY,
    title: 'Privacy Policy',
    slug: 'privacy',
    route: '/privacy',
    version: LEGAL_VERSION,
    effectiveDate: LEGAL_EFFECTIVE_DATE,
    owner: 'legal',
    requiresCounselReview: true,
  },
  [LegalDocumentKey.COOKIE_POLICY]: {
    key: LegalDocumentKey.COOKIE_POLICY,
    title: 'Cookie Policy',
    slug: 'cookies',
    route: '/cookies',
    version: LEGAL_VERSION,
    effectiveDate: LEGAL_EFFECTIVE_DATE,
    owner: 'legal',
    requiresCounselReview: true,
  },
  [LegalDocumentKey.COMMUNITY_GUIDELINES]: {
    key: LegalDocumentKey.COMMUNITY_GUIDELINES,
    title: 'Community Guidelines',
    slug: 'community-guidelines',
    route: '/community-guidelines',
    version: LEGAL_VERSION,
    effectiveDate: LEGAL_EFFECTIVE_DATE,
    owner: 'trust-safety',
    requiresCounselReview: true,
  },
  [LegalDocumentKey.SELLER_TERMS]: {
    key: LegalDocumentKey.SELLER_TERMS,
    title: 'Seller Terms',
    slug: 'seller-terms',
    route: '/seller-terms',
    version: LEGAL_VERSION,
    effectiveDate: LEGAL_EFFECTIVE_DATE,
    owner: 'commerce',
    requiresCounselReview: true,
  },
  [LegalDocumentKey.STORE_GUIDELINES]: {
    key: LegalDocumentKey.STORE_GUIDELINES,
    title: 'Store Guidelines',
    slug: 'store-guidelines',
    route: '/seller-terms#store-guidelines',
    version: LEGAL_VERSION,
    effectiveDate: LEGAL_EFFECTIVE_DATE,
    owner: 'commerce',
    requiresCounselReview: true,
  },
  [LegalDocumentKey.BUYER_POLICY]: {
    key: LegalDocumentKey.BUYER_POLICY,
    title: 'Buyer Policy',
    slug: 'buyer-policy',
    route: '/buyer-policy',
    version: LEGAL_VERSION,
    effectiveDate: LEGAL_EFFECTIVE_DATE,
    owner: 'commerce',
    requiresCounselReview: true,
  },
  [LegalDocumentKey.PAYMENT_POLICY]: {
    key: LegalDocumentKey.PAYMENT_POLICY,
    title: 'Payment, Billing, and Subscription Policy',
    slug: 'payment-policy',
    route: '/payment-policy',
    version: LEGAL_VERSION,
    effectiveDate: LEGAL_EFFECTIVE_DATE,
    owner: 'payments',
    requiresCounselReview: true,
  },
  [LegalDocumentKey.COPYRIGHT_POLICY]: {
    key: LegalDocumentKey.COPYRIGHT_POLICY,
    title: 'Content, IP, and Copyright Policy',
    slug: 'copyright',
    route: '/copyright',
    version: LEGAL_VERSION,
    effectiveDate: LEGAL_EFFECTIVE_DATE,
    owner: 'trust-safety',
    requiresCounselReview: true,
  },
  [LegalDocumentKey.ACCOUNT_DELETION_POLICY]: {
    key: LegalDocumentKey.ACCOUNT_DELETION_POLICY,
    title: 'Account and Data Deletion Policy',
    slug: 'account-deletion',
    route: '/account-deletion',
    version: LEGAL_VERSION,
    effectiveDate: LEGAL_EFFECTIVE_DATE,
    owner: 'legal',
    requiresCounselReview: true,
  },
  [LegalDocumentKey.CONTENT_POLICY]: {
    key: LegalDocumentKey.CONTENT_POLICY,
    title: 'Content Policy',
    slug: 'content-policy',
    route: '/community-guidelines#content-policy',
    version: LEGAL_VERSION,
    effectiveDate: LEGAL_EFFECTIVE_DATE,
    owner: 'trust-safety',
    requiresCounselReview: true,
  },
};

export const LEGAL_REQUIRED_DOCUMENTS = {
  signup: [
    LegalDocumentKey.TERMS_OF_SERVICE,
    LegalDocumentKey.PRIVACY_POLICY,
  ],
  checkout: [LegalDocumentKey.PAYMENT_POLICY],
  storePublish: [
    LegalDocumentKey.SELLER_TERMS,
    LegalDocumentKey.STORE_GUIDELINES,
  ],
  contentPublish: [
    LegalDocumentKey.CONTENT_POLICY,
    LegalDocumentKey.COMMUNITY_GUIDELINES,
    LegalDocumentKey.COPYRIGHT_POLICY,
  ],
} as const;
