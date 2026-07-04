import { resolveWebAppBaseUrl } from '../common/utils/web-app-url';
import {
  PRODUCT_CATEGORY,
  PRODUCT_NAME,
  PRODUCT_TAGLINE,
} from '../common/branding/product-identity.constants';

const parseBoolean = (value: string | undefined, fallback: boolean): boolean => {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return fallback;
  }
  return value.trim().toLowerCase() === 'true';
};

export const SEO_DISALLOWED_PATH_PREFIXES = [
  '/studio',
  '/admin',
  '/checkout',
  '/bag',
  '/orders',
  '/messages',
  '/dashboard',
  '/login',
  '/signup',
  '/forgot-password',
  '/reset-password',
  '/verify-email',
  '/change-email',
  '/account',
  '/search',
  '/store/create',
  '/store/essentials',
  '/store/my',
  '/store/dashboard',
  '/store/payouts',
  '/custom-orders',
  '/products/create',
  '/designs/create',
  '/collections/create',
] as const;

export const SEO_STATIC_INDEXABLE_PATHS = [
  '/',
  '/market',
  '/market-place',
  '/legal',
  '/terms',
  '/privacy',
  '/cookies',
  '/community-guidelines',
  '/seller-terms',
  '/buyer-policy',
  '/payment-policy',
  '/copyright',
  '/account-deletion',
  '/help/verified-badge',
] as const;

export const SEO_LEGAL_LABELS: Record<string, string> = {
  '/legal': 'Legal',
  '/terms': 'Terms and Conditions',
  '/privacy': 'Privacy Policy',
  '/cookies': 'Cookie and Tracking Policy',
  '/community-guidelines': 'Community Guidelines',
  '/seller-terms': 'Seller and Brand Terms',
  '/buyer-policy': 'Buyer Marketplace Policy',
  '/payment-policy': 'Payment, Billing, and Subscription Policy',
  '/copyright': 'Content, IP, and Copyright Policy',
  '/account-deletion': 'Account and Data Deletion Policy',
  '/help/verified-badge': 'Verified Badge',
};

export function isSeoIndexingEnabled(): boolean {
  return parseBoolean(process.env.SEO_INDEXING_ENABLED, true);
}

export function getSeoSiteBaseUrl(): string {
  return resolveWebAppBaseUrl();
}

export function getDefaultSeoImageUrl(): string {
  return new URL('/brand/wiez-logo-mark.svg', `${getSeoSiteBaseUrl()}/`).toString();
}

export function getDefaultSiteTitle(): string {
  return PRODUCT_NAME;
}

export function getDefaultSiteDescription(): string {
  return `${PRODUCT_TAGLINE} ${PRODUCT_CATEGORY}.`;
}

export function normalizeSeoPath(rawPath?: string | null): string {
  const trimmed = String(rawPath ?? '').trim();
  if (!trimmed || trimmed === '/') {
    return '/';
  }

  let pathname = trimmed;
  try {
    if (/^https?:\/\//i.test(trimmed)) {
      pathname = new URL(trimmed).pathname;
    }
  } catch {
    pathname = trimmed;
  }

  if (!pathname.startsWith('/')) {
    pathname = `/${pathname}`;
  }

  const withoutQuery = pathname.split('?')[0]?.split('#')[0] ?? pathname;
  const collapsed = withoutQuery.replace(/\/+/g, '/');
  if (collapsed.length > 1 && collapsed.endsWith('/')) {
    return collapsed.slice(0, -1);
  }
  return collapsed || '/';
}

export function isSeoNoindexPath(pathname: string): boolean {
  const normalized = normalizeSeoPath(pathname);
  return SEO_DISALLOWED_PATH_PREFIXES.some(
    (prefix) =>
      normalized === prefix || normalized.startsWith(`${prefix}/`),
  );
}