import {
  getDefaultSeoImageUrl,
  getDefaultSiteTitle,
  getSeoSiteBaseUrl,
} from './seo.config';
import { buildAbsoluteWebPath } from './seo-url.builder';

export function buildOrganizationJsonLd(): Record<string, unknown> {
  const baseUrl = getSeoSiteBaseUrl();
  return {
    '@type': 'Organization',
    name: getDefaultSiteTitle(),
    url: baseUrl,
    logo: getDefaultSeoImageUrl(),
  };
}

export function buildWebSiteJsonLd(): Record<string, unknown> {
  const baseUrl = getSeoSiteBaseUrl();
  return {
    '@type': 'WebSite',
    name: getDefaultSiteTitle(),
    url: baseUrl,
    potentialAction: {
      '@type': 'SearchAction',
      target: {
        '@type': 'EntryPoint',
        urlTemplate: `${baseUrl}/search?q={search_term_string}`,
      },
      'query-input': 'required name=search_term_string',
    },
  };
}

export function buildHomeJsonLd(): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@graph': [buildOrganizationJsonLd(), buildWebSiteJsonLd()],
  };
}

export function buildBreadcrumbJsonLd(
  items: Array<{ name: string; path: string }>,
): Record<string, unknown> {
  return {
    '@type': 'BreadcrumbList',
    itemListElement: items.map((item, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      name: item.name,
      item: buildAbsoluteWebPath(item.path),
    })),
  };
}

export function mergeJsonLdGraph(
  ...nodes: Array<Record<string, unknown> | undefined>
): Record<string, unknown> {
  const graph = nodes.filter(
    (node): node is Record<string, unknown> => Boolean(node),
  );
  if (graph.length === 1) {
    return { '@context': 'https://schema.org', ...graph[0] };
  }
  return {
    '@context': 'https://schema.org',
    '@graph': graph,
  };
}

export function humanizeMarketSectionKey(sectionKey: string): string {
  return sectionKey
    .split(/[-_]/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(' ');
}