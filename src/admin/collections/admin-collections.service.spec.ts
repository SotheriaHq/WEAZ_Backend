import { NotFoundException } from '@nestjs/common';
import { AdminCollectionsService } from './admin-collections.service';

jest.mock('../catalog-metadata.helper', () => ({
  emptyAdminCatalogFilterMetadata: jest.fn(() => ({})),
  loadAdminCatalogFilters: jest.fn(async () => new Map()),
}));

describe('AdminCollectionsService', () => {
  const buildPrisma = () =>
    ({
      storeCollection: {
        findMany: jest.fn(async () => []),
        findUnique: jest.fn(),
      },
      storeCollectionProduct: {
        findMany: jest.fn(async () => []),
      },
      orderItem: {
        groupBy: jest.fn(async () => []),
      },
      $transaction: jest.fn(),
    }) as any;

  it('list() excludes system-generated store buckets', async () => {
    const prisma = buildPrisma();
    const service = new AdminCollectionsService(prisma);

    await service.list({});

    expect(prisma.storeCollection.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          deletedAt: null,
          isSystemGenerated: false,
        }),
      }),
    );
  });

  it('moderate() refuses system-generated buckets without touching them', async () => {
    const prisma = buildPrisma();
    prisma.storeCollection.findUnique.mockResolvedValue({
      id: 'bucket-1',
      title: 'Store Products',
      ownerId: 'owner-1',
      status: 'PUBLISHED',
      isSystemGenerated: true,
    });
    const service = new AdminCollectionsService(prisma);

    await expect(
      service.moderate(
        'bucket-1',
        { action: 'HARD_DELETE' },
        'admin-1',
        { socket: {}, headers: {} } as any,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('moderate() still moderates real collections', async () => {
    const prisma = buildPrisma();
    prisma.storeCollection.findUnique.mockResolvedValue({
      id: 'col-1',
      title: 'Summer Drop',
      ownerId: 'owner-1',
      status: 'PUBLISHED',
      isSystemGenerated: false,
    });
    prisma.$transaction.mockImplementation(async (fn: any) =>
      fn({
        storeCollection: {
          update: jest.fn(async () => ({
            id: 'col-1',
            title: 'Summer Drop',
            status: 'ARCHIVED',
            updatedAt: new Date(),
          })),
        },
        adminAuditLog: { create: jest.fn(async () => ({})) },
      }),
    );
    const service = new AdminCollectionsService(prisma);

    const result = await service.moderate(
      'col-1',
      { action: 'UNPUBLISH' },
      'admin-1',
      { socket: {}, headers: {} } as any,
    );

    expect(result.status).toBe('ARCHIVED');
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });
});
