import { UserType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { normalizeSeoPath } from './seo.config';
import {
  buildAbsoluteWebPath,
  buildBrandPath,
  buildProductPath,
} from './seo-url.builder';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type CanonicalRedirectResult = {
  location: string;
  statusCode: 301;
};

export async function resolveCanonicalRedirect(
  prisma: PrismaService,
  rawPath?: string | null,
): Promise<CanonicalRedirectResult | null> {
  const pathname = normalizeSeoPath(rawPath);
  if (!pathname || pathname === '/') {
    return null;
  }

  const productMatch = pathname.match(/^\/products\/([^/]+)$/);
  if (productMatch?.[1] && productMatch[1] !== 'create') {
    const productId = decodeURIComponent(productMatch[1]);
    if (!UUID_PATTERN.test(productId)) {
      return null;
    }

    const product = await prisma.product.findFirst({
      where: { id: productId, deletedAt: null, slug: { not: null } },
      select: { slug: true },
    });

    if (product?.slug) {
      const canonicalPath = buildProductPath({ id: productId, slug: product.slug });
      if (canonicalPath !== pathname) {
        return {
          location: buildAbsoluteWebPath(canonicalPath),
          statusCode: 301,
        };
      }
    }
  }

  const profileMatch = pathname.match(/^\/profile\/([^/]+)$/);
  if (profileMatch?.[1]) {
    const userId = decodeURIComponent(profileMatch[1]);
    if (!UUID_PATTERN.test(userId)) {
      return null;
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { type: true, username: true },
    });

    if (user?.type === UserType.BRAND && user.username?.trim()) {
      const canonicalPath = buildBrandPath(user.username.trim());
      return {
        location: buildAbsoluteWebPath(canonicalPath),
        statusCode: 301,
      };
    }
  }

  return null;
}