import { UserType } from '@prisma/client';

import { SeoService } from './seo.service';

describe('SeoService', () => {
  it('builds the sitemap with a Prisma-safe brand username filter', async () => {
    const prisma = {
      user: {
        findMany: jest.fn().mockResolvedValue([
          {
            username: 'wiez-brand',
            updatedAt: new Date('2026-07-06T10:00:00.000Z'),
          },
        ]),
      },
      product: { findMany: jest.fn().mockResolvedValue([]) },
      design: { findMany: jest.fn().mockResolvedValue([]) },
      collection: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const service = new SeoService(prisma as any, {} as any, {} as any);

    const xml = await service.buildSitemapXml();

    expect(prisma.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          type: UserType.BRAND,
          username: { not: '' },
        }),
      }),
    );
    expect(xml).toContain('http://localhost:3000/brand/wiez-brand');
  });
});
