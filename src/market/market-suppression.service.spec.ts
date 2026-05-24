import { BadRequestException, NotFoundException } from '@nestjs/common';
import { MarketSignalTargetType, MarketSuppressionType } from '@prisma/client';
import { MarketSuppressionService } from './market-suppression.service';

describe('MarketSuppressionService', () => {
  const createPrisma = (overrides: Record<string, any> = {}) => ({
    userContentSuppression: {
      create: jest.fn().mockResolvedValue({ id: 'suppression_1' }),
      findMany: jest.fn().mockResolvedValue([]),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    ...overrides,
  });

  it('creates guest suppressions with anonymousSessionId', async () => {
    const prisma = createPrisma();
    const service = new MarketSuppressionService(prisma as any);

    await service.createSuppression(
      {
        anonymousSessionId: 'anon_1',
        targetType: MarketSignalTargetType.PRODUCT,
        targetId: 'product_1',
        suppressionType: MarketSuppressionType.NOT_INTERESTED,
        reason: 'market_section_card',
      },
      {},
    );

    expect(prisma.userContentSuppression.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: null,
        anonymousSessionId: 'anon_1',
        targetType: MarketSignalTargetType.PRODUCT,
        targetId: 'product_1',
        suppressionType: MarketSuppressionType.NOT_INTERESTED,
      }),
    });
  });

  it('rejects guest suppressions without anonymousSessionId', async () => {
    const service = new MarketSuppressionService(createPrisma() as any);

    await expect(
      service.createSuppression(
        {
          targetType: MarketSignalTargetType.PRODUCT,
          targetId: 'product_1',
          suppressionType: MarketSuppressionType.NOT_INTERESTED,
        },
        {},
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('builds a suppression scope for targets, brands, categories, and sections', async () => {
    const prisma = createPrisma({
      userContentSuppression: {
        create: jest.fn(),
        deleteMany: jest.fn(),
        findMany: jest.fn().mockResolvedValue([
          {
            targetType: MarketSignalTargetType.PRODUCT,
            targetId: 'product_1',
            brandId: null,
            categoryId: null,
            sectionKey: null,
            suggestionBlockKey: null,
            suppressionType: MarketSuppressionType.NOT_INTERESTED,
          },
          {
            targetType: MarketSignalTargetType.BRAND,
            targetId: 'brand_1',
            brandId: 'brand_1',
            categoryId: null,
            sectionKey: null,
            suggestionBlockKey: null,
            suppressionType: MarketSuppressionType.HIDE_BRAND,
          },
          {
            targetType: MarketSignalTargetType.SECTION,
            targetId: 'fresh-drops',
            brandId: null,
            categoryId: null,
            sectionKey: 'fresh-drops',
            suggestionBlockKey: null,
            suppressionType: MarketSuppressionType.HIDE_SECTION,
          },
        ]),
      },
    });
    const service = new MarketSuppressionService(prisma as any);

    const scope = await service.getSuppressionScope({ userId: 'user_1' });

    expect(scope.targetKeys.has('PRODUCT:product_1')).toBe(true);
    expect(scope.brandIds.has('brand_1')).toBe(true);
    expect(scope.sectionKeys.has('fresh-drops')).toBe(true);
  });

  it('deletes suppressions as a restore action', async () => {
    const prisma = createPrisma();
    const service = new MarketSuppressionService(prisma as any);

    await expect(
      service.deleteSuppression('suppression_1', { userId: 'user_1' }),
    ).resolves.toEqual({ deleted: true, id: 'suppression_1' });
    expect(prisma.userContentSuppression.deleteMany).toHaveBeenCalledWith({
      where: {
        id: 'suppression_1',
        OR: [{ userId: 'user_1' }],
      },
    });
  });

  it('returns a controlled error when restore cannot find the suppression', async () => {
    const prisma = createPrisma({
      userContentSuppression: {
        create: jest.fn(),
        findMany: jest.fn(),
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
    });
    const service = new MarketSuppressionService(prisma as any);

    await expect(
      service.deleteSuppression('missing', { userId: 'user_1' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
