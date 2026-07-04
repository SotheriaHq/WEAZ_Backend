export type SeoRouteKind =
  | 'home'
  | 'market'
  | 'legal'
  | 'brand'
  | 'product_slug'
  | 'product_id'
  | 'design'
  | 'collection'
  | 'profile_username'
  | 'profile_id'
  | 'unknown';

export interface ParsedSeoPath {
  kind: SeoRouteKind;
  slug?: string;
  id?: string;
  legalKey?: string;
}

const LEGAL_PATHS = new Set([
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
]);

export function parseSeoPath(pathname: string): ParsedSeoPath {
  if (pathname === '/' || pathname === '') {
    return { kind: 'home' };
  }

  if (pathname === '/market' || pathname === '/market-place') {
    return { kind: 'market' };
  }

  if (LEGAL_PATHS.has(pathname)) {
    return { kind: 'legal', legalKey: pathname };
  }

  const brandMatch = pathname.match(/^\/brand\/([^/]+)$/);
  if (brandMatch?.[1]) {
    return { kind: 'brand', slug: decodeURIComponent(brandMatch[1]) };
  }

  const productSlugMatch = pathname.match(/^\/p\/([^/]+)$/);
  if (productSlugMatch?.[1]) {
    return { kind: 'product_slug', slug: decodeURIComponent(productSlugMatch[1]) };
  }

  const productIdMatch = pathname.match(/^\/products\/([^/]+)$/);
  if (productIdMatch?.[1] && productIdMatch[1] !== 'create') {
    return { kind: 'product_id', id: decodeURIComponent(productIdMatch[1]) };
  }

  const designMatch = pathname.match(/^\/designs\/([^/]+)$/);
  if (designMatch?.[1] && designMatch[1] !== 'create') {
    return { kind: 'design', id: decodeURIComponent(designMatch[1]) };
  }

  const collectionMatch = pathname.match(/^\/collections\/([^/]+)$/);
  if (collectionMatch?.[1] && collectionMatch[1] !== 'create') {
    return { kind: 'collection', id: decodeURIComponent(collectionMatch[1]) };
  }

  const usernameMatch = pathname.match(/^\/u\/([^/]+)$/);
  if (usernameMatch?.[1]) {
    return { kind: 'profile_username', slug: decodeURIComponent(usernameMatch[1]) };
  }

  const profileMatch = pathname.match(/^\/profile\/([^/]+)$/);
  if (profileMatch?.[1]) {
    return { kind: 'profile_id', id: decodeURIComponent(profileMatch[1]) };
  }

  return { kind: 'unknown' };
}