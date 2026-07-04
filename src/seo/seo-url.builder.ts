import { getSeoSiteBaseUrl } from './seo.config';

export function buildAbsoluteWebPath(path: string): string {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return new URL(normalizedPath, `${getSeoSiteBaseUrl()}/`).toString();
}

export function buildBrandPath(slug: string): string {
  return `/brand/${encodeURIComponent(slug)}`;
}

export function buildProductPath(product: {
  slug?: string | null;
  id: string;
}): string {
  const slug = product.slug?.trim();
  if (slug) {
    return `/p/${encodeURIComponent(slug)}`;
  }
  return `/products/${encodeURIComponent(product.id)}`;
}

export function buildDesignPath(designId: string): string {
  return `/designs/${encodeURIComponent(designId)}`;
}

export function buildCollectionPath(collectionId: string): string {
  return `/collections/${encodeURIComponent(collectionId)}`;
}

export function buildProfilePath(profile: {
  username?: string | null;
  id: string;
}): string {
  const username = profile.username?.trim();
  if (username) {
    return `/u/${encodeURIComponent(username)}`;
  }
  return `/profile/${encodeURIComponent(profile.id)}`;
}