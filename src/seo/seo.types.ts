export type SeoRobotsDirective = 'index,follow' | 'noindex,nofollow';

export interface SeoOpenGraphMeta {
  title: string;
  description: string;
  image?: string;
  type: string;
  url: string;
}

export interface SeoTwitterMeta {
  card: 'summary' | 'summary_large_image';
  title: string;
  description: string;
  image?: string;
}

export interface SeoPageMeta {
  canonicalUrl: string;
  title: string;
  description: string;
  robots: SeoRobotsDirective;
  og: SeoOpenGraphMeta;
  twitter: SeoTwitterMeta;
  jsonLd?: Record<string, unknown>;
  httpStatus: 200 | 404;
}

export interface SeoSitemapEntry {
  loc: string;
  lastmod?: string;
}