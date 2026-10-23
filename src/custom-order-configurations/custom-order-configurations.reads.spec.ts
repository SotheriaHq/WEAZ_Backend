import { BadRequestException, NotFoundException } from '@nestjs/common';
import { CustomOrderSourceType, MeasurementPointSource } from '@prisma/client';
import { CustomOrderConfigurationsService } from './custom-order-configurations.service';

describe('Custom-order configuration bounded reads and explicit measurement contracts', () => {
  const broadKeys = [
    'MEN_CHEST',
    'MEN_WAIST',
    'MEN_HIP',
    'MEN_NECK',
    'MEN_HEIGHT',
    'WOMEN_WAIST',
    'WOMEN_HIP',
    'WOMEN_UNDERBUST',
    'WOMEN_CHEST_FULL_BUST',
  ];
  const configuration = (overrides: Record<string, unknown> = {}) => ({
    id: 'configuration',
    brandId: 'brand',
    sourceType: CustomOrderSourceType.PRODUCT,
    sourceId: 'source',
    isActive: true,
    brand: { ownerId: 'owner' },
    requiredMeasurementKeys: broadKeys,
    requiredFreeformPointIds: ['point'],
    ...overrides,
  });
  const point = (id = 'point', overrides: Record<string, unknown> = {}) => ({
    id,
    key: `BRAND_${id}`,
    label: 'BRAND_X_CUSTOM_LENGTH',
    description: null,
    minValueCm: 2,
    maxValueCm: 200,
    source: MeasurementPointSource.BRAND_FREEFORM,
    brandId: 'brand',
    ...overrides,
  });
  const setup = (items = [configuration()], publicSource = true) => {
    const prisma = {
      brand: { findUnique: jest.fn().mockResolvedValue({ id: 'brand' }) },
      customOrderConfiguration: {
        findMany: jest.fn().mockResolvedValue(items),
        count: jest.fn().mockResolvedValue(items.length),
        findUnique: jest.fn().mockResolvedValue(items[0]),
        findFirst: jest.fn().mockResolvedValue(items[0]),
      },
      product: {
        findFirst: jest
          .fn()
          .mockResolvedValue(publicSource ? { id: 'source' } : null),
        findUnique: jest.fn(),
      },
      collection: {
        findFirst: jest
          .fn()
          .mockResolvedValue(publicSource ? { id: 'source' } : null),
        findUnique: jest.fn(),
      },
      measurementPoint: { findMany: jest.fn().mockResolvedValue([point()]) },
      $transaction: jest.fn((queries: Promise<unknown>[]) =>
        Promise.all(queries),
      ),
    };
    const service = new CustomOrderConfigurationsService(
      prisma as any,
      {} as any,
    );
    return { service, prisma };
  };

  it.each([CustomOrderSourceType.PRODUCT, CustomOrderSourceType.DESIGN])(
    '%s public source: 100 configurations share one visibility read and one point query',
    async (sourceType) => {
      const items = Array.from({ length: 100 }, (_, i) =>
        configuration({ id: `config-${i}`, sourceType }),
      );
      const { service, prisma } = setup(items);
      const response = await service.listVisibleConfigurations(undefined, {
        sourceType,
        sourceId: 'source',
        limit: 100,
      });
      expect(response.data.items).toHaveLength(100);
      for (const item of response.data.items) {
        expect(item.requiredMeasurementKeys).toEqual(broadKeys);
        expect(item.resolvedRequiredMeasurementKeys).toEqual([
          ...broadKeys,
          'BRAND_POINT',
        ]);
        expect(item.requiredMeasurementPoints[0].label).toBe('CUSTOM LENGTH');
      }
      expect(prisma.measurementPoint.findMany).toHaveBeenCalledTimes(1);
      expect(
        prisma.measurementPoint.findMany.mock.calls[0][0].where.id.in,
      ).toEqual(['point']);
      expect(prisma.product.findFirst).toHaveBeenCalledTimes(
        sourceType === 'PRODUCT' ? 1 : 0,
      );
      expect(prisma.collection.findFirst).toHaveBeenCalledTimes(
        sourceType === 'DESIGN' ? 1 : 0,
      );
      expect(prisma.product.findUnique).not.toHaveBeenCalled();
      expect(prisma.collection.findUnique).not.toHaveBeenCalled();
    },
  );

  it.each([CustomOrderSourceType.PRODUCT, CustomOrderSourceType.DESIGN])(
    '%s private/draft source never exposes configuration or measurement metadata anonymously',
    async (sourceType) => {
      const { service, prisma } = setup([configuration({ sourceType })], false);
      const response = await service.listVisibleConfigurations(undefined, {
        sourceType,
        sourceId: 'source',
      });
      expect(response.data.items).toEqual([]);
      expect(response.data.total).toBe(0);
      expect(prisma.measurementPoint.findMany).not.toHaveBeenCalled();
      const where =
        sourceType === 'PRODUCT'
          ? prisma.product.findFirst.mock.calls[0][0].where
          : prisma.collection.findFirst.mock.calls[0][0].where;
      expect(where.deletedAt).toBeNull();
      if (sourceType === 'PRODUCT') {
        expect(where).toMatchObject({
          archivedAt: null,
          isActive: true,
          publicationStatus: 'PUBLISHED',
        });
        expect(where.OR).toEqual([
          { publishAt: null },
          { publishAt: { lte: expect.any(Date) } },
        ]);
      } else
        expect(where).toMatchObject({
          domain: 'DESIGN',
          status: 'PUBLISHED',
          visibility: 'PUBLIC',
        });
    },
  );

  it('own brand listing includes inactive configurations without public-source reads', async () => {
    const { service, prisma } = setup(
      [configuration({ isActive: false })],
      false,
    );
    const response = await service.listVisibleConfigurations('owner', {});
    expect(response.data.items).toHaveLength(1);
    expect(response.data.total).toBe(1);
    expect(
      prisma.customOrderConfiguration.findMany.mock.calls[0][0].where,
    ).toEqual({ brandId: 'brand' });
    expect(prisma.product.findFirst).not.toHaveBeenCalled();
    expect(prisma.collection.findFirst).not.toHaveBeenCalled();
  });

  it('public source filters inactive rows while owner brand scope honors explicit inactive selection', async () => {
    const { service, prisma } = setup([configuration({ isActive: false })]);
    expect(
      (
        await service.listVisibleConfigurations(undefined, {
          sourceType: 'PRODUCT',
          sourceId: 'source',
        })
      ).data.items,
    ).toEqual([]);
    expect(
      prisma.customOrderConfiguration.findMany.mock.calls[0][0].where.isActive,
    ).toBe(true);
    await service.listVisibleConfigurations('owner', { isActive: false });
    expect(
      prisma.customOrderConfiguration.findMany.mock.calls[1][0].where,
    ).toEqual({ brandId: 'brand', isActive: false });
  });

  it('rejects platform-wide and foreign-brand listings before any configuration fetch', async () => {
    const { service, prisma } = setup();
    await expect(
      service.listVisibleConfigurations(undefined, {}),
    ).rejects.toThrow(BadRequestException);
    await expect(
      service.listVisibleConfigurations('owner', { brandId: 'foreign' }),
    ).rejects.toThrow(BadRequestException);
    await expect(
      service.listVisibleConfigurations('owner', { sourceId: 'source' }),
    ).rejects.toThrow(BadRequestException);
    expect(prisma.customOrderConfiguration.findMany).not.toHaveBeenCalled();
  });

  it('empty and contracts without freeform points do not query the point registry', async () => {
    const { service, prisma } = setup([]);
    expect(
      (await service.listVisibleConfigurations('owner', {})).data.items,
    ).toEqual([]);
    prisma.customOrderConfiguration.findMany.mockResolvedValue([
      configuration({ requiredFreeformPointIds: [] }),
    ]);
    const response = await service.listVisibleConfigurations('owner', {});
    expect(response.data.items[0].resolvedRequiredMeasurementKeys).toEqual(
      broadKeys,
    );
    expect(prisma.measurementPoint.findMany).not.toHaveBeenCalled();
  });

  it('bounds metadata reads by unique IDs, preserves selected order, and excludes other brands points', async () => {
    const ids = Array.from({ length: 501 }, (_, i) => `point-${i}`);
    const { service, prisma } = setup([
      configuration({ requiredFreeformPointIds: [...ids, ids[0]] }),
    ]);
    prisma.measurementPoint.findMany.mockImplementation(
      async ({ where }: any) =>
        where.id.in
          .map((id: string) =>
            point(id, id === 'point-2' ? { brandId: 'foreign' } : {}),
          )
          .reverse(),
    );
    const response = await service.listVisibleConfigurations('owner', {});
    expect(prisma.measurementPoint.findMany).toHaveBeenCalledTimes(2);
    const result = response.data.items[0];
    expect(result.requiredFreeformPointIds).toEqual(ids);
    expect(result.requiredMeasurementPoints.map((entry) => entry.id)).toEqual(
      ids.filter((id) => id !== 'point-2'),
    );
    expect(result.requiredMeasurementKeys).toEqual(broadKeys);
  });

  it('get-by-id preserves owner access to inactive/private configurations and blocks other users', async () => {
    const { service, prisma } = setup(
      [configuration({ isActive: false })],
      false,
    );
    const response = await service.getConfiguration('configuration', 'owner');
    expect(response.data.requiredMeasurementKeys).toEqual(broadKeys);
    expect(prisma.product.findFirst).not.toHaveBeenCalled();
    await expect(
      service.getConfiguration('configuration', 'visitor'),
    ).rejects.toThrow(NotFoundException);
  });

  it.each([CustomOrderSourceType.PRODUCT, CustomOrderSourceType.DESIGN])(
    '%s active-source retrieval also preserves explicit measurements',
    async (sourceType) => {
      const { service, prisma } = setup([configuration({ sourceType })]);
      const response = await service.getActiveConfigurationForSource(
        sourceType,
        'source',
      );
      expect(response.data.requiredMeasurementKeys).toEqual(broadKeys);
      expect(prisma.measurementPoint.findMany).toHaveBeenCalledTimes(1);
      expect(prisma.product.findUnique).not.toHaveBeenCalled();
      expect(prisma.collection.findUnique).not.toHaveBeenCalled();
    },
  );

  it('keeps historical selected inactive points, allows system points, and ignores deleted point metadata', async () => {
    const { service, prisma } = setup([
      configuration({
        requiredFreeformPointIds: ['point', 'system', 'deleted'],
      }),
    ]);
    prisma.measurementPoint.findMany.mockResolvedValue([
      point('point', { isActive: false }),
      point('system', { source: MeasurementPointSource.SYSTEM, brandId: null }),
    ]);
    const response = await service.listVisibleConfigurations('owner', {});
    expect(
      response.data.items[0].requiredMeasurementPoints.map((entry) => entry.id),
    ).toEqual(['point', 'system']);
    expect(
      prisma.measurementPoint.findMany.mock.calls[0][0].where.isActive,
    ).toBeUndefined();
  });

  it('DESIGN writes reject a STORE-domain collection even when it is unavailable in store', async () => {
    const { service, prisma } = setup();
    prisma.collection.findFirst.mockImplementation(async ({ where }: any) =>
      where.domain === 'DESIGN' ? null : { id: 'store-collection' },
    );
    await expect(
      service.createConfiguration('owner', {
        sourceType: 'DESIGN',
        sourceId: 'store-collection',
        requiredMeasurementKeys: broadKeys,
      } as any),
    ).rejects.toThrow('Design source was not found for this brand');
    expect(prisma.collection.findFirst.mock.calls[0][0].where).toEqual({
      id: 'store-collection',
      ownerId: 'owner',
      domain: 'DESIGN',
    });
  });
});
