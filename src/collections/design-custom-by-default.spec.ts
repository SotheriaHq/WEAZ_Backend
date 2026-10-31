import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BadRequestException } from '@nestjs/common';
import { CollectionSchedulerService } from './collection-scheduler.service';
import { CollectionsService } from './collections.service';
import {
  clearUploadIncomplete,
  designSizingFields,
  DRAFT_REASON_UPLOAD_INCOMPLETE,
} from './design-sizing';

describe('Designs are made to order', () => {
  it('writes the same sizing values on every design save', () => {
    expect(designSizingFields()).toEqual({
      sizingMode: 'CUSTOM',
      rtwSizes: [],
      rtwSizeSystem: null,
      rtwSizeType: null,
      customOrderEnabled: true,
    });
  });

  it('never reads a client sizing or custom-order choice on a design save', () => {
    const source = readFileSync(
      join(__dirname, 'collections.service.ts'),
      'utf8',
    );
    expect(source).not.toMatch(
      /(dto|metadata|completionMetadata)\.(sizingMode|rtwSizes|rtwSizeSystem|rtwSizeType)/,
    );
    expect(source).not.toMatch(
      /(metadata|completionMetadata)( as any\))?\.customOrderEnabled/,
    );
  });

  const publishCheck = (configuration: { id: string } | null) => {
    const service = Object.create(CollectionsService.prototype);
    const findFirst = jest.fn().mockResolvedValue(configuration);
    service.prisma = { customOrderConfiguration: { findFirst } };
    return {
      findFirst,
      run: () =>
        service.assertDesignCustomOrderPublishReady('design-1', 'owner-1'),
    };
  };

  it('refuses to publish a design with no custom-order setup', async () => {
    const check = publishCheck(null);
    await expect(check.run()).rejects.toBeInstanceOf(BadRequestException);
    expect(check.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          sourceId: 'design-1',
          isActive: true,
          brand: { ownerId: 'owner-1' },
        }),
      }),
    );
  });

  it('publishes once the custom-order setup is active', async () => {
    await expect(
      publishCheck({ id: 'config-1' }).run(),
    ).resolves.toBeUndefined();
  });
});

describe('Abandoned design uploads', () => {
  it('clears the marker only when the row was a failed upload', () => {
    expect(clearUploadIncomplete(DRAFT_REASON_UPLOAD_INCOMPLETE)).toEqual({
      draftReason: null,
    });
    expect(clearUploadIncomplete('USER_SAVED')).toEqual({});
    expect(clearUploadIncomplete(null)).toEqual({});
  });

  const sweep = (rows: { id: string }[]) => {
    const service = Object.create(CollectionSchedulerService.prototype);
    const findMany = jest.fn().mockResolvedValue(rows);
    service.prisma = { collection: { findMany } };
    service.config = { CLEANUP_BATCH_SIZE: 50 };
    service.logger = { log: jest.fn(), error: jest.fn() };
    service.deleteExpiredCollection = jest.fn();
    return { service, findMany };
  };

  it('only targets marked rows with no media, in one bounded query', async () => {
    const { service, findMany } = sweep([]);
    await service.deleteAbandonedUploadDrafts(new Date());
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: 'DRAFT',
          deletedAt: null,
          draftReason: DRAFT_REASON_UPLOAD_INCOMPLETE,
          medias: { none: {} },
        }),
        select: { id: true },
        take: 50,
      }),
    );
  });

  it('keeps a row a late save claimed first, and survives a failed delete', async () => {
    const { service } = sweep([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
    service.deleteExpiredCollection
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
      .mockRejectedValueOnce(new Error('lock timeout'));
    await expect(service.deleteAbandonedUploadDrafts(new Date())).resolves.toBe(
      1,
    );
    expect(service.logger.error).toHaveBeenCalledTimes(1);
  });
});
