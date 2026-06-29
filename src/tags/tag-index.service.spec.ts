import { BadRequestException } from '@nestjs/common';
import { TagStatus } from '@prisma/client';

import { TagIndexService } from './tag-index.service';

describe('TagIndexService pending creator registration', () => {
  const actorId = '2d3f38ec-ff82-4d9f-a502-6b044847eb43';

  function setup(existing: any[] = []) {
    const tx = {
      tag: {
        upsert: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const prisma = {
      tag: {
        findMany: jest.fn().mockResolvedValue(existing),
      },
      tagBinding: {},
      $transaction: jest.fn(async (callback: (client: typeof tx) => unknown) =>
        callback(tx),
      ),
    };
    return {
      prisma,
      tx,
      service: new TagIndexService(prisma as any),
    };
  }

  it('creates normalized pending tags with creator attribution and no binding', async () => {
    const { service, prisma, tx } = setup();

    const result = await service.registerPendingCreatorTags(
      [' #Aso   Ebi!! ', 'aso-ebi', 'abcdefghijklmnopqrstuvwxMORE'],
      actorId,
    );

    expect(result).toEqual(['aso-ebi', 'abcdefghijklmnopqrstuvwx']);
    expect(tx.tag.upsert).toHaveBeenCalledTimes(2);
    expect(tx.tag.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { normalizedName: 'aso-ebi' },
        create: expect.objectContaining({
          normalizedName: 'aso-ebi',
          status: TagStatus.PENDING,
          createdById: actorId,
          usageCount: 0,
        }),
      }),
    );
    expect(tx.tag.updateMany).toHaveBeenCalledWith({
      where: {
        normalizedName: { in: result },
        status: TagStatus.PENDING,
        createdById: null,
      },
      data: { createdById: actorId },
    });
    expect((prisma.tagBinding as any).createMany).toBeUndefined();
  });

  it('attributes an existing unowned pending tag without recreating it', async () => {
    const { service, tx } = setup([
      {
        normalizedName: 'adire',
        status: TagStatus.PENDING,
        isBanned: false,
        createdById: null,
      },
    ]);

    await service.registerPendingCreatorTags(['Adire'], actorId);

    expect(tx.tag.upsert).not.toHaveBeenCalled();
    expect(tx.tag.updateMany).toHaveBeenCalledTimes(1);
  });

  it('preserves the first creator of an existing pending tag', async () => {
    const { service, prisma } = setup([
      {
        normalizedName: 'adire',
        status: TagStatus.PENDING,
        isBanned: false,
        createdById: '5de23ae7-5664-48f6-95b2-28f98b43e766',
      },
    ]);

    await service.registerPendingCreatorTags(['Adire'], actorId);

    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('rejects banned or rejected tags before design persistence', async () => {
    const { service, prisma } = setup([
      {
        normalizedName: 'blocked-tag',
        status: TagStatus.REJECTED,
        isBanned: true,
        createdById: null,
      },
    ]);

    await expect(
      service.registerPendingCreatorTags(['blocked tag'], actorId),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
