import { BadRequestException } from '@nestjs/common';
import { CategoriesService } from './categories.service';

describe('CategoriesService entity filters', () => {
  const createService = (prisma: any) =>
    new CategoriesService(prisma, {} as any);

  it('accepts valid filter values and deduplicates assignments', async () => {
    const prisma = {
      filterValue: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'filter-style',
            slug: 'statement-bold',
            name: 'Statement / Bold',
            isActive: true,
            dimension: {
              id: 'dimension-style',
              slug: 'style',
              name: 'Style',
              isActive: true,
              appliesTo: ['PRODUCT'],
            },
          },
          {
            id: 'filter-fit',
            slug: 'regular',
            name: 'Regular',
            isActive: true,
            dimension: {
              id: 'dimension-fit',
              slug: 'fit',
              name: 'Fit',
              isActive: true,
              appliesTo: ['PRODUCT'],
            },
          },
        ]),
      },
      entityFilter: {
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
        createMany: jest.fn().mockResolvedValue({ count: 2 }),
      },
    };
    const service = createService(prisma);

    await expect(
      service.setEntityFilters('PRODUCT', 'product-1', [
        'filter-style',
        'filter-style',
        'filter-fit',
      ]),
    ).resolves.toEqual(['filter-style', 'filter-fit']);

    expect(prisma.entityFilter.deleteMany).toHaveBeenCalledWith({
      where: { entityType: 'PRODUCT', entityId: 'product-1' },
    });
    expect(prisma.entityFilter.createMany).toHaveBeenCalledWith({
      data: expect.arrayContaining([
        expect.objectContaining({
          filterValueId: 'filter-style',
          entityType: 'PRODUCT',
          entityId: 'product-1',
          productId: 'product-1',
        }),
        expect.objectContaining({
          filterValueId: 'filter-fit',
          entityType: 'PRODUCT',
          entityId: 'product-1',
          productId: 'product-1',
        }),
      ]),
    });
  });

  it('clears filters when an empty selection is submitted', async () => {
    const prisma = {
      filterValue: { findMany: jest.fn() },
      entityFilter: {
        deleteMany: jest.fn().mockResolvedValue({ count: 2 }),
        createMany: jest.fn(),
      },
    };
    const service = createService(prisma);

    await expect(
      service.setEntityFilters('DESIGN', 'design-1', []),
    ).resolves.toEqual([]);

    expect(prisma.filterValue.findMany).not.toHaveBeenCalled();
    expect(prisma.entityFilter.deleteMany).toHaveBeenCalledWith({
      where: { entityType: 'DESIGN', entityId: 'design-1' },
    });
    expect(prisma.entityFilter.createMany).not.toHaveBeenCalled();
  });

  it('rejects inactive filter values without clearing existing assignments', async () => {
    const prisma = {
      filterValue: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'filter-inactive',
            slug: 'old-value',
            name: 'Old value',
            isActive: false,
            dimension: {
              id: 'dimension-style',
              slug: 'style',
              name: 'Style',
              isActive: true,
              appliesTo: ['PRODUCT'],
            },
          },
        ]),
      },
      entityFilter: {
        deleteMany: jest.fn(),
        createMany: jest.fn(),
      },
    };
    const service = createService(prisma);

    await expect(
      service.setEntityFilters('PRODUCT', 'product-1', ['filter-inactive']),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(prisma.entityFilter.deleteMany).not.toHaveBeenCalled();
  });

  it('rejects filter values whose dimension does not apply to the entity type', async () => {
    const prisma = {
      filterValue: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'filter-product-only',
            slug: 'product-only',
            name: 'Product only',
            isActive: true,
            dimension: {
              id: 'dimension-fit',
              slug: 'fit',
              name: 'Fit',
              isActive: true,
              appliesTo: ['PRODUCT'],
            },
          },
        ]),
      },
      entityFilter: {
        deleteMany: jest.fn(),
        createMany: jest.fn(),
      },
    };
    const service = createService(prisma);

    await expect(
      service.setEntityFilters('DESIGN', 'design-1', ['filter-product-only']),
    ).rejects.toThrow('Some selected style details are invalid for this item type.');

    expect(prisma.entityFilter.deleteMany).not.toHaveBeenCalled();
  });

  it('rejects blocked audience/use-case terms as garment categories', async () => {
    const prisma = {
      collectionCategory: {
        findUnique: jest.fn(),
        create: jest.fn(),
      },
    };
    const service = createService(prisma);

    await expect(
      service.create({
        name: 'Women',
        description: 'Audience term',
        order: 0,
      }),
    ).rejects.toThrow('not garment category');

    expect(prisma.collectionCategory.create).not.toHaveBeenCalled();
  });

  it('allows valid item-based garment categories with descriptions', async () => {
    const prisma = {
      collectionCategory: {
        findFirst: jest.fn().mockResolvedValue(null),
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({
          id: 'category-1',
          slug: 'kaftans',
          name: 'Kaftans',
          description: 'Loose-fitting robe-style garments.',
          order: 4,
          isActive: true,
        }),
      },
      user: {
        findMany: jest.fn().mockResolvedValue([]),
      },
    };
    const service = createService(prisma);

    await expect(
      service.create({
        name: 'Kaftans',
        description: 'Loose-fitting robe-style garments.',
        order: 4,
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        slug: 'kaftans',
        name: 'Kaftans',
      }),
    );

    expect(prisma.collectionCategory.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          slug: 'kaftans',
          name: 'Kaftans',
          description: 'Loose-fitting robe-style garments.',
        }),
      }),
    );
  });
});
