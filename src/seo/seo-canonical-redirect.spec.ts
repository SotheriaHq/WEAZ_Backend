import { describe, expect, it } from '@jest/globals';
import { UserType } from '@prisma/client';
import { resolveCanonicalRedirect } from './seo-canonical-redirect';

const PRODUCT_ID = '11111111-1111-4111-8111-111111111111';
const BRAND_USER_ID = '22222222-2222-4222-8222-222222222222';

describe('resolveCanonicalRedirect', () => {
  it('redirects legacy product IDs to slug URLs', async () => {
    const prisma = {
      product: {
        findFirst: jest.fn().mockResolvedValue({ slug: 'summer-dress' }),
      },
      user: { findUnique: jest.fn() },
    };

    const result = await resolveCanonicalRedirect(prisma as any, `/products/${PRODUCT_ID}`);

    expect(result).toEqual({
      location: `http://localhost:3000/p/summer-dress`,
      statusCode: 301,
    });
  });

  it('redirects brand profile IDs to storefront slugs', async () => {
    const prisma = {
      product: { findFirst: jest.fn() },
      user: {
        findUnique: jest.fn().mockResolvedValue({
          type: UserType.BRAND,
          username: 'acme',
        }),
      },
    };

    const result = await resolveCanonicalRedirect(prisma as any, `/profile/${BRAND_USER_ID}`);

    expect(result).toEqual({
      location: 'http://localhost:3000/brand/acme',
      statusCode: 301,
    });
  });

  it('ignores non-UUID legacy paths', async () => {
    const prisma = {
      product: { findFirst: jest.fn() },
      user: { findUnique: jest.fn() },
    };

    const result = await resolveCanonicalRedirect(prisma as any, '/products/publish_task_1');

    expect(result).toBeNull();
    expect(prisma.product.findFirst).not.toHaveBeenCalled();
  });
});