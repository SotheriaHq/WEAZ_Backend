import { Injectable, NotFoundException } from '@nestjs/common';
import {
  CollectionStatus,
  CollectionVisibility,
  ProfileVisibility,
  UserType,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { StoreService } from '../store/store.service';
import { UserProfileService } from '../users/user-profile.service';
import {
  getDefaultSeoImageUrl,
  getDefaultSiteDescription,
  getDefaultSiteTitle,
  getSeoSiteBaseUrl,
  isSeoIndexingEnabled,
  isSeoNoindexPath,
  normalizeSeoPath,
  SEO_DISALLOWED_PATH_PREFIXES,
  SEO_LEGAL_LABELS,
  SEO_STATIC_INDEXABLE_PATHS,
} from './seo.config';
import {
  buildBreadcrumbJsonLd,
  buildHomeJsonLd,
  humanizeMarketSectionKey,
  mergeJsonLdGraph,
} from './seo-schema.helpers';
import { parseSeoPath } from './seo-path.parser';
import type { SeoPageMeta, SeoSitemapEntry } from './seo.types';
import {
  buildAbsoluteWebPath,
  buildBrandPath,
  buildCollectionPath,
  buildDesignPath,
  buildProductPath,
  buildProfilePath,
} from './seo-url.builder';

const MAX_DESCRIPTION_LENGTH = 300;
const MAX_TITLE_SUFFIX = ` | ${getDefaultSiteTitle()}`;

@Injectable()
export class SeoService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storeService: StoreService,
    private readonly userProfileService: UserProfileService,
  ) {}

  async resolvePageMeta(rawPath: string): Promise<SeoPageMeta> {
    const pathname = normalizeSeoPath(rawPath);
    const indexingEnabled = isSeoIndexingEnabled();
    const defaultRobots = indexingEnabled ? 'index,follow' : 'noindex,nofollow';

    if (isSeoNoindexPath(pathname)) {
      return this.buildMeta({
        canonicalPath: pathname,
        title: getDefaultSiteTitle(),
        description: getDefaultSiteDescription(),
        robots: 'noindex,nofollow',
        httpStatus: 404,
      });
    }

    const parsed = parseSeoPath(pathname);

    try {
      switch (parsed.kind) {
        case 'home':
          return this.buildMeta({
            canonicalPath: '/',
            title: `${getDefaultSiteTitle()} — African Fashion Marketplace`,
            description: getDefaultSiteDescription(),
            robots: defaultRobots,
            ogType: 'website',
            jsonLd: buildHomeJsonLd(),
          });
        case 'market':
          return this.buildMeta({
            canonicalPath: '/market',
            title: `Discover Designs on ${getDefaultSiteTitle()}`,
            description:
              'Browse runway designs, trending fashion, and independent brands on WIEZ.',
            robots: defaultRobots,
            ogType: 'website',
          });
        case 'market_section':
          return this.buildMarketSectionMeta(parsed.slug ?? '', defaultRobots);
        case 'legal':
          return this.buildLegalMeta(parsed.legalKey ?? '/legal', defaultRobots);
        case 'brand':
          return await this.resolveBrandMeta(parsed.slug ?? '', defaultRobots);
        case 'product_slug':
          return await this.resolveProductSlugMeta(parsed.slug ?? '', defaultRobots);
        case 'product_id':
          return await this.resolveProductIdMeta(parsed.id ?? '', defaultRobots);
        case 'design':
          return await this.resolveDesignMeta(parsed.id ?? '', defaultRobots);
        case 'collection':
          return await this.resolveCollectionMeta(parsed.id ?? '', defaultRobots);
        case 'profile_username':
          return await this.resolveProfileUsernameMeta(parsed.slug ?? '', defaultRobots);
        case 'profile_id':
          return await this.resolveProfileIdMeta(parsed.id ?? '', defaultRobots);
        default:
          return this.buildMeta({
            canonicalPath: pathname,
            title: getDefaultSiteTitle(),
            description: getDefaultSiteDescription(),
            robots: 'noindex,nofollow',
            httpStatus: 404,
          });
      }
    } catch (error) {
      if (error instanceof NotFoundException) {
        return this.buildMeta({
          canonicalPath: pathname,
          title: `Not Found | ${getDefaultSiteTitle()}`,
          description: getDefaultSiteDescription(),
          robots: 'noindex,nofollow',
          httpStatus: 404,
        });
      }
      throw error;
    }
  }

  buildRobotsTxt(): string {
    const baseUrl = getSeoSiteBaseUrl();
    const lines = [
      'User-agent: *',
      isSeoIndexingEnabled() ? 'Allow: /' : 'Disallow: /',
    ];

    if (isSeoIndexingEnabled()) {
      const disallowPrefixes = new Set<string>();
      for (const prefix of SEO_DISALLOWED_PATH_PREFIXES) {
        const normalized =
          prefix.endsWith('/') || prefix === '/search'
            ? prefix
            : `${prefix}/`;
        disallowPrefixes.add(normalized);
        if (!prefix.endsWith('/')) {
          disallowPrefixes.add(prefix);
        }
      }

      for (const prefix of Array.from(disallowPrefixes).sort()) {
        lines.push(`Disallow: ${prefix}`);
      }

      lines.push('User-agent: GPTBot');
      lines.push('Allow: /');
      lines.push('User-agent: ClaudeBot');
      lines.push('Allow: /');
    }

    lines.push('', `Sitemap: ${baseUrl}/sitemap.xml`);
    return `${lines.join('\n')}\n`;
  }

  async buildSitemapXml(): Promise<string> {
    const entries = await this.collectSitemapEntries();
    const body = entries
      .map((entry) => {
        const lastmod = entry.lastmod
          ? `\n    <lastmod>${entry.lastmod}</lastmod>`
          : '';
        return `  <url>\n    <loc>${this.escapeXml(entry.loc)}</loc>${lastmod}\n  </url>`;
      })
      .join('\n');

    return [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
      body,
      '</urlset>',
    ].join('\n');
  }

  buildBotHtml(meta: SeoPageMeta): string {
    const title = this.escapeHtml(meta.title);
    const description = this.escapeHtml(meta.description);
    const canonical = this.escapeHtml(meta.canonicalUrl);
    const ogTitle = this.escapeHtml(meta.og.title);
    const ogDescription = this.escapeHtml(meta.og.description);
    const ogUrl = this.escapeHtml(meta.og.url);
    const ogType = this.escapeHtml(meta.og.type);
    const ogImage = meta.og.image ? this.escapeHtml(meta.og.image) : '';
    const robots = this.escapeHtml(meta.robots);
    const jsonLd = meta.jsonLd
      ? `<script type="application/ld+json">${JSON.stringify(meta.jsonLd)}</script>`
      : '';

    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="${robots}" />
<title>${title}</title>
<meta name="description" content="${description}" />
<link rel="canonical" href="${canonical}" />
<meta property="og:site_name" content="${this.escapeHtml(getDefaultSiteTitle())}" />
<meta property="og:locale" content="en_US" />
<meta property="og:title" content="${ogTitle}" />
<meta property="og:description" content="${ogDescription}" />
<meta property="og:url" content="${ogUrl}" />
<meta property="og:type" content="${ogType}" />
${ogImage ? `<meta property="og:image" content="${ogImage}" />` : ''}
<meta name="twitter:card" content="${meta.twitter.card}" />
<meta name="twitter:title" content="${ogTitle}" />
<meta name="twitter:description" content="${ogDescription}" />
${ogImage ? `<meta name="twitter:image" content="${ogImage}" />` : ''}
${(meta.extraMeta ?? [])
  .map(
    (tag) =>
      `<meta ${tag.attribute}="${this.escapeHtml(tag.key)}" content="${this.escapeHtml(tag.content)}" />`,
  )
  .join('\n')}
${jsonLd}
</head>
<body>
  <h1>${title}</h1>
  <p>${description}</p>
  <p><a href="${canonical}">Continue to ${this.escapeHtml(getDefaultSiteTitle())}</a></p>
</body>
</html>`;
  }

  private async collectSitemapEntries(): Promise<SeoSitemapEntry[]> {
    if (!isSeoIndexingEnabled()) {
      return [];
    }

    const entries: SeoSitemapEntry[] = SEO_STATIC_INDEXABLE_PATHS.map((path) => ({
      loc: buildAbsoluteWebPath(path),
    }));

    const [brands, products, designs, collections] = await Promise.all([
      this.prisma.user.findMany({
        where: {
          type: UserType.BRAND,
          username: { not: '' },
          brand: { is: { isStoreOpen: true } },
        },
        select: { username: true, updatedAt: true },
        take: 5000,
        orderBy: { updatedAt: 'desc' },
      }),
      this.prisma.product.findMany({
        where: {
          slug: { not: null },
          deletedAt: null,
          archivedAt: null,
          isActive: true,
          publicationStatus: CollectionStatus.PUBLISHED,
          brand: { isStoreOpen: true },
        },
        select: { id: true, slug: true, updatedAt: true },
        take: 10000,
        orderBy: { updatedAt: 'desc' },
      }),
      // Designs are DESIGN-domain collections (→ /designs/:id).
      this.prisma.collection.findMany({
        where: {
          domain: 'DESIGN',
          status: CollectionStatus.PUBLISHED,
          visibility: CollectionVisibility.PUBLIC,
          deletedAt: null,
        },
        select: { id: true, updatedAt: true },
        take: 10000,
        orderBy: { updatedAt: 'desc' },
      }),
      // Store collections are STORE-domain collections (→ /collections/:id).
      this.prisma.collection.findMany({
        where: {
          domain: 'STORE',
          status: CollectionStatus.PUBLISHED,
          visibility: CollectionVisibility.PUBLIC,
          deletedAt: null,
        },
        select: { id: true, updatedAt: true },
        take: 10000,
        orderBy: { updatedAt: 'desc' },
      }),
    ]);

    for (const brand of brands) {
      if (!brand.username) continue;
      entries.push({
        loc: buildAbsoluteWebPath(buildBrandPath(brand.username)),
        lastmod: brand.updatedAt.toISOString(),
      });
    }

    for (const product of products) {
      entries.push({
        loc: buildAbsoluteWebPath(
          buildProductPath({ id: product.id, slug: product.slug }),
        ),
        lastmod: product.updatedAt.toISOString(),
      });
    }

    for (const design of designs) {
      entries.push({
        loc: buildAbsoluteWebPath(buildDesignPath(design.id)),
        lastmod: design.updatedAt.toISOString(),
      });
    }

    for (const collection of collections) {
      entries.push({
        loc: buildAbsoluteWebPath(buildCollectionPath(collection.id)),
        lastmod: collection.updatedAt.toISOString(),
      });
    }

    const seen = new Set<string>();
    return entries.filter((entry) => {
      if (seen.has(entry.loc)) return false;
      seen.add(entry.loc);
      return true;
    });
  }

  private buildMarketSectionMeta(
    sectionKey: string,
    robots: SeoPageMeta['robots'],
  ): SeoPageMeta {
    const label = humanizeMarketSectionKey(sectionKey);
    const canonicalPath = `/market/sections/${encodeURIComponent(sectionKey)}`;
    return this.buildMeta({
      canonicalPath,
      title: `${label} on ${getDefaultSiteTitle()}`,
      description: `Explore ${label.toLowerCase()} on WIEZ — African fashion social commerce.`,
      robots,
      ogType: 'website',
    });
  }

  private buildLegalMeta(path: string, robots: SeoPageMeta['robots']): SeoPageMeta {
    const label = SEO_LEGAL_LABELS[path] ?? 'Legal';
    return this.buildMeta({
      canonicalPath: path,
      title: `${label} | ${getDefaultSiteTitle()}`,
      description: `${label} for ${getDefaultSiteTitle()}.`,
      robots,
      ogType: 'website',
    });
  }

  private async resolveBrandMeta(
    slug: string,
    robots: SeoPageMeta['robots'],
  ): Promise<SeoPageMeta> {
    const storefront = await this.storeService.resolvePublicStorefrontBySlug(slug);
    const brand = await this.prisma.brand.findFirst({
      where: { ownerId: storefront.ownerId },
      select: {
        name: true,
        tagline: true,
        description: true,
        logo: true,
        banner: true,
        socialInstagram: true,
        socialFacebook: true,
        socialTwitter: true,
        socialWebsite: true,
        owner: { select: { username: true } },
      },
    });

    const canonicalSlug = brand?.owner?.username?.trim() || storefront.slug;
    const title = `${storefront.displayName || brand?.name || slug} on ${getDefaultSiteTitle()}`;
    const description = this.truncate(
      brand?.tagline ||
        brand?.description ||
        `Shop ${storefront.displayName || brand?.name || slug} on WIEZ.`,
    );

    const brandPath = buildBrandPath(canonicalSlug);
    const sameAs = [
      brand?.socialInstagram,
      brand?.socialFacebook,
      brand?.socialTwitter,
      brand?.socialWebsite,
    ].filter((value): value is string => Boolean(value && value.trim()));

    return this.buildMeta({
      canonicalPath: brandPath,
      title,
      description,
      robots,
      imageUrl: brand?.banner || brand?.logo || getDefaultSeoImageUrl(),
      ogType: 'website',
      jsonLd: mergeJsonLdGraph(
        {
          '@type': 'ClothingStore',
          name: storefront.displayName || brand?.name || slug,
          url: buildAbsoluteWebPath(brandPath),
          description,
          ...(brand?.logo ? { logo: brand.logo } : {}),
          ...(sameAs.length > 0 ? { sameAs } : {}),
        },
        buildBreadcrumbJsonLd([
          { name: 'Market', path: '/market' },
          { name: storefront.displayName || brand?.name || slug, path: brandPath },
        ]),
      ),
    });
  }

  private async resolveProductSlugMeta(
    slug: string,
    robots: SeoPageMeta['robots'],
  ): Promise<SeoPageMeta> {
    const resolved = await this.storeService.resolvePublicProductBySlug(slug);
    return this.resolveProductRecord(resolved.id, robots);
  }

  private async resolveProductIdMeta(
    productId: string,
    robots: SeoPageMeta['robots'],
  ): Promise<SeoPageMeta> {
    return this.resolveProductRecord(productId, robots);
  }

  private async resolveProductRecord(
    productId: string,
    robots: SeoPageMeta['robots'],
  ): Promise<SeoPageMeta> {
    const product = await this.prisma.product.findFirst({
      where: { id: productId, deletedAt: null },
      select: {
        id: true,
        slug: true,
        name: true,
        description: true,
        metaTitle: true,
        metaDescription: true,
        thumbnail: true,
        price: true,
        salePrice: true,
        saleStartAt: true,
        saleEndAt: true,
        currency: true,
        sku: true,
        avgRating: true,
        totalReviews: true,
        publicationStatus: true,
        isActive: true,
        archivedAt: true,
        brand: {
          select: {
            isStoreOpen: true,
            name: true,
            owner: { select: { username: true } },
          },
        },
      },
    });

    if (
      !product ||
      product.archivedAt ||
      product.isActive === false ||
      product.publicationStatus !== CollectionStatus.PUBLISHED ||
      !product.brand?.isStoreOpen
    ) {
      throw new NotFoundException('Product not found');
    }

    const title =
      product.metaTitle?.trim() ||
      `${product.name}${product.brand?.name ? ` by ${product.brand.name}` : ''}${MAX_TITLE_SUFFIX}`;
    const description = this.truncate(
      product.metaDescription?.trim() ||
        product.description?.trim() ||
        `Shop ${product.name} on WIEZ.`,
    );

    // Active sale price only counts while inside the sale window.
    const now = new Date();
    const saleActive =
      product.salePrice !== null &&
      (!product.saleStartAt || product.saleStartAt <= now) &&
      (!product.saleEndAt || product.saleEndAt >= now);
    const effectivePrice = saleActive ? product.salePrice : product.price;
    const imageUrl = product.thumbnail || getDefaultSeoImageUrl();

    const productPath = buildProductPath(product);
    const brandPath =
      product.brand?.owner?.username?.trim()
        ? buildBrandPath(product.brand.owner.username.trim())
        : null;

    const productNode: Record<string, unknown> = {
      '@type': 'Product',
      name: product.name,
      description,
      image: imageUrl,
      url: buildAbsoluteWebPath(productPath),
      itemCondition: 'https://schema.org/NewCondition',
      ...(product.sku?.trim() ? { sku: product.sku.trim() } : {}),
      ...(product.brand?.name
        ? { brand: { '@type': 'Brand', name: product.brand.name } }
        : {}),
      offers: {
        '@type': 'Offer',
        price: Number(effectivePrice),
        priceCurrency: product.currency || 'NGN',
        availability: 'https://schema.org/InStock',
        url: buildAbsoluteWebPath(productPath),
        itemCondition: 'https://schema.org/NewCondition',
        ...(product.brand?.name
          ? {
              seller: {
                '@type': 'Organization',
                name: product.brand.name,
              },
            }
          : {}),
      },
    };

    if (product.totalReviews > 0 && product.avgRating > 0) {
      productNode.aggregateRating = {
        '@type': 'AggregateRating',
        ratingValue: product.avgRating,
        reviewCount: product.totalReviews,
      };
    }

    const breadcrumbItems = [{ name: 'Market', path: '/market' }];
    if (brandPath && product.brand?.name) {
      breadcrumbItems.push({ name: product.brand.name, path: brandPath });
    }
    breadcrumbItems.push({ name: product.name, path: productPath });

    return this.buildMeta({
      canonicalPath: productPath,
      title,
      description,
      robots,
      imageUrl,
      ogType: 'product',
      extraMeta: [
        {
          attribute: 'property',
          key: 'product:price:amount',
          content: String(Number(effectivePrice)),
        },
        {
          attribute: 'property',
          key: 'product:price:currency',
          content: product.currency || 'NGN',
        },
      ],
      jsonLd: mergeJsonLdGraph(
        productNode,
        buildBreadcrumbJsonLd(breadcrumbItems),
      ),
    });
  }

  private async resolveDesignMeta(
    designId: string,
    robots: SeoPageMeta['robots'],
  ): Promise<SeoPageMeta> {
    const design = await this.prisma.collection.findFirst({
      where: {
        id: designId,
        domain: 'DESIGN',
        status: CollectionStatus.PUBLISHED,
        visibility: CollectionVisibility.PUBLIC,
        deletedAt: null,
      },
      select: {
        id: true,
        title: true,
        description: true,
        coverMedia: { select: { file: { select: { s3Url: true } } } },
        owner: { select: { username: true } },
      },
    });

    if (!design) {
      throw new NotFoundException('Design not found');
    }

    const title = `${design.title?.trim() || 'Design'}${MAX_TITLE_SUFFIX}`;
    const description = this.truncate(
      design.description?.trim() || 'Explore this design on WIEZ.',
    );

    const designPath = buildDesignPath(design.id);
    return this.buildMeta({
      canonicalPath: designPath,
      title,
      description,
      robots,
      imageUrl:
        design.coverMedia?.file?.s3Url || getDefaultSeoImageUrl(),
      ogType: 'article',
      jsonLd: mergeJsonLdGraph(
        {
          '@type': 'CreativeWork',
          name: design.title || 'Design',
          description,
          url: buildAbsoluteWebPath(designPath),
        },
        buildBreadcrumbJsonLd([
          { name: 'Market', path: '/market' },
          { name: design.title || 'Design', path: designPath },
        ]),
      ),
    });
  }

  private async resolveCollectionMeta(
    collectionId: string,
    robots: SeoPageMeta['robots'],
  ): Promise<SeoPageMeta> {
    const collection = await this.prisma.collection.findFirst({
      where: {
        id: collectionId,
        status: CollectionStatus.PUBLISHED,
        visibility: CollectionVisibility.PUBLIC,
        deletedAt: null,
      },
      select: {
        id: true,
        title: true,
        description: true,
        coverMedia: { select: { file: { select: { s3Url: true } } } },
      },
    });

    if (!collection) {
      throw new NotFoundException('Collection not found');
    }

    const title = `${collection.title?.trim() || 'Collection'}${MAX_TITLE_SUFFIX}`;
    const description = this.truncate(
      collection.description?.trim() || 'Explore this collection on WIEZ.',
    );

    return this.buildMeta({
      canonicalPath: buildCollectionPath(collection.id),
      title,
      description,
      robots,
      imageUrl:
        collection.coverMedia?.file?.s3Url || getDefaultSeoImageUrl(),
      ogType: 'article',
      jsonLd: {
        '@context': 'https://schema.org',
        '@type': 'CreativeWork',
        name: collection.title || 'Collection',
        description,
        url: buildAbsoluteWebPath(buildCollectionPath(collection.id)),
      },
    });
  }

  private async resolveProfileUsernameMeta(
    username: string,
    robots: SeoPageMeta['robots'],
  ): Promise<SeoPageMeta> {
    const profile = await this.userProfileService.resolvePublicProfileByUsername(
      username,
    );
    if (profile.type === UserType.BRAND && profile.username) {
      return this.resolveBrandMeta(profile.username, robots);
    }
    return this.buildProfileMeta(profile, robots);
  }

  private async resolveProfileIdMeta(
    userId: string,
    robots: SeoPageMeta['robots'],
  ): Promise<SeoPageMeta> {
    const profile = await this.userProfileService.getPublicProfile(userId);
    if (profile.type === UserType.BRAND && profile.username) {
      return this.resolveBrandMeta(profile.username, robots);
    }
    return this.buildProfileMeta(profile, robots);
  }

  private buildProfileMeta(
    profile: {
      id: string;
      username?: string | null;
      firstName?: string | null;
      lastName?: string | null;
      profileVisibility?: ProfileVisibility;
      bannerImage?: string;
      profileImage?: string;
    },
    robots: SeoPageMeta['robots'],
  ): SeoPageMeta {
    if (profile.profileVisibility === ProfileVisibility.LOCKED) {
      throw new NotFoundException('Profile not found');
    }

    const displayName = [profile.firstName, profile.lastName]
      .map((part) => String(part ?? '').trim())
      .filter(Boolean)
      .join(' ')
      .trim() || profile.username || 'Profile';

    const canonicalPath = buildProfilePath({
      id: profile.id,
      username: profile.username,
    });

    return this.buildMeta({
      canonicalPath,
      title: `${displayName}${MAX_TITLE_SUFFIX}`,
      description: `View ${displayName} on WIEZ.`,
      robots,
      imageUrl: profile.bannerImage || profile.profileImage || getDefaultSeoImageUrl(),
      ogType: 'profile',
      jsonLd: {
        '@context': 'https://schema.org',
        '@type': 'Person',
        name: displayName,
        url: buildAbsoluteWebPath(canonicalPath),
      },
    });
  }

  private buildMeta(input: {
    canonicalPath: string;
    title: string;
    description: string;
    robots: SeoPageMeta['robots'];
    imageUrl?: string;
    ogType?: string;
    jsonLd?: Record<string, unknown>;
    extraMeta?: SeoPageMeta['extraMeta'];
    httpStatus?: 200 | 404;
  }): SeoPageMeta {
    const canonicalUrl = buildAbsoluteWebPath(input.canonicalPath);
    const image = input.imageUrl || getDefaultSeoImageUrl();
    const title = input.title.trim();
    const description = this.truncate(input.description);

    return {
      canonicalUrl,
      title,
      description,
      robots: input.robots,
      httpStatus: input.httpStatus ?? 200,
      og: {
        title,
        description,
        image,
        type: input.ogType ?? 'website',
        url: canonicalUrl,
      },
      twitter: {
        card: image ? 'summary_large_image' : 'summary',
        title,
        description,
        image,
      },
      jsonLd: input.jsonLd,
      extraMeta: input.extraMeta,
    };
  }

  private truncate(value: string): string {
    const trimmed = value.trim();
    if (trimmed.length <= MAX_DESCRIPTION_LENGTH) {
      return trimmed;
    }
    return `${trimmed.slice(0, MAX_DESCRIPTION_LENGTH - 1).trimEnd()}…`;
  }

  private escapeHtml(value: string): string {
    return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  private escapeXml(value: string): string {
    return this.escapeHtml(value).replace(/'/g, '&apos;');
  }
}
