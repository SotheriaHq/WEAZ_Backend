import { CollectionSchedulerService } from './collection-scheduler.service';

describe('collection cleanup transaction and storage outbox', () => {
  let prisma: any;
  let uploads: any;
  let notifications: any;
  let service: CollectionSchedulerService;
  const cutoff = new Date('2026-10-21T00:00:00Z');

  beforeEach(() => {
    prisma = {
      $queryRaw: jest.fn(),
      $executeRaw: jest.fn().mockResolvedValue(2),
      collectionMedia: { deleteMany: jest.fn().mockResolvedValue({ count: 1 }) },
      fileUpload: { deleteMany: jest.fn().mockResolvedValue({ count: 1 }), findMany: jest.fn().mockResolvedValue([]) },
      fileVariant: { findMany: jest.fn().mockResolvedValue([]) },
      collection: { delete: jest.fn().mockResolvedValue({}), findMany: jest.fn() },
      storageObjectDeletion: {
        createMany: jest.fn().mockResolvedValue({ count: 2 }),
        deleteMany: jest.fn().mockResolvedValue({ count: 2 }),
        updateMany: jest.fn().mockResolvedValue({ count: 2 }),
      },
      $transaction: jest.fn(async (callback) => callback(prisma)),
    };
    uploads = { deleteS3ObjectsByKeys: jest.fn().mockResolvedValue(undefined) };
    notifications = { create: jest.fn().mockResolvedValue({}) };
    service = new CollectionSchedulerService(prisma, notifications, uploads, {} as any);
  });

  it.each(['DRAFT', 'SOFT'])('rechecks %s eligibility while locking; restored/edited/claimed rows cause no writes', async (mode) => {
    prisma.$queryRaw.mockResolvedValue([]);
    await expect((service as any).deleteExpiredCollection('id', mode, cutoff)).resolves.toBe(false);
    const sql = prisma.$queryRaw.mock.calls[0][0].text;
    expect(sql).toContain('FOR UPDATE SKIP LOCKED');
    expect(sql).toContain(mode === 'DRAFT' ? '"lastActivityAt"' : '"deleteExpiresAt"');
    expect(sql).toContain('LEFT JOIN "FileUpload"');
    expect(prisma.collection.delete).not.toHaveBeenCalled();
    expect(prisma.storageObjectDeletion.createMany).not.toHaveBeenCalled();
    expect(uploads.deleteS3ObjectsByKeys).not.toHaveBeenCalled();
  });

  it('queues only currently detached originals/variants without calling storage inside the transaction', async () => {
    prisma.$queryRaw
      .mockResolvedValueOnce([{ id: 'c', fileId: 'f', userId: 'owner' }])
      .mockResolvedValueOnce([{ id: 'f' }])
      .mockResolvedValueOnce([{ id: 'f', inUse: false, idle: true }]);
    await expect((service as any).deleteExpiredCollection('c', 'DRAFT', cutoff)).resolves.toBe(true);
    expect(prisma.fileUpload.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ['f'] } } });
    expect(prisma.$executeRaw.mock.calls[0][0].text).toContain('INSERT INTO "StorageObjectDeletion"');
    expect(prisma.$executeRaw.mock.calls[0][0].text).toContain('"FileVariant"');
    expect(prisma.$executeRaw.mock.calls[0][0].values).toEqual(['f', 'f']);
    expect(uploads.deleteS3ObjectsByKeys).not.toHaveBeenCalled();
  });

  it('does not touch S3 or send a deletion notice if database deletion fails', async () => {
    prisma.$queryRaw
      .mockResolvedValueOnce([{ id: 'c', fileId: 'shared', userId: 'owner' }])
      .mockResolvedValueOnce([{ id: 'shared' }])
      .mockResolvedValueOnce([{ id: 'shared', inUse: false, idle: true }]);
    prisma.fileUpload.deleteMany.mockRejectedValue(new Error('foreign key prevents shared-file deletion'));
    await expect((service as any).deleteExpiredCollection('c', 'DRAFT', cutoff)).rejects.toThrow('foreign key');
    expect(prisma.storageObjectDeletion.createMany).not.toHaveBeenCalled();
    expect(uploads.deleteS3ObjectsByKeys).not.toHaveBeenCalled();
    expect(notifications.create).not.toHaveBeenCalled();
    expect(prisma.collection.delete).not.toHaveBeenCalled();
  });

  it('expires the draft while retaining media still referenced by other content or verification evidence', async () => {
    prisma.$queryRaw
      .mockResolvedValueOnce([{ id: 'c', fileId: 'shared', userId: 'owner' }])
      .mockResolvedValueOnce([{ id: 'shared' }])
      .mockResolvedValueOnce([{ id: 'shared', inUse: true, idle: true }]);
    await expect((service as any).deleteExpiredCollection('c', 'DRAFT', cutoff)).resolves.toBe(true);
    expect(prisma.fileUpload.deleteMany).not.toHaveBeenCalled();
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
    expect(prisma.collection.delete).toHaveBeenCalledWith({ where: { id: 'c' } });
    expect(uploads.deleteS3ObjectsByKeys).not.toHaveBeenCalled();
  });

  it('uses one leased batch and two reference reads; keeps currently referenced files', async () => {
    prisma.$queryRaw.mockResolvedValue([{ s3Key: 'master', attempts: 0 }, { s3Key: 'still-used', attempts: 0 }]);
    prisma.fileVariant.findMany.mockResolvedValue([{ s3Key: 'still-used' }]);
    await service.dispatchStorageDeletions();
    expect(uploads.deleteS3ObjectsByKeys).toHaveBeenCalledWith(['master']);
    expect(prisma.fileUpload.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.fileVariant.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.storageObjectDeletion.deleteMany.mock.calls[0][0].where.leaseUntil).toBeInstanceOf(Date);
  });

  it('retains the durable work on partial S3 failure with backoff and a released lease', async () => {
    prisma.$queryRaw.mockResolvedValue([{ s3Key: 'master', attempts: 1 }]);
    uploads.deleteS3ObjectsByKeys.mockRejectedValue(new Error('partial S3 failure'));
    await service.dispatchStorageDeletions();
    expect(prisma.storageObjectDeletion.deleteMany).not.toHaveBeenCalled();
    const update = prisma.storageObjectDeletion.updateMany.mock.calls[0][0];
    expect(update.data.attempts).toEqual({ increment: 1 });
    expect(update.data.leaseUntil).toBeNull();
    expect(update.data.nextAttemptAt.getTime()).toBeGreaterThan(Date.now() + 50_000);
  });
});
