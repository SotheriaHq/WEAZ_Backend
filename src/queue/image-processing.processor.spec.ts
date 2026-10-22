import { ImageProcessingProcessor } from './image-processing.processor';
import { IMAGE_PROCESS_BATCH_JOB } from './queue.constants';

function build(overrides: { getObject?: jest.Mock; status?: string } = {}) {
  const file = {
    id: 'file-1', mimeType: 'image/jpeg', s3Key: 'POST_IMAGE/u/file-1.jpg',
    processingStatus: overrides.status ?? 'READY', assetVersion: 1,
    processingLeaseToken: null as string | null, processingLeaseUntil: null as Date | null,
  };
  const prisma = {
    fileUpload: {
      findUnique: jest.fn().mockResolvedValue(file),
      updateMany: jest.fn(async ({ where, data }: any) => {
        if (where.OR && file.processingLeaseUntil && file.processingLeaseUntil > new Date()) return { count: 0 };
        if (where.processingLeaseToken && where.processingLeaseToken !== file.processingLeaseToken) return { count: 0 };
        Object.assign(file, data); return { count: 1 };
      }),
      update: jest.fn().mockResolvedValue({}),
    },
    fileVariant: {
      upsert: jest.fn().mockResolvedValue({}),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  };
  (prisma as any).$queryRaw = jest.fn(async (_strings: any, _id: string, token: string) => file.processingLeaseToken === token ? [{ id: file.id }] : []);
  (prisma as any).$transaction = jest.fn(async (callback: any) => callback(prisma));
  (prisma as any).storageObjectDeletion = { createMany: jest.fn().mockResolvedValue({ count: 1 }) };
  const upload = {
    getObjectBufferByKey:
      overrides.getObject ?? jest.fn().mockResolvedValue(Buffer.from('img')),
    buildVariantS3Key: jest.fn(
      (p: {
        variantKind: string;
        fileId: string;
        assetVersion: number;
        ext: string;
      }) => `variant/${p.variantKind}/${p.fileId}/v${p.assetVersion}.${p.ext}`,
    ),
    putObjectBuffer: jest.fn().mockResolvedValue({ url: 'https://bucket/obj' }),
  };
  const media = {
    isSupportedImageMime: jest.fn().mockReturnValue(true),
    probeImage: jest
      .fn()
      .mockResolvedValue({
        width: 1440,
        height: 1920,
        hasAlpha: false,
        isAnimated: false,
      }),
    generateVariants: jest
      .fn()
      .mockResolvedValue([
        {
          kind: 'DETAIL',
          format: 'WEBP',
          width: 1440,
          height: 1920,
          quality: 80,
          buffer: Buffer.from('x'),
          ext: 'webp',
          mimeType: 'image/webp',
        },
      ]),
  };
  const iterator = jest.fn(async function* () {
    for (const variant of await media.generateVariants()) yield variant;
  });
  Object.assign(media, { generateVariantsIter: iterator });
  const processor = new ImageProcessingProcessor(
    prisma as any,
    upload as any,
    media as any,
  );
  const run = (data: Record<string, unknown>) =>
    processor.process({
      name: IMAGE_PROCESS_BATCH_JOB,
      data: { fileIds: ['file-1'], force: true, ...data },
    } as any);
  return { prisma: prisma as any, upload, media, file, run };
}

describe('ImageProcessingProcessor re-encode (newVersion)', () => {
  it('writes the next asset version, switches the file to it, then drops older variant rows', async () => {
    const { prisma, upload, run } = build();

    await run({ newVersion: true });

    expect(upload.putObjectBuffer).toHaveBeenCalledWith(
      expect.objectContaining({ key: expect.stringMatching(/^variant\/DETAIL\/file-1\/[0-9a-f-]+\/v2\.webp$/) }),
    );
    expect(prisma.fileVariant.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ assetVersion: 2 }),
      }),
    );
    expect(prisma.fileUpload.update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          assetVersion: 2,
          processingStatus: 'READY',
        }),
      }),
    );
    expect(prisma.fileVariant.deleteMany).toHaveBeenCalledWith({
      where: { fileUploadId: 'file-1', assetVersion: { lt: 2 } },
    });
  });

  it('keeps a working photo untouched when the re-encode fails, and does not throw', async () => {
    const { prisma, run } = build({
      getObject: jest.fn().mockRejectedValue(new Error('NoSuchKey')),
    });

    await expect(run({ newVersion: true })).resolves.toBeUndefined();

    expect(prisma.fileUpload.update).not.toHaveBeenCalled();
    expect(prisma.fileVariant.deleteMany).not.toHaveBeenCalled();
  });

  it('leaves the normal processing path on the current version', async () => {
    const { prisma, upload, run } = build({ status: 'PENDING' });

    await run({ force: false });

    expect(upload.putObjectBuffer).toHaveBeenCalledWith(
      expect.objectContaining({ key: expect.stringMatching(/^variant\/DETAIL\/file-1\/[0-9a-f-]+\/v1\.webp$/) }),
    );
    expect(prisma.fileVariant.deleteMany).not.toHaveBeenCalled();
    expect(prisma.fileUpload.update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ assetVersion: 1 }),
      }),
    );
  });
  it('serializes overlapping jobs for the same file without holding a transaction during encoding', async () => {
    const { prisma, upload, media, run } = build();
    const variants = await media.generateVariants();
    let finish!: (value: typeof variants) => void;
    media.generateVariants.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const first = run({});
    while (!finish) await new Promise((resolve) => setImmediate(resolve));
    expect(prisma.$transaction).not.toHaveBeenCalled();
    await run({});
    expect(upload.putObjectBuffer).not.toHaveBeenCalled();
    finish(variants);
    await first;
    expect(prisma.fileVariant.upsert).toHaveBeenCalledTimes(1);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it('rejects a stale publisher, keeps the working image and queues its unreferenced objects for cleanup', async () => {
    const { prisma, upload, file, run } = build();
    upload.putObjectBuffer.mockImplementationOnce(async () => {
      file.processingLeaseToken = 'newer-worker';
      return { url: 'https://bucket/new-attempt' };
    });
    await run({});
    expect(prisma.fileVariant.upsert).not.toHaveBeenCalled();
    expect(prisma.fileUpload.update).not.toHaveBeenCalled();
    expect(prisma.storageObjectDeletion.createMany).toHaveBeenCalledTimes(1);
    expect(file.processingLeaseToken).toBe('newer-worker');
    expect(file.processingStatus).toBe('READY');
  });

  it('gives forced READY reprocessing immutable new URLs even without the legacy newVersion flag', async () => {
    const { prisma, upload, run } = build();
    await run({});
    expect(prisma.fileUpload.update.mock.calls[0][0].data.assetVersion).toBe(2);
    expect(upload.putObjectBuffer.mock.calls[0][0].key).toMatch(/\/v2\.webp$/);
  });

});
